// 内容自检与有限修复。三条边界：
// 1. 模型自检只是“提出问题”，不等于“已经核实”——能不能通过由确定性检查说了算；
// 2. 修复循环有上限（默认 2 轮），仍不满足就转人工处理，不做无限自我反思；
// 3. 自检永远不能把稿子变成“已批准”，那一步只有作者能做。
import { z } from "zod";
import type { Draft } from "../drafting/index.ts";
import { validateDraft, type DraftContext } from "../drafting/index.ts";
import { BUDGET_DEFAULTS } from "../../contracts/pipeline.ts";

export const ISSUE_KINDS = ["fact", "style", "structure", "experience", "conflict"] as const;
export const SEVERITIES = ["blocking", "warning"] as const;

export const issueSchema = z.object({
  block_id: z.string().max(64).default(""),
  kind: z.enum(ISSUE_KINDS),
  severity: z.enum(SEVERITIES),
  message: z.string().min(1).max(500),
});

/** 模型自检的输出。它只提供问题清单，不提供“通过”这个结论。 */
export const checkSchema = z.object({
  issues: z.array(issueSchema).max(50).default([]),
  summary: z.string().max(1000).default(""),
});

export type Issue = z.infer<typeof issueSchema>;
export type CheckResult = z.infer<typeof checkSchema>;

/** 自检阶段的结果：通过与否、阻断项、警告。 */
export interface QualityReport {
  blocking: Issue[];
  warnings: Issue[];
  ok: boolean;
}

/** 确定性检查转成 issue，与模型提的问题合并去重。 */
export function deterministicIssues(draft: Draft, context: DraftContext): Issue[] {
  const check = validateDraft(draft, context);
  return [
    ...check.problems.map((message) => ({ block_id: "", kind: "fact" as const, severity: "blocking" as const, message })),
    ...check.warnings.map((message) => ({ block_id: "", kind: "structure" as const, severity: "warning" as const, message })),
  ];
}

/**
 * 合并自检结果。确定性检查的阻断项不能被模型“忽略”掉：
 * 即使模型说没问题，数字漂移或没有依据的第一人称仍然阻断。
 */
export function mergeChecks(model: CheckResult, deterministic: readonly Issue[]): QualityReport {
  const all = [...deterministic, ...model.issues];
  const seen = new Set<string>();
  const unique = all.filter((issue) => {
    const key = `${issue.kind}:${issue.block_id}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const blocking = unique.filter((issue) => issue.severity === "blocking");
  return { blocking, warnings: unique.filter((issue) => issue.severity === "warning"), ok: blocking.length === 0 };
}

export type RepairOutcome = "passed" | "on_hold";

export interface RepairRound {
  round: number;
  blocking: number;
}

export interface RepairLoopResult {
  /** passed：没有阻断项；on_hold：到上限仍有阻断项，转人工。 */
  status: RepairOutcome;
  draft: Draft;
  report: QualityReport;
  rounds: RepairRound[];
  /** 给作者看的问题快照，转人工后仍可追。 */
  remaining: Issue[];
}

export interface RepairLoopInput {
  draft: Draft;
  context: DraftContext;
  /** 跑一次自检（模型 + 确定性），返回报告。 */
  check: (draft: Draft) => Promise<QualityReport>;
  /** 按阻断项改一版；拿不到有效修订时返回 null，循环立即停止。 */
  repair: (draft: Draft, issues: readonly Issue[]) => Promise<Draft | null>;
  maxRounds?: number;
}

/**
 * 有限修复循环。每轮先检后修；修不动或到上限就停，保留最后一版和剩余问题。
 * 任何情况下都不会返回“已批准”——这里没有那个状态。
 */
export async function checkWithRepair(input: RepairLoopInput): Promise<RepairLoopResult> {
  const maxRounds = input.maxRounds ?? BUDGET_DEFAULTS.max_repair_rounds;
  let draft = input.draft;
  let report = await input.check(draft);
  const rounds: RepairRound[] = [];

  let round = 0;
  while (!report.ok && round < maxRounds) {
    round += 1;
    const revised = await input.repair(draft, report.blocking);
    if (!revised) {
      rounds.push({ round, blocking: report.blocking.length });
      break;
    }
    draft = revised;
    report = await input.check(draft);
    rounds.push({ round, blocking: report.blocking.length });
  }

  return {
    status: report.ok ? "passed" : "on_hold",
    draft,
    report,
    rounds,
    remaining: report.blocking,
  };
}
