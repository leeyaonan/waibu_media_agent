// 历史选题去重：重复调度不再起草，新进展不会被旧事件一刀切排除。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@aihot/backend/db";
import { createRun, createTopic } from "../backend/store/index.ts";
import { decideTopic, findByDedupeKey, lastTopicForStory, latestPublishedAt } from "../backend/topics/dedupe.ts";
import { dedupeKey, rankCandidate } from "../backend/topics/rank.ts";
import { CURRENT_POLICY } from "../policy/index.ts";
import type { MaterialSource, StoryMaterials } from "../backend/materials/adapter.ts";

after(closeDb);

const NOW = new Date("2026-11-05T09:00:00+08:00");

const material = (publishedAt: string | null, url = "https://example.com/a"): MaterialSource => ({
  article_id: `art-${randomUUID().slice(0, 8)}`,
  source_id: "src-dedupe",
  source_name: "来源",
  story_id: 1,
  url,
  title: "AI 编程工具发布新版本",
  published_at: publishedAt,
  excerpt: "官方发布了新版 AI 编程助手，支持重构、生成测试与解释改动，并给出迁移步骤与已知问题，文档提醒第三方插件同步升级。",
  rights: "quotation",
  body_available: true,
  hash: `sha256:${randomUUID().replace(/-/gu, "").padEnd(64, "0").slice(0, 64)}`,
});

const story = (storyId: number, sources: MaterialSource[], title = "AI 编程工具发布新版本"): StoryMaterials => ({
  story_id: storyId,
  title,
  sources,
  digest: `sha256:${randomUUID().replace(/-/gu, "").padEnd(64, "0").slice(0, 64)}`,
});

async function newRun() {
  const tag = randomUUID().replace(/-/gu, "");
  return createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `dd-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
}

test("第一次出现的选题可以创建", async () => {
  const materials = story(700001, [material("2026-11-05T07:00:00.000Z")]);
  const candidate = rankCandidate(materials, { policy: CURRENT_POLICY, now: NOW });
  const decision = await decideTopic(sql, candidate, materials);
  assert.equal(decision.action, "create");
});

test("重复调度不重复起草：同键第二次直接 skip", async () => {
  const materials = story(700002, [material("2026-11-05T07:00:00.000Z")]);
  const candidate = rankCandidate(materials, { policy: CURRENT_POLICY, now: NOW });
  const run = await newRun();
  await createTopic(sql, {
    run_id: run.id,
    story_ids: [materials.story_id],
    angle: candidate.angle,
    reason: candidate.reason,
    evidence_status: "sufficient",
    dedupe_key: candidate.dedupe_key,
  });

  const again = await decideTopic(sql, candidate, materials);
  assert.equal(again.action, "skip");
  if (again.action === "skip") assert.match(again.reason, /已经写过/u);
});

test("新进展：同一事件有更新的发布时给出 follow_up", async () => {
  const storyId = 700003;
  const run = await newRun();
  // 先有一次较早的选题，再把它的创建时间挪到昨天
  await createTopic(sql, {
    run_id: run.id,
    story_ids: [storyId],
    angle: "上一版本发布了什么",
    reason: "",
    evidence_status: "sufficient",
    dedupe_key: dedupeKey(storyId, "上一版本发布了什么"),
  });
  await sql`update waibu_topics set created_at = '2026-11-04T10:00:00+08:00' where story_ids = array[${storyId}]::bigint[]`;

  const materials = story(storyId, [material("2026-11-05T08:00:00.000Z")]);
  const candidate = rankCandidate(materials, { policy: CURRENT_POLICY, now: NOW });
  const decision = await decideTopic(sql, candidate, materials);
  assert.equal(decision.action, "follow_up");
  if (decision.action === "follow_up") assert.match(decision.reason, /又有新发布/u);
});

test("素材不比上次选题新时仍按新角度创建，而不是被旧事件挡住", async () => {
  const storyId = 700004;
  const run = await newRun();
  await createTopic(sql, {
    run_id: run.id,
    story_ids: [storyId],
    angle: "另一个角度",
    reason: "",
    evidence_status: "sufficient",
    dedupe_key: dedupeKey(storyId, "另一个角度"),
  });
  const materials = story(storyId, [material("2026-11-01T08:00:00.000Z")]);
  const candidate = rankCandidate(materials, { policy: CURRENT_POLICY, now: NOW });
  const decision = await decideTopic(sql, candidate, materials);
  assert.equal(decision.action, "create", "换角度不代表重复，旧事件不能一刀切排除");
});

test("查询辅助函数行为正确", async () => {
  const storyId = 700005;
  const run = await newRun();
  const key = dedupeKey(storyId, "辅助函数角度");
  await createTopic(sql, { run_id: run.id, story_ids: [storyId], angle: "辅助函数角度", reason: "", evidence_status: "sufficient", dedupe_key: key });

  assert.equal((await findByDedupeKey(sql, key))!.angle, "辅助函数角度");
  assert.equal(await findByDedupeKey(sql, "not-exists"), null);
  assert.ok((await lastTopicForStory(sql, storyId))!.id);
  assert.equal(await lastTopicForStory(sql, 700099), null);
});

test("最新发布时间只取有可信时间的素材", () => {
  const materials = story(700006, [material("2026-11-03T08:00:00.000Z"), material(null, "https://b.example/x")]);
  assert.equal(latestPublishedAt(materials), "2026-11-03T08:00:00.000Z");
  assert.equal(latestPublishedAt(story(700007, [material(null)])), null);
});
