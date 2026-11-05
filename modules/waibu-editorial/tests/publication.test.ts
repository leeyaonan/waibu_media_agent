// 手工发布登记：导出不等于发布、只认批准版本、勘误只追加。
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
import { createDraft, createRun, createTopic, getDraft } from "../backend/store/index.ts";
import { applyAuthorEdit } from "../backend/revisions/index.ts";
import { approveDraft } from "../backend/store/review.ts";
import { createExport, finishExport } from "../backend/store/delivery.ts";
import { saveValidation } from "../backend/validate/store.ts";
import { VALIDATOR_VERSION, SPEC_COMMIT } from "../backend/validate/index.ts";
import { assertWechatUrl, listErrata } from "../backend/publication/index.ts";

after(closeDb);

const PASSWORD = `pub-test-password-${Date.now()}`;
let app: ReturnType<typeof Fastify>;
let token = "";
let csrf = "";

before(async () => {
  config.adminPassword = PASSWORD;
  app = Fastify({ logger: false });
  registerEditorialRoutes(app);
  await app.ready();
  token = (await passwordLogin(PASSWORD, "/admin", "pub-test")).token;
  const [session] = await sql`select csrf_token from admin_sessions order by created_at desc limit 1`;
  csrf = String(session!.csrf_token);
});

const headers = () => ({ cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf });
const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: headers(), payload });
const get = (url: string) => app.inject({ method: "GET", url, headers: headers() });

function passedReport() {
  return {
    validator: "verify-article-structure",
    version: VALIDATOR_VERSION,
    spec_commit: SPEC_COMMIT,
    status: "passed" as const,
    raw: "{}",
    violations: [],
    duration_ms: 1,
    checked_at: new Date().toISOString(),
    local: { status: "passed", note: "" },
    official: { status: "passed", note: "" },
    wechat_backend: { status: "unverified", note: "" },
    exit_code: 0,
  };
}

