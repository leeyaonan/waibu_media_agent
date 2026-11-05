// 证据驱动提纲：每一节都要说清用哪几条事实，缺什么就写进缺口，
// 而不是先写出结构再回头找证据。
//
// 需要作者亲历的题材，如果没有作者材料，不生成“假装写过”的提纲，
// 直接返回材料缺口，让作者决定是补材料还是改成资料分析稿。
import { z } from "zod";
import type { EditorialPolicy } from "../../policy/index.ts";
import { buildEditorialSystem } from "../../prompts/common/index.ts";
import { callModelForStage } from "../model/client.ts";
import type { StageContext } from "../jobs/stage.ts";
import { COMMON_PROMPT_VERSION } from "../../prompts/common/index.ts";

/** 提纲结构：每节必须绑定它依赖的 claim。 */
export const outlineSchema = z.object({
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(80),
        purpose: z.string().min(1).max(300),
        claim_ids: z.array(z.string()),
      }),
    )
    .min(2)
    .max(8),
  gaps: z.array(z.string().max(300)).default([]),
});

export type Outline = z.infer<typeof outlineSchema>;

export type OutlineMode = "evidence_outline" | "material_gap";

export interface OutlinePlanInput {
  /** 这个角度是否必须作者亲历才能写（例如“我用了两周的感受”）。 */
  wants_experience: boolean;
  has_author_material: boolean;
}

/**
 * 先决定这篇能不能写：需要亲历但没有材料时，返回材料缺口而不是提纲。
 * 这条判断不经过模型——模型没法替作者提供经历。
 */
export function decideOutlineMode(input: OutlinePlanInput): OutlineMode {
  return input.wants_experience && !input.has_author_material ? "material_gap" : "evidence_outline";
}

export interface MaterialGap {
  mode: "material_gap";
  gaps: string[];
  suggestion: string;
}

/** 缺材料时说清楚缺什么，以及不补材料能怎么改。 */
export function materialGap(angle: string): MaterialGap {
  return {
    mode: "material_gap",
    gaps: [`角度「${angle}」需要作者的实际使用记录，目前没有收到任何材料`],
    suggestion: "补一段使用过程或结果截图后重跑；或者改成资料分析稿，只解释事实与影响，不写第一人称体验。",
  };
}

export interface OutlineCheck {
  ok: boolean;
  problems: string[];
}

/**
 * 提纲的确定性校验：绑定的 claim 必须真实存在，且每个事实性结论至少要有一节用它。
 * 模型写多漂亮都不影响这里的判断。
 */
export function validateOutline(outline: Outline, validClaimIds: readonly string[]): OutlineCheck {
  const problems: string[] = [];
  const known = new Set(validClaimIds);
  const used = new Set<string>();

  for (const section of outline.sections) {
    for (const claimId of section.claim_ids) {
      if (!known.has(claimId)) problems.push(`「${section.heading}」引用了不存在的事实 ${claimId}`);
      used.add(claimId);
    }
  }
  if (outline.sections.length < 2) problems.push("提纲至少要有两节");
  const unused = [...known].filter((id) => !used.has(id));
  if (unused.length > 0) problems.push(`有事实没有被任何一节使用：${unused.slice(0, 5).join("、")}`);

  return { ok: problems.length === 0, problems };
}

/** 提纲提示词：把可用事实编号列出来，要求模型只能引用这些编号。 */
export function buildOutlineUser(input: {
  angle: string;
  storyTitle: string;
  claims: ReadonlyArray<{ id: string; text: string; kind: string }>;
  materials: ReadonlyArray<{ title: string; source_name: string; excerpt: string }>;
}): string {
  const claims = input.claims.map((claim) => `- [${claim.id}]（${claim.kind}）${claim.text}`).join("\n");
  const materials = input.materials
    .slice(0, 8)
    .map((item) => `- ${item.source_name}《${item.title}》：${item.excerpt.slice(0, 200)}`)
    .join("\n");
  return [
    `事件：${input.storyTitle}`,
    `要回答的问题：${input.angle}`,
    "",
    "可用事实（只能引用这些编号）：",
    claims || "（暂无已核实事实）",
    "",
    "素材摘录：",
    materials,
    "",
    "输出 JSON：{ sections: [{ heading, purpose, claim_ids }], gaps: [] }",
    "每节必须写出它用到的 claim_ids；没有证据支撑的部分不要写进提纲，写进 gaps。",
  ].join("\n");
}

export interface GenerateOutlineInput {
  angle: string;
  storyTitle: string;
  claims: ReadonlyArray<{ id: string; text: string; kind: string }>;
  materials: ReadonlyArray<{ title: string; source_name: string; excerpt: string }>;
  policy: EditorialPolicy;
}

/**
 * 调模型产出提纲并当场校验。校验不过不抛异常，而是把问题带回去：
 * 上层可以选择重试一次，也可以把缺口显示给作者。
 */
export async function generateOutline(
  context: StageContext,
  input: GenerateOutlineInput,
): Promise<{ outline: Outline; check: OutlineCheck; receipt_id: number; reused: boolean }> {
  const result = await callModelForStage(context, {
    purpose: "waibu.outline",
    prompt_version: COMMON_PROMPT_VERSION,
    system: buildEditorialSystem(input.policy),
    user: buildOutlineUser(input),
    schema: outlineSchema,
    maxTokens: 2000,
  });
  return {
    outline: result.data,
    check: validateOutline(result.data, input.claims.map((claim) => claim.id)),
    receipt_id: result.receipt_id,
    reused: result.reused,
  };
}
