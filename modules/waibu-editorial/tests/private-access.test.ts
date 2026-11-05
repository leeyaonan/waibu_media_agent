// AC-022：页面、API、附件与导出四个出口，未登录一律拒绝；写请求缺 CSRF 也拒绝。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { passwordLogin, SESSION_COOKIE } from "@aihot/backend/admin/auth";
import { registerEditorialRoutes } from "../backend/http-auth/routes.ts";
import { API_PREFIX } from "../contracts/api.ts";
import { createDraft, createRun, createTopic, getDraft } from "../backend/store/index.ts";
import { applyAuthorEdit } from "../backend/revisions/index.ts";
import { approveDraft } from "../backend/store/review.ts";
import { createExport, finishExport, upsertAsset } from "../backend/store/delivery.ts";
import { saveValidation } from "../backend/validate/store.ts";
import { assetHash } from "../backend/assets/index.ts";
import { VALIDATOR_VERSION, SPEC_COMMIT } from "../backend/validate/index.ts";

after(closeDb);

const PASSWORD = `priv-test-password-${Date.now()}`;
let app: ReturnType<typeof Fastify>;
let token = "";
let csrf = "";

before(async () => {
  config.adminPassword = PASSWORD;
  app = Fastify({ logger: false });
  registerEditorialRoutes(app);
  await app.ready();
  token = (await passwordLogin(PASSWORD, "/admin", "priv-test")).token;
  const [session] = await sql`select csrf_token from admin_sessions order by created_at desc limit 1`;
  csrf = String(session!.csrf_token);
});

const authed = () => ({ cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf });

async function seedWithAssetAndExport() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "waibu-priv-"));
  config.dataDir = dataDir;
  const tag = randomUUID().replace(/-/gu, "");
  const gif = Buffer.from("R0lGODlhAgADAIAAAP///wAAACH5BAEAAAAALAAAAAACAAIAAAICDAoAOw==", "base64");
  const hash = assetHash(gif);
  const rel = path.posix.join("assets", hash.slice(7, 9), `${hash.slice(7)}.bin`);
  await mkdir(path.dirname(path.join(dataDir, rel)), { recursive: true });
  await writeFile(path.join(dataDir, rel), gif);
  const asset = await upsertAsset(sql, { hash, path: rel, mime: "image/gif", width: 2, height: 3, origin: "author_upload", rights: "public" });

  const run = await createRun(sql, { business_date: "2026-11-06", mode: "manual", pipeline_version: `pv-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });
  const draft = await createDraft(sql, topic.id);
  const saved = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draft.id,
      expected_lock_version: draft.lock_version,
      base_revision_id: null,
      content: { title: "标题", summary: "", body: "正文。", cover_asset_hash: null, captions: {}, asset_hashes: [hash] },
      policy_version: "p1",
    }),
  );
  await sql`update waibu_drafts set state = 'in_review' where id = ${draft.id}`;
  const ready = (await getDraft(sql, draft.id))!;
  const approved = await sql.begin((tx) =>
    approveDraft(tx, { draft_id: draft.id, revision_id: saved.revision.id, expected_content_hash: saved.revision.content_hash, actor: "author", expected_lock_version: ready.lock_version }, { blockingIssues: 0, invalidEvidence: 0 }),
  );
  await saveValidation(sql, {
    revision_id: saved.revision.id,
    report: {
      validator: "verify-article-structure", version: VALIDATOR_VERSION, spec_commit: SPEC_COMMIT, status: "passed",
      raw: "{}", violations: [], duration_ms: 1, checked_at: new Date().toISOString(),
      local: { status: "passed", note: "" }, official: { status: "passed", note: "" }, wechat_backend: { status: "unverified", note: "" }, exit_code: 0,
    },
  });
  const exported = await sql.begin((tx) =>
    createExport(tx, { draft_id: draft.id, revision_id: saved.revision.id, approval_id: approved.approval.id, path: "exports/x", validator_version: "v1" }),
  );
  return { draftId: draft.id, assetId: asset.id, exportId: exported.id, dataDir };
}

test("附件下载：未登录 401，登录后可读", async () => {
  const seeded = await seedWithAssetAndExport();
  const anonymous = await app.inject({ method: "GET", url: `${API_PREFIX}/assets/${seeded.assetId}/content` });
  assert.equal(anonymous.statusCode, 401, "附件不能匿名下载");

  const authorized = await app.inject({ method: "GET", url: `${API_PREFIX}/assets/${seeded.assetId}/content`, headers: authed() });
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.headers["content-type"], "image/gif");
  assert.equal(authorized.headers["cache-control"], "private, no-store", "私人附件不允许进共享缓存");
});

test("导出包下载：未登录 401，且不暴露文件路径", async () => {
  const seeded = await seedWithAssetAndExport();
  const anonymous = await app.inject({ method: "GET", url: `${API_PREFIX}/exports/${seeded.exportId}/download` });
  assert.equal(anonymous.statusCode, 401);
  assert.ok(!anonymous.body.includes("exports/"), "未登录响应里不能带出服务器路径");
});

test("四个出口都拒绝匿名访问：页面、API、附件、导出", async () => {
  const seeded = await seedWithAssetAndExport();
  const endpoints = [
    `${API_PREFIX}/drafts`,
    `${API_PREFIX}/drafts/${seeded.draftId}`,
    `${API_PREFIX}/assets/${seeded.assetId}/content`,
    `${API_PREFIX}/exports/${seeded.exportId}/download`,
  ];
  for (const url of endpoints) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 401, `${url} 必须拒绝匿名访问`);
  }
});

test("写请求缺 CSRF 一律 403", async () => {
  const seeded = await seedWithAssetAndExport();
  const writes = [
    { url: `${API_PREFIX}/drafts/${seeded.draftId}/revisions`, payload: { title: "t", summary: "", body: "b", expected_revision_id: "00000000-0000-4000-8000-000000000000", expected_lock_version: 1 } },
    { url: `${API_PREFIX}/drafts/${seeded.draftId}/feedback`, payload: { text: "x", expected_revision_id: "00000000-0000-4000-8000-000000000000" } },
    { url: `${API_PREFIX}/assets`, payload: { data_base64: "AA==" } },
  ];
  for (const write of writes) {
    const response = await app.inject({ method: "POST", url: write.url, headers: { cookie: `${SESSION_COOKIE}=${token}` }, payload: write.payload });
    assert.equal(response.statusCode, 403, `${write.url} 缺 CSRF 必须拒绝`);
  }
});