async function seedExported() {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `pb-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });
  const draft = await createDraft(sql, topic.id);
  const saved = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draft.id,
      expected_lock_version: draft.lock_version,
      base_revision_id: null,
      content: { title: "已发布样本", summary: "摘要", body: "# 已发布样本\n\n正文。", cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "p1",
    }),
  );
  await sql`update waibu_drafts set state = 'in_review' where id = ${draft.id}`;
  const inReview = (await getDraft(sql, draft.id))!;
  const approved = await sql.begin((tx) =>
    approveDraft(tx, { draft_id: draft.id, revision_id: saved.revision.id, expected_content_hash: saved.revision.content_hash, actor: "author", expected_lock_version: inReview.lock_version }, { blockingIssues: 0, invalidEvidence: 0 }),
  );
  await saveValidation(sql, { revision_id: saved.revision.id, report: passedReport() });
  const exported = await sql.begin((tx) =>
    createExport(tx, { draft_id: draft.id, revision_id: saved.revision.id, approval_id: approved.approval.id, path: "exports/x", validator_version: "v1" }),
  );
  await sql.begin((tx) => finishExport(tx, exported.id, { status: "succeeded", manifest_hash: `sha256:${"c".repeat(64)}` }));
  const afterExport = (await getDraft(sql, draft.id))!;
  return { draftId: draft.id, revisionId: saved.revision.id, lockVersion: afterExport.lock_version };
}

test("导出后仍是 exported，作者登记才变 published", async () => {
  const seeded = await seedExported();
  assert.equal((await getDraft(sql, seeded.draftId))!.state, "exported", "导出不等于发布");

  const response = await post(`${API_PREFIX}/drafts/${seeded.draftId}/publications`, {
    expected_revision_id: seeded.revisionId,
    expected_lock_version: seeded.lockVersion,
    published_at: "2026-11-05T12:00:00.000Z",
    url: "https://mp.weixin.qq.com/s/abc123",
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal((await getDraft(sql, seeded.draftId))!.state, "published");
  const body = JSON.parse(response.body);
  assert.equal(body.publication.channel, "wechat_mp");
  assert.equal(body.publication.url, "https://mp.weixin.qq.com/s/abc123");
});

test("链接必须是公众号文章地址", async () => {
  assert.throws(() => assertWechatUrl("https://example.com/a"), /mp\.weixin\.qq\.com/u);
  assert.throws(() => assertWechatUrl("随便写"), /完整/u);
  assert.doesNotThrow(() => assertWechatUrl("https://mp.weixin.qq.com/s/xyz"));
});

test("非公众号链接登记被拒，状态不变", async () => {
  const seeded = await seedExported();
  const response = await post(`${API_PREFIX}/drafts/${seeded.draftId}/publications`, {
    expected_revision_id: seeded.revisionId,
    expected_lock_version: seeded.lockVersion,
    published_at: "2026-11-05T12:00:00.000Z",
    url: "https://example.com/fake",
  });
  assert.equal(response.statusCode, 400);
  assert.equal((await getDraft(sql, seeded.draftId))!.state, "exported");
});

test("版本号过期时拒绝登记", async () => {
  const seeded = await seedExported();
  const response = await post(`${API_PREFIX}/drafts/${seeded.draftId}/publications`, {
    expected_revision_id: seeded.revisionId,
    expected_lock_version: seeded.lockVersion - 1,
    published_at: "2026-11-05T12:00:00.000Z",
    url: "https://mp.weixin.qq.com/s/abc123",
  });
  assert.equal(response.statusCode, 409);
});

test("勘误只追加，不改原登记", async () => {
  const seeded = await seedExported();
  const registered = await post(`${API_PREFIX}/drafts/${seeded.draftId}/publications`, {
    expected_revision_id: seeded.revisionId,
    expected_lock_version: seeded.lockVersion,
    published_at: "2026-11-05T12:00:00.000Z",
    url: "https://mp.weixin.qq.com/s/abc123",
  });
  const publicationId = JSON.parse(registered.body).publication.id;

  const first = await post(`${API_PREFIX}/publications/${publicationId}/errata`, { note: "括号里的价格写错了，应为 20 美元。" });
  assert.equal(first.statusCode, 201);
  const second = await post(`${API_PREFIX}/publications/${publicationId}/errata`, { note: "补充：原文链接已更新。" });
  assert.equal(second.statusCode, 201);

  const errata = await listErrata(sql, publicationId);
  assert.equal(errata.length, 2, "勘误逐条保留");

  const [publication] = await sql`select url, published_at from waibu_publications where id = ${publicationId}`;
  assert.equal(publication!.url, "https://mp.weixin.qq.com/s/abc123", "原登记链接不能被改");
  assert.equal(new Date(publication!.published_at as string).toISOString(), "2026-11-05T12:00:00.000Z");

  const listed = await get(`${API_PREFIX}/drafts/${seeded.draftId}/publications`);
  assert.equal(listed.statusCode, 200);
  const body = JSON.parse(listed.body);
  assert.equal(body.items[0].errata.length, 2);
});

test("空勘误被拒绝", async () => {
  const seeded = await seedExported();
  const registered = await post(`${API_PREFIX}/drafts/${seeded.draftId}/publications`, {
    expected_revision_id: seeded.revisionId,
    expected_lock_version: seeded.lockVersion,
    published_at: "2026-11-05T12:00:00.000Z",
    url: "https://mp.weixin.qq.com/s/abc123",
  });
  const publicationId = JSON.parse(registered.body).publication.id;
  const empty = await post(`${API_PREFIX}/publications/${publicationId}/errata`, { note: "   " });
  assert.equal(empty.statusCode, 400);
});

test("后台手改的正文必须先导入成新版本，旧版本不能再登记", async () => {
  const seeded = await seedExported();
  const imported = await post(`${API_PREFIX}/drafts/${seeded.draftId}/import-external-edit`, {
    expected_lock_version: seeded.lockVersion,
    expected_revision_id: seeded.revisionId,
    title: "后台改过的标题",
    summary: "摘要",
    body: "# 后台改过的标题\n\n这是我在公众号后台手改后的正文。",
  });
  assert.equal(imported.statusCode, 201, imported.body);
  const importedBody = JSON.parse(imported.body);
  assert.notEqual(importedBody.revisionId, seeded.revisionId, "手改内容必须成为新版本");
  assert.equal(importedBody.draftState, "checking", "导入后回到自检");
  assert.match(importedBody.note, /重新审核/u);

  const approveGone = await sql`select revoked_at from waibu_approvals where revision_id = ${seeded.revisionId}`;
  assert.ok(approveGone.every((row) => row.revoked_at !== null), "导入新版本后旧批准作废");

  const stale = await post(`${API_PREFIX}/drafts/${seeded.draftId}/publications`, {
    expected_revision_id: seeded.revisionId,
    expected_lock_version: seeded.lockVersion,
    published_at: "2026-11-05T12:00:00.000Z",
    url: "https://mp.weixin.qq.com/s/abc123",
  });
  assert.notEqual(stale.statusCode, 201, "旧版本不能再登记发布");
});

test("登记需要 CSRF", async () => {
  const seeded = await seedExported();
  const response = await app.inject({
    method: "POST",
    url: `${API_PREFIX}/drafts/${seeded.draftId}/publications`,
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
    payload: { expected_revision_id: seeded.revisionId, expected_lock_version: seeded.lockVersion, published_at: "2026-11-05T12:00:00.000Z", url: "https://mp.weixin.qq.com/s/x" },
  });
  assert.equal(response.statusCode, 403);
});
