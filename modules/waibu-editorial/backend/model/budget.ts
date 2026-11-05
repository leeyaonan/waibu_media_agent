// 单篇稿件的用量与费用。费用只报知道的：供应商没给价格就显示 unknown，绝不填 0 元冒充免费。
import type { Db } from "@aihot/backend/db";
import { BUDGET_DEFAULTS } from "../../contracts/pipeline.ts";
import { EditorialError } from "../../contracts/errors.ts";

export interface DraftUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  /** 已知费用合计；有任一调用价格未知时为 null。 */
  cost: { amount: number; currency: string } | null;
  /** 有多少次调用没拿到价格。 */
  unknown_cost_calls: number;
}

/** 一篇稿件已经花掉的调用次数、token 与费用，按步骤关联的模型回执统计。 */
export async function draftUsage(db: Db, draftId: string): Promise<DraftUsage> {
  const [totals] = await db`
    select
      count(*)::int as calls,
      coalesce(sum(nullif(r.usage->>'prompt_tokens', '')::numeric), 0)::float8 as input_tokens,
      coalesce(sum(nullif(r.usage->>'completion_tokens', '')::numeric), 0)::float8 as output_tokens,
      coalesce(sum(case when r.cost is null then 0 else r.cost end), 0)::float8 as cost,
      count(*) filter (where r.cost is null)::int as unknown_cost_calls,
      count(distinct r.currency) filter (where r.currency is not null)::int as currencies,
      min(r.currency) filter (where r.currency is not null) as currency
    from waibu_steps s
    join receipts r on r.id = s.receipt_id
    where s.draft_id = ${draftId}`;

  const unknown = Number(totals?.unknown_cost_calls ?? 0);
  const currencies = Number(totals?.currencies ?? 0);
  return {
    calls: Number(totals?.calls ?? 0),
    input_tokens: Number(totals?.input_tokens ?? 0),
    output_tokens: Number(totals?.output_tokens ?? 0),
    // 有未知价格或混了币种时，合计没有意义，交给页面显示 unknown。
    cost: unknown > 0 || currencies !== 1 ? null : { amount: Number(totals?.cost ?? 0), currency: String(totals?.currency ?? "") },
    unknown_cost_calls: unknown,
  };
}

/**
 * 发请求前检查单稿额度。超了就抛 budget_paused，让阶段标成暂停等人工放行，
 * 而不是继续调用把一个月的预算烧在一天里。
 */
export async function assertWithinBudget(db: Db, draftId: string | null): Promise<void> {
  if (!draftId) return;
  const usage = await draftUsage(db, draftId);
  if (usage.output_tokens >= BUDGET_DEFAULTS.max_output_tokens_per_draft) {
    throw new EditorialError("budget_paused", `这篇稿子已达到输出 token 上限（${Math.round(usage.output_tokens)}）`, {
      output_tokens: usage.output_tokens,
      limit: BUDGET_DEFAULTS.max_output_tokens_per_draft,
    });
  }
  if (usage.calls >= BUDGET_DEFAULTS.max_calls_per_draft) {
    throw new EditorialError("budget_paused", `这篇稿子已达到调用次数上限（${usage.calls}）`, { calls: usage.calls, limit: BUDGET_DEFAULTS.max_calls_per_draft });
  }
}

/** 费用展示：知道就带币种，不知道就说不知道，不显示 0。 */
export function formatCost(cost: DraftUsage["cost"]): string {
  if (!cost) return "unknown";
  return `${cost.currency} ${cost.amount.toFixed(2)}`;
}
