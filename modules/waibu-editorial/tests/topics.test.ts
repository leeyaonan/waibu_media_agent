// 选题：热度不能代替证据；没有合格题要明确返回 skipped；同事件同角度不重复起草，
// 但新进展换了角度会生成新键，不被旧事件一刀切排除。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { CURRENT_POLICY } from "../policy/index.ts";
import { DEFAULT_THRESHOLDS, dedupeKey, noCandidates, rankCandidate, selectCandidates, relevanceScore, type Candidate } from "../backend/topics/rank.ts";
import type { MaterialSource, StoryMaterials } from "../backend/materials/adapter.ts";

const NOW = new Date("2026-11-05T09:00:00+08:00");

const material = (overrides: Partial<MaterialSource> = {}): MaterialSource => ({
  article_id: `art-${randomUUID().slice(0, 8)}`,
  source_id: `src-${randomUUID().slice(0, 6)}`,
  source_name: "来源",
  story_id: 1,
  url: "https://example.com/a",
  title: "AI 编程工具更新",
  published_at: "2026-11-05T07:00:00.000Z",
  excerpt:
    "官方发布了新版 AI 编程助手，支持在编辑器里直接重构代码、生成测试并解释改动。发布说明列出了版本号 v3.2，并给出了迁移步骤与已知问题。" +
    "团队还提供了一个示例仓库，说明如何把旧配置迁到新格式；文档里提醒第三方插件需要同步升级。",
  rights: "quotation",
  body_available: true,
  hash: `sha256:${randomUUID().replace(/-/gu, "").padEnd(64, "0").slice(0, 64)}`,
  ...overrides,
});

const story = (sources: MaterialSource[], title = "AI 编程工具发布新版本"): StoryMaterials => ({
  story_id: 1,
  title,
  sources,
  digest: `sha256:${randomUUID().replace(/-/gu, "").padEnd(64, "0").slice(0, 64)}`,
});

test("高热但无证据的题不进入起草", () => {
  const candidate = rankCandidate(story([]), { policy: CURRENT_POLICY, now: NOW });
  assert.equal(candidate.excluded_because, "没有可用素材");
  assert.equal(candidate.evidence_status, "insufficient");
  assert.ok(candidate.score >= 0);
});

test("只有标题摘要、且不允许摘要稿时被排除", () => {
  const onlySummary = story([material({ body_available: false, excerpt: "发布了新版本" })]);
  const strict = { ...DEFAULT_THRESHOLDS, allow_summary_only: false };
  const candidate = rankCandidate(onlySummary, { policy: CURRENT_POLICY, thresholds: strict, now: NOW });
  assert.match(candidate.excluded_because ?? "", /只有标题或摘要/u);
});

test("一手更新能通过门槛，并给出可读的选题理由", () => {
  const good = story([material(), material({ url: "https://another.example/post" })]);
  const candidate = rankCandidate(good, { policy: CURRENT_POLICY, now: NOW });
  assert.equal(candidate.excluded_because, null);
  assert.ok(candidate.score >= DEFAULT_THRESHOLDS.min_total_score);
  assert.match(candidate.reason, /独立来源 2 条/u);
});

test("排序把不合格的放后面，并截断到当日上限", () => {
  const good = rankCandidate(story([material(), material({ url: "https://b.example/x" })]), { policy: CURRENT_POLICY, now: NOW });
  const weak = rankCandidate({ ...story([material({ body_available: false, excerpt: "短" })]), story_id: 2 }, { policy: CURRENT_POLICY, now: NOW });
  const picked = selectCandidates([weak, good], 1);
  assert.equal(picked.length, 1);
  assert.equal(picked[0]!.excluded_because, null, "先选合格的那条");
});

test("没有任何候选时返回明确的 skipped 与原因", () => {
  const result = noCandidates([]);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /没有可用的公开资料/u);
  assert.equal(result.considered, 0);

  const noneQualify = noCandidates([rankCandidate(story([]), { policy: CURRENT_POLICY, now: NOW })]);
  assert.match(noneQualify.reason, /都不满足门槛/u);
});

test("同事件同角度去重键稳定，换角度就是新键", () => {
  const a = dedupeKey(42, "新版本发布了什么");
  const b = dedupeKey(42, "新版本发布了什么");
  const c = dedupeKey(42, "这次更新对企业客户意味着什么");
  assert.equal(a, b, "重复调度不能重复起草");
  assert.notEqual(a, c, "新角度要能产生新候选");
  assert.match(a, /^[0-9a-f]{32}$/u);
});

test("阈值可配置：提高门槛后同一篇素材被排除", () => {
  const single = story([material({ body_available: false })]);
  const lenient = rankCandidate(single, { policy: CURRENT_POLICY, now: NOW });
  const strict = rankCandidate(single, { policy: CURRENT_POLICY, thresholds: { ...DEFAULT_THRESHOLDS, min_independent_sources: 2 }, now: NOW });
  assert.equal(lenient.excluded_because, null);
  assert.match(strict.excluded_because ?? "", /独立来源不足 2 条/u);
});

test("方向贴合度按账号关键词计算", () => {
  const related = relevanceScore(story([material({ title: "AI 编程工具更新", excerpt: "AI 编程与开发者工具的实践" })]), CURRENT_POLICY);
  const unrelated = relevanceScore(story([material({ title: "电影票房", excerpt: "周末票房冠军" })], "电影票房"), CURRENT_POLICY);
  assert.ok(related > unrelated, `贴合度应更高：${related} vs ${unrelated}`);
});

test("候选结构可直接落库：字段齐全且类型正确", () => {
  const candidate: Candidate = rankCandidate(story([material()]), { policy: CURRENT_POLICY, now: NOW });
  assert.equal(typeof candidate.story_id, "number");
  assert.equal(typeof candidate.score, "number");
  assert.ok(["sufficient", "insufficient", "disputed"].includes(candidate.evidence_status));
});
