// 队列与恢复：重复投递只产出一份结果、并发投递只有一方执行、进程在落库前中断后重来不产生重复版本。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { appendRevision, createDraft, createRun, createTopic } from "../backend/store/index.ts";
import { executePipelineJob, registerStageHandler } from "../backend/jobs/index.ts";
import type { PipelineJob } from "../contracts/jobs.ts";

after(closeDb);

let calls = 0;
let runSeq = 0;

beforeEach(() => {
  calls = 0;
});

/** 造一个 run，返回 job；input_hash 每个用例不同，互不干扰。 */
async function jobFor(stage: PipelineJob["stage"] = "draft"): Promise<PipelineJob> {
  runSeq += 1;
  const run = await createRun(sql, {
    business_date: "2026-11-05",
    mode: "manual",
    pipeline_version: `v1-${runSeq}`,
    input_hash: `sha256:${String(runSeq).padStart(64, "0")}`,
  });
  return {
    run_id: run.id,
    stage,
    draft_id: null,
    base_revision_id: null,
    input_hash: `sha256:${"a".repeat(60)}${String(runSeq).padStart(4, "0")}`,
    attempt: 1,
  };
}

async function seedDraftWithTopic(job: PipelineJob) {
  const topic = await createTopic(sql, {
    run_id: job.run_id,
    story_ids: [1],
    angle: "角度",
    reason: "",
    evidence_status: "sufficient",
    dedupe_key: `k-${job.run_id}`,
  });
  return createDraft(sql, topic.id);
}

const content = (suffix: string) => ({
  title: `标题${suffix}`,
  summary: "摘要",
  body: `正文${suffix}`,
  cover_asset_hash: null,
  captions: {},
  asset_hashes: [] as string[],
});

test("重复投递同一份任务只执行一次，第二次直接复用已存结果", async () => {
  const job = await jobFor();
  registerStageHandler("draft", async () => {
    calls += 1;
    return { output_ref: "waibu_revisions:1" };
  });

  assert.equal(await executePipelineJob(job), "executed");
  assert.equal(await executePipelineJob(job), "reused");
  assert.equal(calls, 1, "第二次投递不能再调用阶段实现");

  const steps = await sql`select status from waibu_steps where run_id = ${job.run_id} and stage = 'draft'`;
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.status, "succeeded");
});

test("并发投递同一份任务只有一方执行", async () => {
  const job = await jobFor();
  registerStageHandler("draft", async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { output_ref: "waibu_revisions:2" };
  });

  const outcomes = await Promise.allSettled([executePipelineJob(job), executePipelineJob(job)]);
  assert.equal(calls, 1, "同一输入只能跑一次");
  const fulfilled = outcomes.filter((o) => o.status === "fulfilled").map((o) => (o as PromiseFulfilledResult<string>).value);
  const rejected = outcomes.filter((o) => o.status === "rejected");
  assert.deepEqual(fulfilled, ["executed"]);
  assert.equal(rejected.length, 1, "另一份投递要退避，不能假装成功");
});

test("落库前中断：业务写入回滚，步骤记失败原因，重投后只产生一份结果", async () => {
  const job = await jobFor();
  const draft = await seedDraftWithTopic(job);
  const withDraft = { ...job, draft_id: draft.id };

  let first = true;
  registerStageHandler("draft", async ({ db }) => {
    calls += 1;
    // 先写版本，再模拟进程在提交前挂掉：外部调用失败，事务整体回滚。
    await appendRevision(db, {
      draft_id: draft.id,
      parent_id: null,
      content: content(String(calls)),
      policy_version: "p1",
      created_by: "model",
      expected_lock_version: draft.lock_version,
      next_state: "checking",
    });
    if (first) {
      first = false;
      throw new Error("model timeout");
    }
    return { output_ref: "waibu_revisions:3" };
  });

  await assert.rejects(() => executePipelineJob(withDraft), /model timeout/u);

  const afterCrash = await sql`select count(*)::int as n from waibu_revisions where draft_id = ${draft.id}`;
  assert.equal(afterCrash[0]!.n, 0, "崩溃时未提交的业务写入必须回滚");
  const failed = await sql`select status, error_code from waibu_steps where run_id = ${job.run_id} and status = 'failed'`;
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.error_code, "other", "失败原因要落库，便于排障（非模型故障归为 other）");

  assert.equal(await executePipelineJob(withDraft), "executed");
  const afterRetry = await sql`select count(*)::int as n from waibu_revisions where draft_id = ${draft.id}`;
  assert.equal(afterRetry[0]!.n, 1, "重投后只保留一份结果");
  const succeeded = await sql`select count(*)::int as n from waibu_steps where run_id = ${job.run_id} and status = 'succeeded'`;
  assert.equal(succeeded[0]!.n, 1);
});

test("进程崩溃留下的 running 步骤，下次执行时标为被中断而不是永远运行中", async () => {
  const job = await jobFor();
  // 模拟崩溃：留下一条 20 分钟前的 running 记录，已过执行窗口。
  await sql`
    insert into waibu_steps (run_id, stage, input_hash, attempt, status, updated_at)
    values (${job.run_id}, 'draft', ${job.input_hash}, 1, 'running', now() - interval '20 minutes')`;
  registerStageHandler("draft", async () => ({ output_ref: "waibu_revisions:4" }));

  assert.equal(await executePipelineJob(job), "executed");
  const rows = await sql`select attempt, status, error_code from waibu_steps where run_id = ${job.run_id} order by attempt`;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.status, "failed");
  assert.equal(rows[0]!.error_code, "attempt_interrupted");
  assert.equal(rows[1]!.status, "succeeded");
});

test("没有注册实现的阶段明确报错，不假装成功", async () => {
  const job = await jobFor("check");
  await assert.rejects(() => executePipelineJob(job), /还没有实现/u);
});
