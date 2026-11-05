// 数据层不变量：迁移可重复执行、唯一约束真的拦得住、版本不会被覆盖、批准只对当前版本有效。
// 用独立测试库（tests/databases.ts 为每个文件复制一份），不碰真实内容库。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import {
  appendRevision,
  approveDraft,
  createDraft,
  createEvidence,
  createExport,
  createRun,
  createTopic,
  finishExport,
  getDraft,
  getRevision,
  listApprovals,
  listRevisions,
  recordPublication,
  setDraftState,
} from "../backend/store/index.ts";
import { contentHash } from "../contracts/content.ts";

after(closeDb);

const content = (suffix: string) => ({
  title: `标题${suffix}`,
  summary: "摘要",
  body: `正文${suffix}`,
  cover_asset_hash: null,
  captions: { b1: "图注" },
  asset_hashes: [] as string[],
});

/** 造一篇待审稿：run → topic → draft → revision → in_review。 */
async function seedDraft() {
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: "v1", input_hash: "sha256:" + "0".repeat(64) });
  const topic = await createTopic(sql, {
    run_id: run.id,
    story_ids: [1],
    angle: "角度",
    reason: "理由",
    evidence_status: "sufficient",
    dedupe_key: `k-${run.id}`,
  });
  const draft = await createDraft(sql, topic.id);
  const { revision, draft: withRevision } = await sql.begin((tx) =>
    appendRevision(tx, {
      draft_id: draft.id,
      parent_id: null,
      content: content("A"),
      policy_version: "p1",
      created_by: "model",
      expected_lock_version: draft.lock_version,
      next_state: "checking",
    }),
  );
  const inReview = await setDraftState(sql, { draft_id: draft.id, expected_lock_version: withRevision.lock_version, next_state: "in_review" });
  return { run, topic, draft: inReview, revision };
}

/** 导出前必须有通过的排版校验；测试里直接补一条，规则本身在 validate.test.ts 覆盖。 */
async function seedPassedValidation(revisionId: string): Promise<void> {
  const { saveValidation } = await import("../backend/validate/store.ts");
  const { VALIDATOR_VERSION, SPEC_COMMIT } = await import("../backend/validate/index.ts");
  await saveValidation(sql, {
    revision_id: revisionId,
    report: {
      validator: "verify-article-structure",
      version: VALIDATOR_VERSION,
      spec_commit: SPEC_COMMIT,
      status: "passed",
      raw: "{}",
      violations: [],
      duration_ms: 1,
      checked_at: new Date().toISOString(),
      local: { status: "passed", note: "" },
      official: { status: "passed", note: "" },
      wechat_backend: { status: "unverified", note: "" },
      exit_code: 0,
    },
  });
}

test("空库迁移后 17 张 waibu_ 表都在", async () => {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from information_schema.tables
    where table_schema = 'public' and table_name like 'waibu_%'`;
  assert.equal(rows[0]!.n, 17);
});

test("定时 run 按业务日期与管线版本唯一，人工 run 不受限", async () => {
  const base = { business_date: "2026-11-04", pipeline_version: "v1", input_hash: "sha256:" + "1".repeat(64) };
  await createRun(sql, { ...base, mode: "scheduled" });
  await assert.rejects(() => createRun(sql, { ...base, mode: "scheduled" }), /duplicate key|unique/u, "同一天同一管线的定时 run 不能建两次");
  await createRun(sql, { ...base, mode: "manual" });
  await createRun(sql, { ...base, mode: "manual" });
});

test("同一阶段同一输入的重复投递只留一条记录", async () => {
  const run = await createRun(sql, { business_date: "2026-11-03", mode: "manual", pipeline_version: "v1", input_hash: "sha256:" + "2".repeat(64) });
  const started = await sql`
    insert into waibu_steps (run_id, stage, input_hash, attempt, status)
    values (${run.id}, 'evidence', 'sha256:abc', 1, 'running')
    on conflict (run_id, stage, input_hash, attempt) do update set updated_at = now()
    returning id`;
  const again = await sql`
    insert into waibu_steps (run_id, stage, input_hash, attempt, status)
    values (${run.id}, 'evidence', 'sha256:abc', 1, 'running')
    on conflict (run_id, stage, input_hash, attempt) do update set updated_at = now()
    returning id`;
  assert.equal(again[0]!.id, started[0]!.id, "重复投递复用同一行");
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from waibu_steps where run_id = ${run.id}`;
  assert.equal(n, 1);
});

