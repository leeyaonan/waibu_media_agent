// 提纲：每节绑定事实、缺材料时返回缺口而不是假装写过、模型输出要过确定性校验。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { stub } from "../../../tests/setup.ts";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import {
  buildOutlineUser,
  decideOutlineMode,
  generateOutline,
  materialGap,
  outlineSchema,
  validateOutline,
} from "../backend/outline/index.ts";
import { CURRENT_POLICY } from "../policy/index.ts";
import type { StageContext } from "../backend/jobs/stage.ts";

after(closeDb);

const claims = [
  { id: "c1", text: "订阅价格为每月 20 美元", kind: "factual" },
  { id: "c2", text: "企业版按席位计费", kind: "factual" },
  { id: "c3", text: "这个价格对个人开发者偏高", kind: "inference" },
];

const materials = [{ title: "官方发布说明", source_name: "OpenAI News", excerpt: "订阅价格为每月 20 美元，企业版按席位计费。" }];

test("需要亲历但没有材料时，输出材料缺口而不是提纲", () => {
  assert.equal(decideOutlineMode({ wants_experience: true, has_author_material: false }), "material_gap");
  const gap = materialGap("我用了两周的感受");
  assert.equal(gap.mode, "material_gap");
  assert.match(gap.gaps[0]!, /需要作者的实际使用记录/u);
  assert.match(gap.suggestion, /资料分析稿/u, "要给出不补材料时的替代写法");
});

test("有材料或不需要亲历时走证据提纲", () => {
  assert.equal(decideOutlineMode({ wants_experience: true, has_author_material: true }), "evidence_outline");
  assert.equal(decideOutlineMode({ wants_experience: false, has_author_material: false }), "evidence_outline");
});

test("提纲校验：引用不存在的事实会被指出", () => {
  const check = validateOutline(
    { sections: [{ heading: "价格", purpose: "说明定价", claim_ids: ["c1", "c9"] }, { heading: "影响", purpose: "解释影响", claim_ids: ["c2", "c3"] }], gaps: [] },
    claims.map((claim) => claim.id),
  );
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((problem) => problem.includes("c9")));
});

test("提纲校验：有事实没被任何一节使用时不算通过", () => {
  const check = validateOutline(
    { sections: [{ heading: "价格", purpose: "说明定价", claim_ids: ["c1"] }, { heading: "影响", purpose: "解释影响", claim_ids: ["c2"] }], gaps: [] },
    ["c1", "c2", "c3"],
  );
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((problem) => problem.includes("没有被任何一节使用")));
});

test("提示词只暴露已核实事实的编号，并要求缺口写进 gaps", () => {
  const prompt = buildOutlineUser({ angle: "新版定价意味着什么", storyTitle: "AI 工具更新", claims, materials });
  assert.ok(prompt.includes("[c1]"));
  assert.ok(prompt.includes("只能引用这些编号"));
  assert.match(prompt, /写进 gaps/u);
});

test("模型返回的提纲会被解析并按事实校验", async (t) => {
  const server = await stub(() => ({
    choices: [{ message: { content: JSON.stringify({ sections: [{ heading: "价格", purpose: "说明定价", claim_ids: ["c1"] }, { heading: "影响", purpose: "解释影响", claim_ids: ["c2", "c3"] }], gaps: ["缺少企业客户的真实反馈"] }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  }));
  t.after(() => server.close());
  process.env.LLM_BASE_URL = `${server.url}/v1`;
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";

  const context = { db: sql, job: { run_id: "00000000-0000-4000-8000-000000000001", stage: "outline", draft_id: null, base_revision_id: null, input_hash: `sha256:${"a".repeat(64)}`, attempt: 1 } } as unknown as StageContext;

  const result = await generateOutline(context, { angle: "新版定价意味着什么", storyTitle: "AI 工具更新", claims, materials, policy: CURRENT_POLICY });
  assert.equal(result.check.ok, true, `不该有校验问题：${result.check.problems.join("；")}`);
  assert.equal(result.outline.sections.length, 2);
  assert.deepEqual(result.outline.gaps, ["缺少企业客户的真实反馈"]);
  assert.ok(result.receipt_id > 0);
});

test("模型给出结构不合规的输出时 schema 直接拒绝", () => {
  assert.throws(() => outlineSchema.parse({ sections: [{ heading: "只有一节", purpose: "x", claim_ids: [] }] }));
  assert.throws(() => outlineSchema.parse({ sections: [] }));
  assert.doesNotThrow(() => outlineSchema.parse({ sections: [{ heading: "a", purpose: "b", claim_ids: [] }, { heading: "c", purpose: "d", claim_ids: [] }] }));
});

test("提纲结构可以被 JSON 序列化后原样读回（页面与 worker 共用）", () => {
  const outline = outlineSchema.parse({ sections: [{ heading: "价格", purpose: "说明", claim_ids: ["c1"] }, { heading: "影响", purpose: "解释", claim_ids: ["c2"] }], gaps: [] });
  const roundTrip = JSON.parse(JSON.stringify(outline));
  assert.deepEqual(outlineSchema.parse(roundTrip), outline);
  assert.ok(z.object({}).safeParse({}).success);
});
