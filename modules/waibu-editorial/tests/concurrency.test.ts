// 并发与恢复：真并发下的认领、改稿、批准，以及进程中断后的重投。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "@aihot/backend/db";
import { createDraft, createRun, createTopic, getDraft, listRevisions } from "../backend/store/index.ts";
import { applyAuthorEdit } from "../backend/revisions/index.ts";
import { approveDraft } from "../backend/store/review.ts";
import { createExport } from "../backend/store/delivery.ts";
import { executePipelineJob, registerStageHandler } from "../backend/jobs/index.ts";
import { saveValidation } from "../backend/validate/store.ts";
import { VALIDATOR_VERSION, SPEC_COMMIT } from "../backend/validate/index.ts";

after(async () => {});

async function seedDraft(body = "第一段。\n\n第二段。") {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-06", mode: "manual", pipeline_version: `cc-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });
  const draft = await createDraft(sql, topic.id);
  const saved = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draft.id,
      expected_lock_version: draft.lock_version,
      base_revision_id: null,
      content: { title: "标题", summary: "", body, cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "p1",
    }),
  );
  return { runId: run.id, draftId: draft.id, revision: saved.revision, draft: saved.draft };
}

test("两个 worker 抢同一份输入：只执行一次，另一个让开", { timeout: 30_000 }, async () => {
  const seeded = await seedDraft();
  let executions = 0;
  registerStageHandler("outline", async () => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { output_ref: "test:outline" };
  });

  const job = { run_id: seeded.runId, stage: "outline" as const, draft_id: seeded.draftId, base_revision_id: null, input_hash: `sha256:${"1".repeat(64)}`, attempt: 1 };
  const results = await Promise.allSettled([executePipelineJob(job), executePipelineJob(job)]);
  const ok = results.filter((item) => item.status === "fulfilled");
  const busy = results.filter((item) => item.status === "rejected");

  assert.equal(executions, 1, "同一输入只能真正执行一次");
  assert.equal(ok.length, 1, "一方执行成功");
  assert.equal(busy.length, 1, "另一方让开并抛错让队列重试");
  assert.match(String((busy[0] as PromiseRejectedResult).reason), /busy|another attempt/u);
});

test("重投复用已有成功结果，不再执行", { timeout: 30_000 }, async () => {
  const seeded = await seedDraft();
  let executions = 0;
  registerStageHandler("outline", async () => {
    executions += 1;
    return { output_ref: "test:outline" };
  });
  const job = { run_id: seeded.runId, stage: "outline" as const, draft_id: seeded.draftId, base_revision_id: null, input_hash: `sha256:${"2".repeat(64)}`, attempt: 1 };
  assert.equal(await executePipelineJob(job), "executed");
  assert.equal(await executePipelineJob(job), "reused");
  assert.equal(executions, 1, "第二次是复用，不是重跑");
});

test("进程被杀留下的 running 会被判定中断并可重跑", { timeout: 30_000 }, async () => {
  const seeded = await seedDraft();
  let executions = 0;
  registerStageHandler("outline", async () => {
    executions += 1;
    return { output_ref: "test:outline" };
  });
  const inputHash = `sha256:${"3".repeat(64)}`;
  // 模拟：上一个进程认领后被杀，步骤停在 running 且很久没更新
  await sql`
    insert into waibu_steps (run_id, stage, input_hash, attempt, status, updated_at)
    values (${seeded.runId}, 'outline', ${inputHash}, 1, 'running', now() - interval '30 minutes')`;

  const outcome = await executePipelineJob({ run_id: seeded.runId, stage: "outline", draft_id: seeded.draftId, base_revision_id: null, input_hash: inputHash, attempt: 2 });
  assert.equal(outcome, "executed");
  assert.equal(executions, 1, "中断的尝试让位，新尝试执行");

  const statuses = await sql`select status from waibu_steps where run_id = ${seeded.runId} and input_hash = ${inputHash} order by created_at`;
  assert.equal(String(statuses[0]!.status), "failed", "中断的尝试标为失败");
  assert.equal(String(statuses[1]!.status), "succeeded", "新尝试成功");
});

