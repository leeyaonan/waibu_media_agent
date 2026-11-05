// 长文起草：结构化输出 + 确定性检查。模型负责写，能不能用由规则决定：
// 数字与版本不能漂移、第一人称亲历必须有作者材料、标题与摘要长度要能直接发。
import { z } from "zod";
import type { EditorialPolicy } from "../../policy/index.ts";
import { buildEditorialSystem, COMMON_PROMPT_VERSION } from "../../prompts/common/index.ts";
import { callModelForStage } from "../model/client.ts";
import type { StageContext } from "../jobs/stage.ts";
import { numericTokens } from "../evidence/support.ts";
import { guardFirstPersonExperience } from "../author-input/index.ts";
import type { Outline } from "../outline/index.ts";

/** 公众号标题上限按 64 字，摘要按 120 字；超出在复制到后台前就拦下。 */
export const TITLE_LIMIT = 64;
export const SUMMARY_LIMIT = 120;

export const draftSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(400),
  body: z.string().min(1).max(20_000),
  /** 正文段落 id → 引用的 claim id，用于证据抽屉。 */
  block_claims: z.record(z.string(), z.array(z.string())).default({}),
});

export type Draft = z.infer<typeof draftSchema>;

export interface DraftCheck {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

export interface DraftContext {
  claims: ReadonlyArray<{ id: string; text: string }>;
  materials: ReadonlyArray<{ excerpt: string; title: string }>;
  has_author_material: boolean;
  policy: EditorialPolicy;
}

/**
 * 起草后的确定性检查：
 * - 正文里出现的数字/版本必须能在事实或素材原文里找到，防止“20 美元”被写成“25 美元”；
 * - 第一人称亲历必须真的有作者材料，否则一律不通过；
 * - 标题与摘要超过发布上限只提示，不阻断（作者可以自己压）。
 */
export function validateDraft(draft: Draft, context: DraftContext): DraftCheck {
  const problems: string[] = [];
  const warnings: string[] = [];

  const sourceText = [...context.claims.map((claim) => claim.text), ...context.materials.map((material) => material.excerpt)].join("\n").toLowerCase();
  const drifted = numericTokens(`${draft.title} ${draft.body}`).filter((token) => !sourceText.includes(token));
  if (drifted.length > 0) problems.push(`这些数字/版本在事实与素材里找不到：${drifted.join("、")}`);

  const experience = guardFirstPersonExperience(`${draft.title} ${draft.body}`, context.has_author_material);
  if (!experience.allowed) problems.push(`没有作者材料，不能写第一人称亲历：${experience.offending.join("、")}`);

  if (draft.title.length > TITLE_LIMIT) warnings.push(`标题 ${draft.title.length} 字，超过 ${TITLE_LIMIT} 字上限`);
  if (draft.summary.length > SUMMARY_LIMIT) warnings.push(`摘要 ${draft.summary.length} 字，超过 ${SUMMARY_LIMIT} 字上限`);

  return { ok: problems.length === 0, problems, warnings };
}

export function buildDraftUser(input: { angle: string; outline: Outline; claims: ReadonlyArray<{ id: string; text: string }>; materials: ReadonlyArray<{ title: string; source_name: string; excerpt: string }>; hasAuthorMaterial: boolean }): string {
  const outline = input.outline.sections.map((section, index) => `${index + 1}. ${section.heading}｜${section.purpose}｜用到的编号：${section.claim_ids.join(",")}`).join("\n");
  const claims = input.claims.map((claim) => `- [${claim.id}] ${claim.text}`).join("\n");
  const materials = input.materials.slice(0, 6).map((item) => `- ${item.source_name}《${item.title}》：${item.excerpt.slice(0, 200)}`).join("\n");
  return [
    `要回答的问题：${input.angle}`,
    "",
    "提纲：",
    outline,
    "",
    "已核实事实（只能用这些，数字不能改）：",
    claims,
    "",
    "素材摘录：",
    materials,
    "",
    input.hasAuthorMaterial ? "作者提供了材料，可以引用其中的亲历。" : "作者没有提供任何亲历材料：不要写“我实测”“我花了多久”“一次就成功”这类第一人称体验。",
    "",
    "输出 JSON：{ title, summary, body, block_claims }。",
    "body 用空行分段；标题不超过 64 字，摘要不超过 120 字。",
  ].join("\n");
}

/** 调模型写稿并当场校验；校验不过不抛异常，把问题交回给编排层决定修复还是转人工。 */
export async function generateDraft(
  stage: StageContext,
  input: { angle: string; outline: Outline; context: DraftContext; materials: ReadonlyArray<{ title: string; source_name: string; excerpt: string }> },
): Promise<{ draft: Draft; check: DraftCheck; receipt_id: number }> {
  const result = await callModelForStage(stage, {
    purpose: "waibu.draft",
    prompt_version: COMMON_PROMPT_VERSION,
    system: buildEditorialSystem(input.context.policy),
    user: buildDraftUser({
      angle: input.angle,
      outline: input.outline,
      claims: input.context.claims,
      materials: input.materials,
      hasAuthorMaterial: input.context.has_author_material,
    }),
    schema: draftSchema,
    maxTokens: 6000,
  });
  return { draft: result.data, check: validateDraft(result.data, input.context), receipt_id: result.receipt_id };
}
