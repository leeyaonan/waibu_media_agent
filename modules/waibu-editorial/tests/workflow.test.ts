// 编排：提纲成功、写作失败时，恢复只跑写作及后续，不重跑已完成的阶段。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@aihot/backend/db";
import { ensureDailyRun, jobFor, planPending, planRun, planStages, refreshRunStatus } from "../backend/workflow/index.ts";
import { createRun, findRun, finishStep, listSteps, startStep } from "../backend/store/runs.ts";
import type { TaskState } from "../contracts/states.ts";

after(closeDb);

const planned = planStages({
  policy_version: "p1",
  prompt_version: "v1",
  model_config_hash: `sha256:${"a".repeat(64)}`,
  evidence_hashes: [`sha256:${"b".repeat(64)}`],
  base_revision_id: null,
  feedback_ids: [],
});

/** 用真实的阶段键造记录，保证与 planStages 算出来的一致。 */
const steps = (entries: Array<[string, TaskState]>) =>
  entries.map(([stage, status]) => ({
    stage: stage as never,
    input_hash: planned.find((item) => item.stage === stage)!.input_hash,
    status,
  }));

test("全部阶段都排出来时，pending 就是全部", () => {
  const plan = planPending(planned, []);
  assert.equal(plan.pending.length, 5);
  assert.equal(plan.done, false);
  assert.equal(plan.blocked_at, null);
});

test("提纲成功、写作失败：恢复只跑写作及后续", () => {
  const plan = planPending(planned, steps([["evidence", "succeeded"], ["outline", "succeeded"], ["draft", "failed"]]));
  assert.deepEqual(plan.pending.map((item) => item.stage), ["draft"], "先只补被卡住的那一步");
  assert.deepEqual(plan.remaining.map((item) => item.stage), ["draft", "check", "revise"], "剩下的都要跑，但不越级入队");
  assert.equal(plan.blocked_at, "draft");
});

test("预算暂停时从暂停处继续，不跳过它", () => {
  const plan = planPending(planned, steps([["evidence", "succeeded"], ["outline", "paused_budget"]]));
  assert.deepEqual(plan.pending.map((item) => item.stage), ["outline"], "从暂停处继续，不跳过");
  assert.deepEqual(plan.remaining.map((item) => item.stage), ["outline", "draft", "check", "revise"]);
  assert.equal(plan.blocked_at, "outline");
});

test("正在跑的阶段不重复入队", () => {
  const plan = planPending(planned, steps([["evidence", "succeeded"], ["outline", "running"]]));
  assert.deepEqual(plan.pending.map((item) => item.stage), ["draft", "check", "revise"]);
});

test("全部成功时 done 为真", () => {
  const plan = planPending(planned, steps(planned.map((item) => [item.stage, "succeeded"])));
  assert.equal(plan.done, true);
  assert.equal(plan.pending.length, 0);
});

test("同一份输入换策略就换键，旧成功记录不再覆盖新工作", () => {
  const next = planStages({
    policy_version: "p2",
    prompt_version: "v1",
    model_config_hash: `sha256:${"a".repeat(64)}`,
    evidence_hashes: [`sha256:${"b".repeat(64)}`],
    base_revision_id: null,
    feedback_ids: [],
  });
  assert.notEqual(next[2]!.input_hash, planned[2]!.input_hash, "规则版本变化后 draft 的键必须不同");
});

test("编排读库：按真实阶段记录算出下一步并推进 run 状态", async () => {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `wf-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });

  const first = await startStep(sql, { run_id: run.id, stage: "evidence", input_hash: planned[0]!.input_hash });
  await finishStep(sql, first.id, "succeeded", { output_ref: "waibu_evidence:1" });
  const second = await startStep(sql, { run_id: run.id, stage: "outline", input_hash: planned[1]!.input_hash });
  await finishStep(sql, second.id, "succeeded", { output_ref: "waibu_topics:1" });
  const third = await startStep(sql, { run_id: run.id, stage: "draft", input_hash: planned[2]!.input_hash });
  await finishStep(sql, third.id, "failed", { error_code: "provider_outage" });

  const plan = await planRun(sql, run.id, planned);
  assert.deepEqual(plan.pending.map((item) => item.stage), ["draft"]);
  assert.deepEqual(plan.remaining.map((item) => item.stage), ["draft", "check", "revise"]);

  const status = await refreshRunStatus(sql, run.id);
  assert.equal(status.status, "failed");
  // 库里只有已产生的阶段记录，没跑过的 check/revise 还没有行。
  assert.deepEqual(status.pending, ["draft"]);
  assert.equal((await findRun(sql, run.id))!.status, "failed");
  assert.equal((await listSteps(sql, run.id)).length, 3);
});

test("定时 run 同一个业务日只建一次", async () => {
  const first = await ensureDailyRun(sql, { business_date: "2026-11-04", mode: "scheduled", input_hash: `sha256:${"c".repeat(64)}` });
  const second = await ensureDailyRun(sql, { business_date: "2026-11-04", mode: "scheduled", input_hash: `sha256:${"d".repeat(64)}` });
  assert.equal(first.created, true);
  assert.equal(second.created, false, "重复触发不产生第二个 run");
  assert.equal(first.run!.id, second.run!.id);
});

test("任务载荷带齐阶段键与基准版本", () => {
  const job = jobFor(planned[2]!, { run_id: "00000000-0000-4000-8000-000000000000", draft_id: null, base_revision_id: null });
  assert.equal(job.stage, "draft");
  assert.equal(job.input_hash, planned[2]!.input_hash);
  assert.equal(job.attempt, 1);
});
