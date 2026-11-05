// 作者材料：只收文本、按内容去重、手稿成为版本基线、没有材料时不许写“我实测”。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { passwordLogin, SESSION_COOKIE } from "@aihot/backend/admin/auth";
import { AUTHOR_FILE_LIMIT, guardFirstPersonExperience, hasAuthorMaterial, importAuthorManuscript, validateAuthorFile, type AuthorFile } from "../backend/author-input/index.ts";
import { createDraft, createRun, createTopic, listRevisions } from "../backend/store/index.ts";
import { registerEditorialRoutes } from "../backend/http-auth/routes.ts";
import { API_PREFIX } from "../contracts/api.ts";

after(closeDb);

const PASSWORD = `author-test-password-${Date.now()}`;
let app: ReturnType<typeof Fastify>;
let token = "";
let revisionId = "";

const file = (overrides: Partial<AuthorFile> = {}): AuthorFile => ({
  filename: "manuscript.md",
  mime: "text/markdown",
  bytes: new TextEncoder().encode("# 我的实测记录\n\n第一段内容。"),
  ...overrides,
});

async function seedDraft() {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `ai-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });
  return createDraft(sql, topic.id);
}

before(async () => {
  config.adminPassword = PASSWORD;
  app = Fastify({ logger: false });
  registerEditorialRoutes(app);
  await app.ready();
  token = (await passwordLogin(PASSWORD, "/admin", "author-test")).token;

  const draft = await seedDraft();
  const imported = await sql.begin((tx) =>
    importAuthorManuscript(tx, { draft_id: draft.id, expected_lock_version: draft.lock_version, filename: "note.md", text: "# 手稿\n\n正文", policy_version: "p1" }),
  );
  revisionId = imported.revisionId;
});

test("非法 MIME 与超限文件被拒绝", () => {
  assert.throws(() => validateAuthorFile(file({ mime: "image/png" })), /不支持的文件类型/u);
  assert.throws(() => validateAuthorFile(file({ mime: "application/pdf" })), /不支持的文件类型/u);
  assert.throws(() => validateAuthorFile(file({ bytes: new Uint8Array(AUTHOR_FILE_LIMIT + 1).fill(97) })), /上限/u);
  assert.throws(() => validateAuthorFile(file({ filename: "note.exe" })), /扩展名/u);
  assert.throws(() => validateAuthorFile(file({ bytes: new TextEncoder().encode("   ") })), /空的/u);
});

test("合法的 Markdown 能取出正文", () => {
  const text = validateAuthorFile(file());
  assert.match(text, /我的实测记录/u);
});

test("手稿导入成为新版本，标题取首行", async () => {
  const draft = await seedDraft();
  const text = validateAuthorFile(file());
  const imported = await sql.begin((tx) =>
    importAuthorManuscript(tx, { draft_id: draft.id, expected_lock_version: draft.lock_version, filename: "manuscript.md", text, policy_version: "p1" }),
  );
  assert.equal(imported.duplicate, false);
  const revisions = await listRevisions(sql, draft.id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]!.title, "我的实测记录");
  assert.equal(revisions[0]!.created_by, "author");
  assert.equal(await hasAuthorMaterial(sql, draft.id), true);
});

test("重复上传同一份材料不产生新版本", async () => {
  const draft = await seedDraft();
  const text = validateAuthorFile(file());
  const first = await sql.begin((tx) => importAuthorManuscript(tx, { draft_id: draft.id, expected_lock_version: draft.lock_version, filename: "a.md", text, policy_version: "p1" }));
  // 重复上传时版本号已过期，但同一份材料应当直接复用已有版本。
  const second = await sql.begin((tx) => importAuthorManuscript(tx, { draft_id: draft.id, expected_lock_version: draft.lock_version, filename: "b.md", text, policy_version: "p1" }));
  assert.equal(second.duplicate, true);
  assert.equal(second.revisionId, first.revisionId);
  assert.equal((await listRevisions(sql, draft.id)).length, 1, "同样的内容不堆版本");
});

test("没有作者材料时不能写第一人称亲历", async () => {
  const blocked = guardFirstPersonExperience("我实测了三天，一次就成功。", false);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.offending.length >= 2, "要指出具体是哪几句");

  assert.equal(guardFirstPersonExperience("我实测了三天。", true).allowed, true, "有材料就可以写");
  assert.equal(guardFirstPersonExperience("据官方公告，版本号是 v3。", false).allowed, true, "没有亲历表述时不受影响");
});

test("材料下载：未登录 401，登录后拿到纯文本", async () => {
  const denied = await app.inject({ method: "GET", url: `${API_PREFIX}/revisions/${revisionId}/download` });
  assert.equal(denied.statusCode, 401);

  const ok = await app.inject({ method: "GET", url: `${API_PREFIX}/revisions/${revisionId}/download`, headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.headers["content-type"] as string, /text\/markdown/u);
  assert.match(ok.body, /手稿/u);
  assert.equal(ok.headers["cache-control"], "no-store");
});

test("下载不存在的版本返回 404", async () => {
  const response = await app.inject({ method: "GET", url: `${API_PREFIX}/revisions/00000000-0000-4000-8000-000000000000/download`, headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(response.statusCode, 404);
});
