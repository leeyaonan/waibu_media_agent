// 付费模型的唯一入口。所有阶段都从这里发请求，因此额度检查、回执复用和错误分类只有一份实现：
// 上游 chatJson 负责回执、请求上限、供应商切换；这里补充单稿额度与可读的失败分类。
import type { Db } from "@aihot/backend/db";
import type { z } from "zod";
import { chatJson } from "@aihot/backend/providers/llm";
import { failureKind, BudgetExceededError } from "@aihot/backend/providers/receipts";
import { EditorialError } from "../../contracts/errors.ts";
import { assertWithinBudget } from "./budget.ts";
import { assertModelConfigured, modelName } from "./config.ts";
import type { StageContext } from "../jobs/stage.ts";

/** 失败分类：写进 waibu_steps.error_code，页面与排障按它判断要不要重试。 */
export type ModelFailureCode =
  | "budget_paused"
  | "model_off"
  | "provider_refused"
  | "provider_outage"
  | "outcome_unknown"
  | "output_unusable"
  | "busy"
  | "other";

export function classifyModelFailure(error: unknown): ModelFailureCode {
  if (error instanceof EditorialError && error.code === "budget_paused") return "budget_paused";
  switch (failureKind(error)) {
    case "off":
      return "model_off";
    case "budget":
      return "budget_paused";
    case "busy":
      return "busy";
    case "outage":
      return "provider_outage";
    case "refused":
      return "provider_refused";
    case "unknown":
      return "outcome_unknown";
    case "unusable":
      return "output_unusable";
    default:
      return "other";
  }
}

/** 这些失败重试有用（临时故障）；其余要人工处理，避免白白烧钱。 */
export function retryableFailure(code: ModelFailureCode): boolean {
  return code === "provider_outage" || code === "busy" || code === "outcome_unknown";
}

export interface ModelCallOptions<S extends z.ZodType> {
  /** 关联稿件，用于单稿额度；选题阶段可以为 null。 */
  draft_id: string | null;
  /** 回执用途，形如 "waibu.outline"，用于统计与排障。 */
  purpose: string;
  prompt_version: string;
  subject: string;
  system: string;
  user: string;
  schema: S;
  /** 模型预设键（"default" 或 site/models.ts 里的预设名），不是模型名本身。 */
  model?: string;
  maxTokens?: number;
  /** 显式重跑时标记，让回执不复用上一次的结果。 */
  attemptTag?: string;
  timeoutMs?: number;
}

export interface ModelCallResult<T> {
  data: T;
  receipt_id: number;
  /** true 表示这次没真的发请求，复用了已保存的结果。 */
  reused: boolean;
  usage: Record<string, unknown> | null;
}

/**
 * 发一次结构化模型请求。额度不足时抛 budget_paused（阶段会被标成暂停），
 * 其余失败原样抛出，由调用方分类记录。
 */
export async function callModel<S extends z.ZodType>(db: Db, options: ModelCallOptions<S>): Promise<ModelCallResult<z.infer<S>>> {
  assertModelConfigured();
  await assertWithinBudget(db, options.draft_id);
  const result = await chatJson({
    model: options.model ?? "default",
    purpose: options.purpose,
    subject: options.subject,
    promptVersion: options.prompt_version,
    system: options.system,
    user: options.user,
    schema: options.schema,
    maxTokens: options.maxTokens,
    attemptTag: options.attemptTag,
    timeoutMs: options.timeoutMs,
  });
  return { data: result.data, receipt_id: result.receiptId, reused: result.reused, usage: result.usage };
}

/** 阶段实现里的便捷入口：稿件 id 与 subject 从任务里取，避免每个阶段各写一遍。 */
export function callModelForStage<S extends z.ZodType>(context: StageContext, options: Omit<ModelCallOptions<S>, "draft_id" | "subject"> & { subject?: string }): Promise<ModelCallResult<z.infer<S>>> {
  return callModel(context.db, {
    ...options,
    draft_id: context.job.draft_id,
    subject: options.subject ?? `run:${context.job.run_id}/${context.job.stage}`,
  });
}

export { BudgetExceededError };
