// 审核详情接口：段落与事实的对应关系要准，证据摘录要能取到，不存在的稿子 404。
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
import { linkRevisionClaims, createClaim, createDraft, createEvidence, createRun, createTopic } from "../backend/store/index.ts";
import { applyAuthorEdit } from "../backend/revisions/index.ts";

after(closeDb);

const PASSWORD = `review-test-password-${Date.now()}`;
let app: ReturnType<typeof Fastify>;
let token = "";

before(async () => {
  config.adminPassword = PASSWORD;
  app = Fastify({ logger: false });
  registerEditorialRoutes(app);
  await app.ready();
  token = (await passwordLogin(PASSWORD, "/admin", "review-test")).token;
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: `${SESSION_COOKIE}=${token}` } });

async function seed() {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `rv-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });

  const priceEvidence = await createEvidence(sql, {
    source_id: "官方来源",
    article_id: `art-${tag.slice(0, 8)}`,
    url: "https://example.com/price",
    published_at: "2026-11-05T07:00:00.000Z",
    excerpt: "订阅价格为每月 20 美元。",
    hash: `sha256:${"a".repeat(64)}`,
    rights: "quotation",
  });
  const versionEvidence = await createEvidence(sql, {
    source_id: "版本说明",
    article_id: `art2-${tag.slice(0, 8)}`,
    url: "https://example.com/version",
    published_at: "2026-11-05T07:30:00.000Z",
    excerpt: "当前版本号 v3.2。",
    hash: `sha256:${"b".repeat(64)}`,
    rights: "quotation",
  });

  const priceClaim = await createClaim(sql, { topic_id: topic.id, text: "订阅价格为每月 20 美元", kind: "factual", evidence_ids: [priceEvidence.id], status: "supported" });
  const versionClaim = await createClaim(sql, { topic_id: topic.id, text: "当前版本号 v3.2", kind: "factual", evidence_ids: [versionEvidence.id], status: "supported" });

  const draft = await createDraft(sql, topic.id);
  const body = "开头一段背景。\n\n订阅价格为每月 20 美元。\n\n当前版本号 v3.2。";
  const { revision } = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draft.id,
      expected_lock_version: draft.lock_version,
      base_revision_id: null,
      content: { title: "标题", summary: "摘要", body, cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "p1",
    }),
  );
  await linkRevisionClaims(sql, revision.id, [
    { block_id: "1", claim_id: priceClaim.id },
    { block_id: "2", claim_id: versionClaim.id },
  ]);
  return { draftId: draft.id, priceClaim, versionClaim, priceEvidence, versionEvidence };
}

test("段落与事实一一对应，证据摘录跟着事实走", async () => {
  const seeded = await seed();
  const response = await get(`${API_PREFIX}/drafts/${seeded.draftId}`);
  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);

  assert.equal(body.blocks.length, 3);
  assert.equal(body.blocks[0].text, "开头一段背景。");
  assert.deepEqual(body.blocks[0].claim_ids, [], "没有绑定事实的段落不显示证据入口");
  assert.deepEqual(body.blocks[1].claim_ids, [seeded.priceClaim.id], "价格段对应价格事实");
  assert.deepEqual(body.blocks[2].claim_ids, [seeded.versionClaim.id], "版本段对应版本事实");

  const price = body.claims.find((claim: { id: string }) => claim.id === seeded.priceClaim.id);
  assert.equal(price.evidence.length, 1);
  assert.equal(price.evidence[0].excerpt, "订阅价格为每月 20 美元。", "摘录必须来自它自己的证据");
  assert.equal(price.evidence[0].source_id, "官方来源");

  const version = body.claims.find((claim: { id: string }) => claim.id === seeded.versionClaim.id);
  assert.equal(version.evidence[0].excerpt, "当前版本号 v3.2。", "不能串到别的证据");
});

test("未登录读详情返回 401", async () => {
  const seeded = await seed();
  const response = await app.inject({ method: "GET", url: `${API_PREFIX}/drafts/${seeded.draftId}` });
  assert.equal(response.statusCode, 401);
});

test("不存在的稿件返回 404", async () => {
  const response = await get(`${API_PREFIX}/drafts/00000000-0000-4000-8000-000000000000`);
  assert.equal(response.statusCode, 404);
});

test("详情带出当前批准状态", async () => {
  const seeded = await seed();
  const response = await get(`${API_PREFIX}/drafts/${seeded.draftId}`);
  const body = JSON.parse(response.body);
  assert.equal(body.approval, null, "没批准时是 null，不是空对象");
  assert.equal(body.revision.content_hash.startsWith("sha256:"), true);
});