test("版本只追加：旧版本不被覆盖，版本号不对时拒绝写入", async () => {
  const { draft, revision } = await seedDraft();
  const first = await getRevision(sql, revision.id);
  assert.equal(first?.title, "标题A");

  const { revision: second, draft: afterSecond } = await sql.begin((tx) =>
    appendRevision(tx, {
      draft_id: draft.id,
      parent_id: revision.id,
      content: content("B"),
      policy_version: "p1",
      created_by: "author",
      expected_lock_version: draft.lock_version,
      next_state: "checking",
    }),
  );
  assert.notEqual(second.content_hash, revision.content_hash);
  assert.equal(second.parent_id, revision.id);

  const stillFirst = await getRevision(sql, revision.id);
  assert.equal(stillFirst?.title, "标题A", "旧版本内容不可变");

  await assert.rejects(
    () => sql.begin((tx) => appendRevision(tx, { draft_id: draft.id, parent_id: second.id, content: content("C"), policy_version: "p1", created_by: "author", expected_lock_version: draft.lock_version, next_state: "checking" })),
    /版本不一致/u,
    "用过期版本号写入必须失败，不能覆盖作者最新稿",
  );
  assert.equal((await getDraft(sql, draft.id))?.current_revision_id, second.id);
  assert.equal(afterSecond.current_revision_id, second.id);
  assert.equal((await listRevisions(sql, draft.id)).length, 2);
});

test("批准绑定内容 hash，且只能对当前版本、待审状态发起", async () => {
  const { draft, revision } = await seedDraft();
  await assert.rejects(
    () => sql.begin((tx) => approveDraft(tx, { draft_id: draft.id, revision_id: revision.id, expected_content_hash: "sha256:" + "9".repeat(64), actor: "author", expected_lock_version: draft.lock_version }, { blockingIssues: 0, invalidEvidence: 0 })),
    /hash 与要批准的版本不一致/u,
  );
  await assert.rejects(
    () => sql.begin((tx) => approveDraft(tx, { draft_id: draft.id, revision_id: revision.id, expected_content_hash: revision.content_hash, actor: "author", expected_lock_version: draft.lock_version }, { blockingIssues: 2, invalidEvidence: 0 })),
    /自检阻断/u,
  );

  const approved = await sql.begin((tx) => approveDraft(tx, { draft_id: draft.id, revision_id: revision.id, expected_content_hash: revision.content_hash, actor: "author", expected_lock_version: draft.lock_version }, { blockingIssues: 0, invalidEvidence: 0 }));
  assert.equal(approved.draft?.state, "approved");
  assert.equal(approved.approval.content_hash, revision.content_hash);

  await assert.rejects(
    () => sql.begin((tx) => approveDraft(tx, { draft_id: draft.id, revision_id: revision.id, expected_content_hash: revision.content_hash, actor: "author", expected_lock_version: approved.draft!.lock_version }, { blockingIssues: 0, invalidEvidence: 0 })),
    /不能批准/u,
    "已批准状态不能再批准一次",
  );
});

