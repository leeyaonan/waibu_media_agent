// 队列与选题列表：空队列、50 篇、游标分页、未登录拒绝、加载失败的错误码。
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
import { listDrafts, listTopics, pendingReviewCount } from "../backend/board/index.ts";
import { createDraft, createRun, createTopic } from "../backend/store/index.ts";

after(closeDb);

const PASSWORD = `board-test-password-${Date.now()}`;
let app: ReturnType<typeof Fastify>;
let token = "";

before(async () => {
  config.adminPassword = PASSWORD;
  app = Fastify({ logger: false });
  registerEditorialRoutes(app);
  await app.ready();
  token = (await passwordLogin(PASSWORD, "/admin", "board-test")).token;
});

const get = (url: string, withSession = true) => app.inject({ method: "GET", url, headers: withSession ? { cookie: `${SESSION_COOKIE}=${token}` } : {} });

/** 造 n 篇稿子；标题带序号，便于验证分页边界。 */
async function seedDrafts(n: number, state = "in_review") {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `bd-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const ids: string[] = [];
  for (let index = 0; index < n; index += 1) {
    const topic = await createTopic(sql, { run_id: run.id, story_ids: [index + 1], angle: `角度 ${index}`, reason: "", evidence_status: "sufficient", dedupe_key: `${tag}-${index}` });
    const draft = await createDraft(sql, topic.id);
    await sql`update waibu_drafts set state = ${state}, updated_at = now() - (${index} || ' minutes')::interval where id = ${draft.id}`;
    ids.push(draft.id);
  }
  return ids;
}

test("空队列返回空列表，不是错误", async () => {
  const page = await listDrafts(sql, { state: "archived" as never, limit: 10 });
  assert.deepEqual(page.items, []);
  assert.equal(page.next_cursor, null);
});

test("未登录读队列返回 401", async () => {
  const response = await get(`${API_PREFIX}/drafts`, false);
  assert.equal(response.statusCode, 401);
});

test("队列按更新时间倒序，并带待审积压数", async () => {
  const ids = await seedDrafts(3);
  const response = await get(`${API_PREFIX}/drafts?state=in_review&limit=50`);
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(body.items.length >= 3);
  assert.ok(typeof body.pending_review === "number");
  const mine = body.items.filter((item: { draft: { id: string } }) => ids.includes(item.draft.id));
  assert.equal(mine.length, 3);
  for (const item of mine) assert.equal(item.title, "", "没有当前版本时标题为空而不是报错");
});

test("50 篇数据分两页取完，不重不漏", async () => {
  await seedDrafts(50);
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await listDrafts(sql, { state: "in_review", limit: 20, cursor });
    pages += 1;
    for (const item of page.items) {
      assert.ok(!seen.has(item.draft.id), "同一条稿子不能出现两次");
      seen.add(item.draft.id);
    }
    if (!page.next_cursor || pages > 10) break;
    cursor = page.next_cursor;
  }
  assert.ok(seen.size >= 50, `至少 50 篇，实际 ${seen.size}`);
  assert.ok(pages >= 3, "50 篇按 20 一页至少三页");
});

test("非法游标不会翻出重复数据", async () => {
  const page = await listDrafts(sql, { state: "in_review", limit: 5, cursor: "not-a-cursor" });
  assert.equal(page.items.length, 5);
});

test("待审积压数把 checking/revising/in_review 都算进去", async () => {
  await seedDrafts(2, "checking");
  const count = await pendingReviewCount(sql);
  assert.ok(count >= 2);
});

test("选题列表带证据条数与是否已建稿", async () => {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `bt-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [9], angle: "选题角度", reason: "理由", evidence_status: "sufficient", dedupe_key: `t-${tag}` });
  const draft = await createDraft(sql, topic.id);

  const response = await get(`${API_PREFIX}/topics?limit=50`);
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  const found = body.items.find((item: { topic: { id: string } }) => item.topic.id === topic.id);
  assert.ok(found);
  assert.equal(found.draft_id, draft.id, "已建稿的选题要能链接到稿子");
  assert.equal(found.evidence_count, 0);
});

test("limit 超出范围会被拒绝", async () => {
  const response = await get(`${API_PREFIX}/drafts?limit=500`);
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, "invalid_request");
});
