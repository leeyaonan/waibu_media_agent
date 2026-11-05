// 阶段键与预算默认值。阶段键决定“同样的工作是否已经做过”：证据、策略、提示词、模型配置、基准稿、
// 改稿意见任何一项变化都会产生新的键，恢复或重投时据此复用已有产物。
import { inputHash } from "./content.ts";
import { STAGES } from "./entities.ts";

/** 管线版本随契约或流程变化升级；不同版本的结果不互相复用。 */
export const PIPELINE_VERSION = "waibu-editorial/v1";

export type Stage = (typeof STAGES)[number];

/** 阶段顺序；check 与 revise 会循环，循环次数受预算约束。 */
export const STAGE_ORDER: readonly Stage[] = ["evidence", "outline", "draft", "check", "revise"];

/** 会调用付费模型的阶段；evidence 与 check 的确定性部分不调模型。 */
export const MODEL_STAGES: readonly Stage[] = ["outline", "draft", "check", "revise"];

export interface StageKeyParts {
  stage: Stage;
  /** 编辑策略版本（policy/ 下的版本号）。 */
  policy_version: string;
  /** 该阶段使用的提示词版本。 */
  prompt_version: string;
  /** 模型与请求参数折成的 hash，换模型即换键。 */
  model_config_hash: string;
  /** 参与该阶段的证据快照 hash，排序后传入。 */
  evidence_hashes: readonly string[];
  /** 生成类阶段的基准版本。 */
  base_revision_id: string | null;
  /** 触发改稿的意见 id，排序后传入。 */
  feedback_ids: readonly string[];
}

/** 阶段输入键：同样的输入必须得到同一个 key，恢复时不会重复生成，也不会错误复用。 */
export function stageInputHash(parts: StageKeyParts): string {
  return inputHash({
    pipeline: PIPELINE_VERSION,
    stage: parts.stage,
    policy: parts.policy_version,
    prompt: parts.prompt_version,
    model: parts.model_config_hash,
    evidence: [...new Set(parts.evidence_hashes)].sort(),
    base_revision: parts.base_revision_id,
    feedback: [...new Set(parts.feedback_ids)].sort(),
  });
}

/**
 * 预算与数量上限的初始默认值。都是可调整配置，不是承诺：
 * 单稿调用次数、输出 token、运行时长先卡住，货币硬熔断列在 F44，不在 MVP 声称已提供。
 */
export const BUDGET_DEFAULTS = {
  /** 每日自动生成待审稿上限。 */
  max_drafts_per_day: 1,
  /** 每日展示候选选题上限。 */
  max_candidates_per_day: 5,
  /** 待审积压达到这个数量就暂停自动起草，继续采集。 */
  max_pending_reviews: 3,
  /** 自检后的有限修复轮数；超过转 on_hold，不做无限自我反思。 */
  max_repair_rounds: 2,
  /** 同一阶段同一输入的最大尝试次数。 */
  max_attempts_per_stage: 3,
  /** 单篇稿件的输出 token 上限（各阶段合计）。 */
  max_output_tokens_per_draft: 60_000,
  /** 单篇稿件的模型调用次数上限（各阶段合计）。 */
  max_calls_per_draft: 20,
  /** 单次运行的最长时长，分钟。 */
  max_run_minutes: 45,
} as const;

/** 定时运行默认时间（北京时间），与 site 的时区保持一致。 */
export const DAILY_SCHEDULE = {
  timezone: "Asia/Shanghai",
  hour: 8,
  minute: 30,
} as const;