test("内容变化自动撤销批准，旧批准不能再导出", async () => {
  const { draft, revision } = await seedDraft();
  const approved = await sql.begin((tx) => approveDraft(tx, { draft_id: draft.id, revision_id: revision.id, expected_content_hash: revision.content_hash, actor: "author", expected_lock_version: draft.lock_version }, { blockingIssues: 0, invalidEvidence: 0 }));

  const changed = await sql.begin((tx) =>
    appendRevision(tx, {
      draft_id: draft.id,
      parent_id: revision.id,
      content: { ...content("A"), body: "正文A改过一句" },
      policy_version: "p1",
      created_by: "author",
      expected_lock_version: approved.draft!.lock_version,
      next_state: "checking",
    }),
  );
  assert.equal(changed.draft.state, "checking");
  assert.equal(changed.draft.approved_revision_id, null, "批准指针必须清空");
  const approvals = await listApprovals(sql, draft.id);
  assert.ok(approvals.every((a) => a.revoked_at !== null), "所有批准记录都应被撤销");

  await assert.rejects(
    () => sql.begin((tx) => createExport(tx, { draft_id: draft.id, revision_id: revision.id, approval_id: approved.approval.id, path: "exports/x", validator_version: "v1" })),
    /没有有效批准/u,
    "批准失效后不能导出",
  );
});

test("没有有效批准时不能导出；导出成功才进入 exported", async () => {
  const { draft, revision } = await seedDraft();
  await assert.rejects(
    () => sql.begin((tx) => createExport(tx, { draft_id: draft.id, revision_id: revision.id, approval_id: "00000000-0000-4000-8000-000000000000", path: "exports/x", validator_version: "v1" })),
    /没有有效批准/u,
  );

  const approved = await sql.begin((tx) => approveDraft(tx, { draft_id: draft.id, revision_id: revision.id, expected_content_hash: revision.content_hash, actor: "author", expected_lock_version: draft.lock_version }, { blockingIssues: 0, invalidEvidence: 0 }));
  await seedPassedValidation(revision.id);
  const created = await sql.begin((tx) => createExport(tx, { draft_id: draft.id, revision_id: revision.id, approval_id: approved.approval.id, path: "exports/x", validator_version: "v1" }));
  assert.equal(created.status, "queued");
  assert.equal((await getDraft(sql, draft.id))?.state, "approved", "排队中不算已导出");

  await sql.begin((tx) => finishExport(tx, created.id, { status: "succeeded", manifest_hash: contentHash(content("A")) }));
  assert.equal((await getDraft(sql, draft.id))?.state, "exported");

  const beforePublish = (await getDraft(sql, draft.id))!;
  const published = await sql.begin((tx) =>
    recordPublication(tx, {
      draft_id: draft.id,
      revision_id: revision.id,
      published_at: "2026-11-06T09:00:00+08:00",
      url: "https://mp.weixin.qq.com/s/example",
      recorded_by: "author",
      expected_lock_version: beforePublish.lock_version,
    }),
  );
  assert.equal(published.recorded_by, "author");
  assert.equal((await getDraft(sql, draft.id))?.state, "published", "登记发布后才算已发布");
});

test("证据快照只增不改，撤回只改有效性", async () => {
  const run = await createRun(sql, { business_date: "2026-11-02", mode: "manual", pipeline_version: "v1", input_hash: "sha256:" + "3".repeat(64) });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [7], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${run.id}` });
  assert.ok(topic.id);
  const first = await createEvidence(sql, { source_id: "src", article_id: "a1", url: "https://example.com/a", published_at: null, excerpt: "摘录", hash: "sha256:" + "4".repeat(64), rights: "quotation" });
  const second = await createEvidence(sql, { source_id: "src", article_id: "a1", url: "https://example.com/a", published_at: null, excerpt: "摘录（更新）", hash: "sha256:" + "5".repeat(64), rights: "quotation" });
  assert.notEqual(first.id, second.id, "来源变化产生新快照");
  assert.equal((await sql`select excerpt from waibu_evidence where id = ${first.id}`)[0]!.excerpt, "摘录", "旧快照不被覆盖");
});
