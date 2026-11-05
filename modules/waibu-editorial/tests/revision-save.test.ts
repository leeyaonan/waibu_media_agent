// 手动编辑保存成新版本：旧批准作废、版本历史带差异、版本号过期拒绝。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { passwordLogin, SESSION_COOKIE } from "@aihot/backend/admin/auth";
import { registerEditorialRoutes } from "../backend/http-auth/routes.ts";
import { API_PREFIX } from "../contracts/api.ts";
import { createDraft, createRun, createTopic, getDraft, listApprovals, listRevisions } from "../backend/store/index.ts";
import { applyAuthorEdit } from "../backend/revisions/index.ts";
import { approveDraft } from "../backend/store/review.ts";

after(closeDb);

const PASSWORD = `revision-test-password-${Date.now()}`;
let app: ReturnType<typeof Fastify>;
let token = "";
let csrf = "";

before(async () => {
  config.adminPassword = PASSWORD;
  app = Fastify({ logger: false });
  registerEditorialRoutes(app);
  await app.ready();
  token = (await passwordLogin(PASSWORD, "/admin", "revision-test")).token;
  const [session] = await sql`select csrf_token from admin_sessions order by created_at desc limit 1`;
  csrf = String(session!.csrf_token);
});

const headers = () => ({ cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf });

async function seed(body = "第一段。\n\n第二段。") {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `sv-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });
  const draft = await createDraft(sql, topic.id);
  const saved = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draft.id,
      expected_lock_version: draft.lock_version,
      base_revision_id: null,
      content: { title: "原标题", summary: "原摘要", body, cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "p1",
    }),
  );
  return { draftId: draft.id, revision: saved.revision, draft: saved.draft };
}

test("保存手动编辑会生成新版本，并回到自检", async () => {
  const seeded = await seed();
  const response = await app.inject({
    method: "POST",
    url: `${API_PREFIX}/drafts/${seeded.draftId}/revisions`,
    headers: headers(),
    payload: { title: "新标题", summary: "新摘要", body: "改过的第一段。\n\n第二段。", expected_revision_id: seeded.revision.id, expected_lock_version: seeded.draft.lock_version },
  });
  assert.equal(response.statusCode, 201, response.body);
  const body = JSON.parse(response.body);
  assert.notEqual(body.revision.id, seeded.revision.id);
  assert.equal(body.revision.parent_id, seeded.revision.id);
  assert.equal(body.draft.state, "checking");
  assert.equal((await listRevisions(sql, seeded.draftId)).length, 2);
});

test("版本号过期时拒绝保存，不覆盖作者最新稿", async () => {
  const seeded = await seed();
  await app.inject({
    method: "POST",
    url: `${API_PREFIX}/drafts/${seeded.draftId}/revisions`,
    headers: headers(),
    payload: { title: "新标题", summary: "", body: "改过。", expected_revision_id: seeded.revision.id, expected_lock_version: seeded.draft.lock_version },
  });
  const stale = await app.inject({
    method: "POST",
    url: `${API_PREFIX}/drafts/${seeded.draftId}/revisions`,
    headers: headers(),
    payload: { title: "又被覆盖", summary: "", body: "第二次。", expected_revision_id: seeded.revision.id, expected_lock_version: seeded.draft.lock_version },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(JSON.parse(stale.body).code, "conflict_version");
  assert.equal((await listRevisions(sql, seeded.draftId)).length, 2, "冲突时不能多出版本");
});

test("保存后旧批准作废", async () => {
  const seeded = await seed();
  await sql`update waibu_drafts set state = 'in_review' where id = ${seeded.draftId}`;
  const fresh = (await getDraft(sql, seeded.draftId))!;
  await sql.begin((tx) =>
    approveDraft(tx, { draft_id: seeded.draftId, revision_id: seeded.revision.id, expected_content_hash: seeded.revision.content_hash, actor: "author", expected_lock_version: fresh.lock_version }, { blockingIssues: 0, invalidEvidence: 0 }),
  );

  const after = (await getDraft(sql, seeded.draftId))!;
  const response = await app.inject({
    method: "POST",
    url: `${API_PREFIX}/drafts/${seeded.draftId}/revisions`,
    headers: headers(),
    payload: { title: "补一句", summary: "", body: "第一段补了一句。\n\n第二段。", expected_revision_id: seeded.revision.id, expected_lock_version: after.lock_version },
  });
  assert.equal(response.statusCode, 201, response.body);
  const approvals = await listApprovals(sql, seeded.draftId);
  assert.ok(approvals.every((item) => item.revoked_at !== null), "改稿必须撤销批准");
  assert.equal((await getDraft(sql, seeded.draftId))!.approved_revision_id, null);
});

test("版本历史带差异，第一版没有可比的上一版", async () => {
  const seeded = await seed();
  await app.inject({
    method: "POST",
    url: `${API_PREFIX}/drafts/${seeded.draftId}/revisions`,
    headers: headers(),
    payload: { title: "原标题", summary: "原摘要", body: "第一段。\n\n第二段改了。", expected_revision_id: seeded.revision.id, expected_lock_version: seeded.draft.lock_version },
  });

  const response = await app.inject({ method: "GET", url: `${API_PREFIX}/drafts/${seeded.draftId}/revisions`, headers: headers() });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].is_current, true, "最新版在最前");
  assert.equal(body.items[0].diff.body_changed, true);
  assert.deepEqual(body.items[0].diff.blocks, [{ index: 1, before: "第二段。", after: "第二段改了。" }]);
  assert.equal(body.items[1].diff, null, "第一版没有上一版可比");
});

test("保存需要 CSRF，缺了返回 403", async () => {
  const seeded = await seed();
  const response = await app.inject({
    method: "POST",
    url: `${API_PREFIX}/drafts/${seeded.draftId}/revisions`,
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
    payload: { title: "t", summary: "", body: "b", expected_revision_id: seeded.revision.id, expected_lock_version: seeded.draft.lock_version },
  });
  assert.equal(response.statusCode, 403);
});
