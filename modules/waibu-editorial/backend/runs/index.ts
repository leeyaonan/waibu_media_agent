// 运行与费用面板的数据：每次运行跑了哪些阶段、花了多少、为什么停下。
//
// 费用只报知道的：有调用没拿到价格时合计为 unknown，绝不填 0；
// 面板不返回密钥，也不返回整段提示词——只给用途、模型、token 与可读状态。
import type { Db } from "@aihot/backend/db";
import { runRowSchema, stepRowSchema, type RunRow } from "../../contracts/entities.ts";
import type { Stage } from "../../contracts/pipeline.ts";
import type { TaskState } from "../../contracts/states.ts";
import { row } from "../store/rows.ts";

export interface StepSummary {
  stage: Stage;
  status: TaskState;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  purpose: string | null;
  model: string | null;
  prompt_version: string | null;
  input_tokens: number;
  output_tokens: number;
  /** 单步费用；不知道就是 null。 */
  cost: { amount: number; currency: string } | null;
}

export interface RunSummary {
  run: RunRow;
  steps: StepSummary[];
  total_tokens: number;
  /** 有未知价格时为 null，页面显示 unknown。 */
  cost: { amount: number; currency: string } | null;
  /** 需要人处理的原因，页面据此显示恢复按钮与文案。 */
  paused_reason: string | null;
}

function costOf(cost: unknown, currency: unknown, basis: unknown): { amount: number; currency: string } | null {
  if (cost === null || cost === undefined || currency === null) return null;
  return { amount: Number(cost), currency: String(currency) };
}

/** 一次运行的详情：阶段、token、费用与暂停原因。 */
export async function runDetail(db: Db, runId: string): Promise<RunSummary | null> {
  const [runRow] = await db`select *, business_date::text as business_date from waibu_runs where id = ${runId}`;
  if (!runRow) return null;
  const run = row(runRowSchema, runRow);

  const steps = await db`
    select s.stage, s.status, s.attempt, s.created_at, s.updated_at, s.error_code, s.receipt_id,
           r.purpose, r.model, r.cost, r.currency, r.cost_basis,
           nullif(r.request->>'promptVersion', '') as prompt_version,
           coalesce(nullif(r.usage->>'prompt_tokens', '')::numeric, 0)::int as input_tokens,
           coalesce(nullif(r.usage->>'completion_tokens', '')::numeric, 0)::int as output_tokens
    from waibu_steps s
    left join receipts r on r.id = s.receipt_id
    where s.run_id = ${runId}
    order by s.created_at, s.stage`;

  const summaries: StepSummary[] = steps.map((item) => ({
    stage: item.stage as Stage,
    status: item.status as TaskState,
    attempt: Number(item.attempt),
    started_at: item.created_at ? new Date(item.created_at as string).toISOString() : null,
    finished_at: item.status === "running" || item.status === "queued" ? null : new Date(item.updated_at as string).toISOString(),
    error_code: item.error_code ? String(item.error_code) : null,
    purpose: item.purpose ? String(item.purpose) : null,
    model: item.model ? String(item.model) : null,
    prompt_version: item.prompt_version ? String(item.prompt_version) : null,
    input_tokens: Number(item.input_tokens ?? 0),
    output_tokens: Number(item.output_tokens ?? 0),
    cost: costOf(item.cost, item.currency, item.cost_basis),
  }));

  const priced = summaries.filter((step) => step.cost);
  const currencies = new Set(priced.map((step) => step.cost!.currency));
  // 只有“真的调过模型、却没拿到价格”的步骤才算未知；确定性阶段本来就没有费用。
  const unpriced = steps.filter((item) => item.receipt_id && item.cost === null).length;
  // 没有计费调用、有调用没价格、或混了币种时都给 null，页面显示 unknown/无计费，不显示 0 元。
  const cost = unpriced > 0 || currencies.size > 1 || priced.length === 0 ? null : { amount: priced.reduce((sum, step) => sum + step.cost!.amount, 0), currency: [...currencies][0]! };

  const paused = summaries.find((step) => step.status === "paused_budget");
  const waiting = summaries.find((step) => step.status === "waiting_input");
  const failed = summaries.find((step) => step.status === "failed");
  const pausedReason = paused
    ? `预算或调用次数用完（${paused.error_code ?? "budget_paused"}），已停在「${paused.stage}」阶段`
    : waiting
      ? `缺少作者材料，等待补充（${waiting.stage}）`
      : failed
        ? `「${failed.stage}」阶段失败：${failed.error_code ?? "未知原因"}`
        : null;

  return {
    run,
    steps: summaries,
    total_tokens: summaries.reduce((sum, step) => sum + step.input_tokens + step.output_tokens, 0),
    cost,
    paused_reason: pausedReason,
  };
}

export interface RunListItem {
  run: RunRow;
  stages_done: number;
  total_tokens: number;
  status: TaskState;
}

/** 最近的运行列表。 */
export async function listRuns(db: Db, limit = 20): Promise<RunListItem[]> {
  const rows = await db`
    select r.*, r.business_date::text as business_date,
           (select count(*)::int from waibu_steps s where s.run_id = r.id and s.status = 'succeeded') as done,
           (select coalesce(sum(coalesce(nullif(rc.usage->>'prompt_tokens','')::numeric,0) + coalesce(nullif(rc.usage->>'completion_tokens','')::numeric,0)), 0)::int
              from waibu_steps s join receipts rc on rc.id = s.receipt_id where s.run_id = r.id) as tokens
    from waibu_runs r
    order by r.created_at desc
    limit ${limit}`;
  return rows.map((item) => ({
    run: row(runRowSchema, item),
    stages_done: Number(item.done ?? 0),
    total_tokens: Number(item.tokens ?? 0),
    status: item.status as TaskState,
  }));
}

/** 恢复运行时可做的事：只补未成功的阶段，不重跑已成功的。 */
export function resumableStages(steps: readonly StepSummary[]): Stage[] {
  const succeeded = new Set(steps.filter((step) => step.status === "succeeded").map((step) => step.stage));
  return (["evidence", "outline", "draft", "check", "revise"] as Stage[]).filter((stage) => !succeeded.has(stage));
}

/** 面板允许展示的字段白名单：确保不会把请求体或密钥带到页面。 */
export const EXPOSED_STEP_FIELDS: readonly (keyof StepSummary)[] = ["stage", "status", "attempt", "started_at", "finished_at", "error_code", "purpose", "model", "prompt_version", "input_tokens", "output_tokens", "cost"];
