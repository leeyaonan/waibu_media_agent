// 起草：数字不许漂移、没有作者材料不许写第一人称、超长标题只提示不阻断。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { stub } from "../../../tests/setup.ts";
import { closeDb, sql } from "@aihot/backend/db";
import { buildDraftUser, draftSchema, generateDraft, validateDraft, type Draft } from "../backend/drafting/index.ts";
import { CURRENT_POLICY } from "../policy/index.ts";
import type { StageContext } from "../backend/jobs/stage.ts";

after(closeDb);

const claims = [
  { id: "c1", text: "订阅价格为每月 20 美元" },
  { id: "c2", text: "当前版本号是 v3.2" },
];
const materials = [{ title: "官方发布说明", source_name: "OpenAI News", excerpt: "订阅价格为每月 20 美元，版本 v3.2。" }];

const draft = (overrides: Partial<Draft> = {}): Draft => ({
  title: "新版定价意味着什么",
  summary: "价格与版本都来自官方发布说明。",
  body: "官方把订阅价格定在每月 20 美元。\n\n这次更新对应 v3.2。",
  block_claims: {},
  ...overrides,
});

const context = (hasMaterial = false) => ({ claims, materials, has_author_material: hasMaterial, policy: CURRENT_POLICY });

test("正常草稿通过检查", () => {
  const check = validateDraft(draft(), context());
  assert.equal(check.ok, true, check.problems.join("；"));
  assert.equal(check.warnings.length, 0);
});

test("数字漂移被拦下：证据写 20，稿子写 25", () => {
  const check = validateDraft(draft({ body: "官方把订阅价格定在每月 25 美元。" }), context());
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((problem) => problem.includes("25")), "要指出具体是哪个数字");
});

test("版本号漂移同样被拦下", () => {
  const check = validateDraft(draft({ body: "这次更新对应 v3.3。" }), context());
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((problem) => problem.includes("v3.3")));
});

test("没有作者材料时不能出现第一人称亲历", () => {
  const check = validateDraft(draft({ body: "我实测了一周，这套流程一次就成功。" }), context(false));
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((problem) => problem.includes("第一人称")));
});

test("有作者材料时第一人称可以写", () => {
  const check = validateDraft(draft({ body: "我实测了一周，这套流程确实更快。价格仍是每月 20 美元，版本 v3.2。" }), context(true));
  assert.equal(check.ok, true, check.problems.join("；"));
});

test("超长标题与摘要只提示，不阻断", () => {
  const check = validateDraft(draft({ title: "标".repeat(80), summary: "摘".repeat(200) }), context());
  assert.equal(check.ok, true, "长度不是硬错误，作者可以自己压");
  assert.equal(check.warnings.length, 2);
  assert.ok(check.warnings[0]!.includes("标题"));
});

test("提示词把“不许写第一人称”讲清楚，且只给已核实事实", () => {
  const prompt = buildDraftUser({
    angle: "新版定价意味着什么",
    outline: { sections: [{ heading: "价格", purpose: "说明定价", claim_ids: ["c1"] }, { heading: "版本", purpose: "说明版本", claim_ids: ["c2"] }], gaps: [] },
    claims,
    materials,
    hasAuthorMaterial: false,
  });
  assert.match(prompt, /不要写“我实测”/u);
  assert.ok(prompt.includes("[c1]"));
  assert.match(prompt, /数字不能改/u);
});

test("模型返回的草稿会被解析并校验", async (t) => {
  const server = await stub(() => ({
    choices: [{ message: { content: JSON.stringify({ title: "新版定价意味着什么", summary: "价格来自官方。", body: "订阅价格为每月 20 美元。\n\n版本 v3.2。", block_claims: {} }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  }));
  t.after(() => server.close());
  process.env.LLM_BASE_URL = `${server.url}/v1`;
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";

  const stage = { db: sql, job: { run_id: "00000000-0000-4000-8000-000000000002", stage: "draft", draft_id: null, base_revision_id: null, input_hash: `sha256:${"b".repeat(64)}`, attempt: 1 } } as unknown as StageContext;
  const result = await generateDraft(stage, {
    angle: "新版定价意味着什么",
    outline: { sections: [{ heading: "价格", purpose: "说明", claim_ids: ["c1"] }, { heading: "版本", purpose: "说明", claim_ids: ["c2"] }], gaps: [] },
    context: context(),
    materials,
  });
  assert.equal(result.check.ok, true, result.check.problems.join("；"));
  assert.equal(result.draft.title, "新版定价意味着什么");
  assert.ok(result.receipt_id > 0);
});

test("草稿 schema 拒绝空正文与缺字段", () => {
  assert.throws(() => draftSchema.parse({ title: "t", summary: "s", body: "" }));
  assert.throws(() => draftSchema.parse({ summary: "s", body: "b" }));
  assert.doesNotThrow(() => draftSchema.parse({ title: "t", summary: "s", body: "b" }));
});
