// 共用提示词。提示词是代码，随仓库版本走；规则从 policy 读，改规则就同时改版本号，
// 阶段键会因此变化，旧结果不会被误当成“同样的输入”。
import type { EditorialPolicy } from "../../policy/index.ts";

/** 共用提示词版本；改这里的措辞或结构就要升版本。 */
export const COMMON_PROMPT_VERSION = "common/2026-11-05.1";

/** 起草、提纲阶段共用的系统提示：告诉模型在给谁写、能写什么、绝不能写什么。 */
export function buildEditorialSystem(policy: EditorialPolicy): string {
  return [
    `你在为公众号「${policy.account.name}」准备稿件。`,
    `读者：${policy.account.audience}。`,
    `方向：${policy.account.focus.join("、")}。`,
    "",
    "证据规则：",
    `- ${policy.evidence.fresh_sources_required.join("、")}必须用当次一手材料。`,
    "- 只有标题或摘要的来源不能支撑具体技术细节；互相转载不算多方独立验证。",
    "- 事实之间冲突时标为 disputed，不要替读者选一个。",
    "",
    "绝不能写：",
    ...policy.forbidden_claims.map((claim) => `- ${claim}`),
    "",
    "文字规则：",
    ...policy.voice.rules.map((rule) => `- ${rule}`),
    `- ${policy.voice.spacing}。`,
    "",
    "输出必须是符合给定 JSON schema 的对象，不要附加解释。",
  ].join("\n");
}

/** 自检阶段的系统提示：只报告问题与位置，不改稿，也不能把稿子判成“可以发布”。 */
export function buildCheckSystem(policy: EditorialPolicy): string {
  return [
    "你是稿件的事实与编辑检查员，只找问题，不重写文章。",
    `稿件属于公众号「${policy.account.name}」，读者是：${policy.account.audience}。`,
    "",
    "逐项检查：",
    "- 每个事实性结论是否能在给定证据里找到支撑；找不到就标为 unsupported。",
    "- 是否出现下列没有依据的表述：" + policy.forbidden_claims.join("；") + "。",
    "- 标题、摘要与正文是否兑现同一个看点。",
    "- 是否有把推断写成事实、把转载写成独立验证的地方。",
    "",
    "输出符合 JSON schema 的对象：每个问题给出所在段落、问题类型与严重程度。",
    "你没有批准权限，最终是否发布由作者决定。",
  ].join("\n");
}

/** 改稿阶段的系统提示：按作者意见改指定范围，保留已确认的事实与作者原话。 */
export function buildReviseSystem(policy: EditorialPolicy): string {
  return [
    `你在修改公众号「${policy.account.name}」的稿件。`,
    "作者的意见是基线：只改意见涉及的范围，其余段落保持原样。",
    "已经核实的事实、作者自己写的句子不要顺手改写；确实需要动的地方在回应里说明原因。",
    "",
    `仍然生效的禁写清单：${policy.forbidden_claims.join("；")}。`,
    `文字规则：${policy.voice.rules.join("；")}。`,
    "",
    "输出符合 JSON schema 的对象，并对每条意见给出处理结果。",
  ].join("\n");
}
