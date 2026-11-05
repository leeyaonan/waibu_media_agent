// 意见提交：同一 Idempotency-Key 重复提交只产生一份；旧版本上提意见明确冲突；改稿失败不丢意见。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { passwordLogin, SESSION_COOKIE } from "@aihot/backend/admin/auth";
import { registerEditorialRoutes } from "../backend/http-auth/routes.ts";
import { API_PREFIX, IDEMPOTENCY_HEADER } from "../contracts/api.ts";
import { createDraft, createRun, createTopic, getDraft } from "../backend/store/index.ts";
import { applyAuthorEdit } from "../backend/revisions/index.ts";

after(closeDb);

const PASSWORD = `feedback-test-password-${Date.now()}`;
let app: ReturnType<typeof Fastify>;
let token = "";
let csrf = "";

before(async () => {
  config.adminPassword = PASSWORD;
  app = Fastify({ logger: false });
  registerEditorialRoutes(app);
  await app.ready();
  token = (await passwordLogin(PASSWORD, "/admin", "feedback-test")).token;
  const [session] = await sql`select csrf_token from admin_sessions order by created_at desc limit 1`;
  csrf = String(session!.csrf_token);
});

async function seed(state = "in_review") {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `fb-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });
  const draft = await createDraft(sql, topic.id);
  const saved = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draft.id,
      expected_lock_version: draft.lock_version,
      base_revision_id: null,
      content: { title: "标题", summary: "", body: "第一段。\n\n第二段。", cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "p1",
    }),
  );
  await sql`update waibu_drafts set state = ${state} where id = ${draft.id}`;
  return { draftId: draft.id, revisionId: saved.revision.id };
}

const post = (url: string, payload: unknown, key?: string) =>
  app.inject({
    method: "POST",
    url,
    headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, ...(key ? { [IDEMPOTENCY_HEADER]: key } : {}) },
    payload,
  });

test("提交意见把待审稿推进到改稿中", async () => {
  const seeded = await seed();
  const response = await post(`${API_PREFIX}/drafts/${seeded.draftId}/feedback`, { text: "开头再直接一点", block_id: "0", expected_revision_id: seeded.revisionId });
  assert.equal(response.statusCode, 202, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.replayed, false);
  assert.equal(body.feedback.text, "开头再直接一点");
  assert.equal((await getDraft(sql, seeded.draftId))!.state, "revising");
});

test("同一个 Idempotency-Key 重发只产生一份意见", async () => {
  const seeded = await seed();
  const key = `k-${randomUUID()}`;
  const payload = { text: "价格那句要给出处", expected_revision_id: seeded.revisionId };

  const first = await post(`${API_PREFIX}/drafts/${seeded.draftId}/feedback`, payload, key);
  const second = await post(`${API_PREFIX}/drafts/${seeded.draftId}/feedback`, payload, key);

  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 200, "第二次是重放，不是新建");
  assert.equal(JSON.parse(second.body).replayed, true);
  assert.equal(JSON.parse(first.body).feedback?.id, JSON.parse(second.body).feedback?.id, `first=${first.body} second=${second.body}`);

  const rows = await sql`select count(*)::int as n from waibu_feedback where draft_id = ${seeded.draftId}`;
  assert.equal(rows[0]!.n, 1, "同一次点击不能产生两份改稿");
});

test("同一个键配不同内容会明确报错", async () => {
  const seeded = await seed();
  const key = `k-${randomUUID()}`;
  await post(`${API_PREFIX}/drafts/${seeded.draftId}/feedback`, { text: "意见 A", expected_revision_id: seeded.revisionId }, key);
  const conflict = await post(`${API_PREFIX}/drafts/${seeded.draftId}/feedback`, { text: "意见 B", expected_revision_id: seeded.revisionId }, key);
  assert.equal(conflict.statusCode, 409);
  assert.equal(JSON.parse(conflict.body).code, "idempotency_conflict");
});

test("旧版本上提意见会明确冲突，不写进去", async () => {
  const seeded = await seed();
  // 作者先自己改了一版
  const draft = (await getDraft(sql, seeded.draftId))!;
  const edited = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: seeded.draftId,
      expected_lock_version: draft.lock_version,
      base_revision_id: seeded.revisionId,
      content: { title: "标题", summary: "", body: "改过。", cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "p1",
    }),
  );
  const response = await post(`${API_PREFIX}/drafts/${seeded.draftId}/feedback`, { text: "针对旧版本的意见", expected_revision_id: seeded.revisionId });
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).code, "conflict_version");
  const rows = await sql`select count(*)::int as n from waibu_feedback where draft_id = ${seeded.draftId}`;
  assert.equal(rows[0]!.n, 0, "过期意见不能落库");
  assert.ok(edited.revision.id);
});

test("改稿失败时意见仍然保留，状态停在改稿中", async () => {
  const seeded = await seed();
  const response = await post(`${API_PREFIX}/drafts/${seeded.draftId}/feedback`, { text: "这条要保留下来", expected_revision_id: seeded.revisionId });
  assert.equal(response.statusCode, 202);

  // 模拟改稿任务失败：只写失败状态，不动意见
  const [feedback] = await sql`select id, resolution_revision_id from waibu_feedback where draft_id = ${seeded.draftId}`;
  await sql`insert into waibu_steps (run_id, stage, input_hash, attempt, status, draft_id, error_code)
            select t.run_id, 'revise', ${"sha256:" + "e".repeat(64)}, 1, 'failed', ${seeded.draftId}, 'provider_outage'
            from waibu_drafts d join waibu_topics t on t.id = d.topic_id where d.id = ${seeded.draftId}`;

  assert.ok(feedback, `意见没找到：${JSON.stringify(feedback)}`);
  const [still] = await sql`select text, resolution_revision_id from waibu_feedback where id = ${feedback!.id}`;
  assert.equal(still!.text, "这条要保留下来");
  assert.equal(still!.resolution_revision_id, null, "没改成功就没有落实版本");
  assert.equal((await getDraft(sql, seeded.draftId))!.state, "revising", "失败不改变稿件的改稿状态");
});

test("意见提交需要 CSRF", async () => {
  const seeded = await seed();
  const response = await app.inject({
    method: "POST",
    url: `${API_PREFIX}/drafts/${seeded.draftId}/feedback`,
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
    payload: { text: "x", expected_revision_id: seeded.revisionId },
  });
  assert.equal(response.statusCode, 403);
});