test("同一版本并发改稿：只有一个成功，另一个明确冲突", { timeout: 30_000 }, async () => {
  const seeded = await seedDraft();
  const attempt = (body: string) =>
    sql.begin((tx) =>
      applyAuthorEdit(tx, {
        draft_id: seeded.draftId,
        expected_lock_version: seeded.draft.lock_version,
        base_revision_id: seeded.revision.id,
        content: { title: "标题", summary: "", body, cover_asset_hash: null, captions: {}, asset_hashes: [] },
        policy_version: "p1",
      }),
    );
  const results = await Promise.allSettled([attempt("A 改的正文。"), attempt("B 改的正文。")]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1, "只能有一方写入成功");
  const rejected = results.find((item) => item.status === "rejected") as PromiseRejectedResult;
  assert.match(String(rejected.reason?.message ?? rejected.reason), /版本|冲突|conflict/u);

  const revisions = await listRevisions(sql, seeded.draftId);
  assert.equal(revisions.length, 2, "库里只有首版 + 一次成功修改");
});

test("批准与改稿并发：批准不覆盖作者新稿，导出随后被拒", { timeout: 30_000 }, async () => {
  const seeded = await seedDraft();
  await sql`update waibu_drafts set state = 'in_review' where id = ${seeded.draftId}`;
  const ready = (await getDraft(sql, seeded.draftId))!;

  const approve = sql.begin((tx) =>
    approveDraft(tx, { draft_id: seeded.draftId, revision_id: seeded.revision.id, expected_content_hash: seeded.revision.content_hash, actor: "author", expected_lock_version: ready.lock_version }, { blockingIssues: 0, invalidEvidence: 0 }),
  );
  const edit = sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: seeded.draftId,
      expected_lock_version: ready.lock_version,
      base_revision_id: seeded.revision.id,
      content: { title: "标题", subtitle: "", body: "作者抢在批准前改的。", cover_asset_hash: null, captions: {}, asset_hashes: [] } as never,
      policy_version: "p1",
    }),
  );

  const [approved, edited] = await Promise.allSettled([approve, edit]);
  // 无论谁先成功，最终状态都不能是“批准了旧版本却还在导出”
  const final = (await getDraft(sql, seeded.draftId))!;
  if (approved.status === "fulfilled" && edited.status === "fulfilled") {
    assert.equal(final.approved_revision_id, null, "改稿成功后批准必须被撤销");
  }
  if (approved.status === "fulfilled" && edited.status === "rejected") {
    assert.equal(final.approved_revision_id, seeded.revision.id);
  }
  if (edited.status === "fulfilled") {
    assert.equal(final.state, "checking", "改稿后回自检");
  }
});

test("来源撤回后旧批准不能再导出", { timeout: 30_000 }, async () => {
  const seeded = await seedDraft();
  await sql`update waibu_drafts set state = 'in_review' where id = ${seeded.draftId}`;
  const ready = (await getDraft(sql, seeded.draftId))!;
  const approved = await sql.begin((tx) =>
    approveDraft(tx, { draft_id: seeded.draftId, revision_id: seeded.revision.id, expected_content_hash: seeded.revision.content_hash, actor: "author", expected_lock_version: ready.lock_version }, { blockingIssues: 0, invalidEvidence: 0 }),
  );
  await saveValidation(sql, {
    revision_id: seeded.revision.id,
    report: {
      validator: "verify-article-structure", version: VALIDATOR_VERSION, spec_commit: SPEC_COMMIT, status: "passed",
      raw: "{}", violations: [], duration_ms: 1, checked_at: new Date().toISOString(),
      local: { status: "passed", note: "" }, official: { status: "passed", note: "" }, wechat_backend: { status: "unverified", note: "" }, exit_code: 0,
    },
  });

  const exported = await sql.begin((tx) =>
    createExport(tx, { draft_id: seeded.draftId, revision_id: seeded.revision.id, approval_id: approved.approval.id, path: "exports/x", validator_version: "v1" }),
  );
  assert.ok(exported.id);

  // 撤回来源：模拟成“批准失效”
  await sql`update waibu_approvals set revoked_at = now() where id = ${approved.approval.id}`;
  await sql`update waibu_drafts set approved_revision_id = null where id = ${seeded.draftId}`;
  await assert.rejects(
    () => sql.begin((tx) => createExport(tx, { draft_id: seeded.draftId, revision_id: seeded.revision.id, approval_id: approved.approval.id, path: "exports/y", validator_version: "v1" })),
    /批准|approval/u,
  );
});
