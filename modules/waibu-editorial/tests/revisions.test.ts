// 版本不可变与并发改稿：作者改了 v2 之后，针对 v1 的生成任务回来只能留成分支产物，
// 当前版本永远是作者最新的那一份。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@aihot/backend/db";
import { createDraft, createRun, createTopic, getDraft, listRevisions } from "../backend/store/index.ts";
import { applyAuthorEdit, applyGeneratedRevision, diffRevisions, isCurrent } from "../backend/revisions/index.ts";
import type { RevisionContent } from "../contracts/content.ts";

after(closeDb);

const content = (suffix: string, body = `正文${suffix}`): RevisionContent => ({
  title: `标题${suffix}`,
  summary: "摘要",
  body,
  cover_asset_hash: null,
  captions: {},
  asset_hashes: [],
});

async function seed() {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `rev-${tag}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });
  const draft = await createDraft(sql, topic.id);
  // 第一版直接落库并推进 current，作为后续用例的基准。
  const base = await sql.begin(async (tx) => {
    const [row] = await tx`
      insert into waibu_revisions (draft_id, title, summary, body, content_hash, policy_version, created_by)
      values (${draft.id}, ${"标题v1"}, ${""}, ${"正文v1"}, ${"sha256:" + "1".repeat(64)}, ${"p1"}, ${"model"}) returning *`;
    await tx`update waibu_drafts set current_revision_id = ${row!.id}, state = 'in_review', lock_version = lock_version + 1 where id = ${draft.id}`;
    return String(row!.id);
  });
  const current = (await getDraft(sql, draft.id))!;
  return { draft: current, base };
}

test("作者编辑产生新版本，当前指针跟着走", async () => {
  const { draft, base } = await seed();
  const edited = await sql.begin((tx) =>
    applyAuthorEdit(tx, { draft_id: draft.id, expected_lock_version: draft.lock_version, base_revision_id: base, content: content("v2", "正文v2 改过"), policy_version: "p1" }),
  );
  assert.equal(edited.draft.current_revision_id, edited.revision.id);
  assert.equal(edited.draft.state, "checking", "作者编辑后必须重新自检");
  assert.equal(isCurrent(edited.revision, edited.draft), true);
  assert.equal((await getDraft(sql, draft.id))!.current_revision_id, edited.revision.id);
});

test("针对旧版本的生成结果回来时只留成分支产物，current 仍是作者最新稿", async () => {
  const { draft, base } = await seed();
  const edited = await sql.begin((tx) =>
    applyAuthorEdit(tx, { draft_id: draft.id, expected_lock_version: draft.lock_version, base_revision_id: base, content: content("v2"), policy_version: "p1" }),
  );

  // 模型拿的是 v1 作基准，作者已经改到 v2
  const outcome = await sql.begin((tx) =>
    applyGeneratedRevision(tx, { draft_id: draft.id, base_revision_id: base, content: content("model"), policy_version: "p1" }),
  );
  assert.equal(outcome.kind, "conflict");
  if (outcome.kind !== "conflict") return;

  assert.equal(outcome.revision.parent_id, base, "产物挂在它的基准版本下");
  const after = (await getDraft(sql, draft.id))!;
  assert.equal(after.current_revision_id, edited.revision.id, "当前版本不能被旧任务覆盖");
  assert.equal(after.lock_version, edited.draft.lock_version, "冲突产物不推进锁版本");

  const revisions = await listRevisions(sql, draft.id);
  assert.equal(revisions.length, 3, "三份版本都在：v1、作者 v2、冲突产物");
  assert.ok(revisions.some((revision) => revision.title === "标题model"), "冲突产物要保存下来供审计");
});

test("基准版本仍是当前版本时，模型结果正常推进", async () => {
  const { draft, base } = await seed();
  const outcome = await sql.begin((tx) =>
    applyGeneratedRevision(tx, { draft_id: draft.id, base_revision_id: base, content: content("v2"), policy_version: "p1" }),
  );
  assert.equal(outcome.kind, "applied");
  if (outcome.kind !== "applied") return;
  assert.equal(outcome.draft.current_revision_id, outcome.revision.id);
  assert.equal(outcome.draft.current_revision_id === base, false);
});

test("并发改稿：用过期版本号写入被拒绝，不会出现两个 current", async () => {
  const { draft, base } = await seed();
  const stale = draft.lock_version;
  await sql.begin((tx) =>
    applyAuthorEdit(tx, { draft_id: draft.id, expected_lock_version: stale, base_revision_id: base, content: content("v2"), policy_version: "p1" }),
  );
  await assert.rejects(
    () => sql.begin((tx) => applyAuthorEdit(tx, { draft_id: draft.id, expected_lock_version: stale, base_revision_id: base, content: content("v3"), policy_version: "p1" })),
    /版本不一致/u,
  );
  const current = (await getDraft(sql, draft.id))!;
  const rows = await sql`select count(*)::int as n from waibu_revisions where draft_id = ${draft.id} and id = ${current.current_revision_id}`;
  assert.equal(rows[0]!.n, 1, "current 指向的版本必须唯一存在");
});

test("版本差异按段落给出，标题与正文改动都能定位", async () => {
  const before = { title: "旧标题", summary: "", body: "第一段\n\n第二段" };
  const after = { title: "新标题", summary: "", body: "第一段\n\n第二段改了" };
  const diff = diffRevisions(before, after);
  assert.equal(diff.title_changed, true);
  assert.equal(diff.body_changed, true);
  assert.deepEqual(diff.blocks, [{ index: 1, before: "第二段", after: "第二段改了" }]);
});
