// 文章工作流编排：把证据、提纲、起草、自检、改稿串成一次 run。
//
// 编排只做三件事：算下一步该跑什么、按结果推进 run 状态、把任务交给队列。
// 判断“哪一步还没完成”只看阶段记录，不看重试次数或内存状态——进程重启后同样算得出来。
import { sql, type Db } from "@aihot/backend/db";
import { PIPELINE_VERSION, type Stage } from "../../contracts/pipeline.ts";
import type { TaskState } from "../../contracts/states.ts";
import type { PipelineJob } from "../../contracts/jobs.ts";
import { createRun, findRun, listSteps, setRunStatus, type CreateRunInput } from "../store/runs.ts";
import { stageInputHash } from "../../contracts/pipeline.ts";

export interface PlannedStage {
  stage: Stage;
  input_hash: string;
}

export interface PendingPlan {
  /** 现在就可以入队的阶段：跳过已成功与在跑的，遇到失败/暂停就停，避免越级执行。 */
  pending: PlannedStage[];
  /** 还没成功的全部阶段（含被卡住的那个），按顺序，用于页面显示“还剩什么”。 */
  remaining: PlannedStage[];
  /** 卡在某个阶段（失败或预算暂停），恢复从这里开始。 */
  blocked_at: Stage | null;
  /** 全部阶段都成功了。 */
  done: boolean;
}

/**
 * 从阶段记录算出还需要跑什么。规则：
 * - 已成功的阶段跳过（同样的输入不重做）；
 * - 遇到失败、暂停、等待输入就停下，不越过它去跑后面的；
 * - 队列里正在跑的那个阶段也不算完成，但不要重复入队。
 */
export function planPending(
  planned: readonly PlannedStage[],
  steps: ReadonlyArray<{ stage: Stage; input_hash: string; status: TaskState }>,
): PendingPlan {
  const succeeded = new Set(steps.filter((step) => step.status === "succeeded").map((step) => `${step.stage}:${step.input_hash}`));
  const running = new Set(steps.filter((step) => step.status === "running" || step.status === "queued").map((step) => `${step.stage}:${step.input_hash}`));
  const blocked = new Map<Stage, TaskState>();
  for (const step of steps) {
    if (step.status === "failed" || step.status === "paused_budget" || step.status === "waiting_input") blocked.set(step.stage, step.status);
  }

  const pending: PlannedStage[] = [];
  const remaining: PlannedStage[] = [];
  let blockedAt: Stage | null = null;
  let stopped = false;

  for (const stage of planned) {
    const key = `${stage.stage}:${stage.input_hash}`;
    if (succeeded.has(key)) continue;
    remaining.push(stage);
    if (stopped) continue;
    if (running.has(key)) continue;
    pending.push(stage);
    if (blocked.has(stage.stage)) {
      blockedAt = stage.stage;
      stopped = true;
    }
  }

  return { pending, remaining, blocked_at: blockedAt, done: remaining.length === 0 };
}

/** 读取库里这次的阶段记录，算出下一步。 */
export async function planRun(db: Db, runId: string, planned: readonly PlannedStage[]): Promise<PendingPlan> {
  const steps = await listSteps(db, runId);
  return planPending(planned, steps.map((step) => ({ stage: step.stage, input_hash: step.input_hash, status: step.status })));
}

/** 按阶段结果推进 run 状态：有一个暂停就是暂停，有一个失败就是失败，全成功才算成功。 */
export async function refreshRunStatus(db: Db, runId: string): Promise<{ status: TaskState; pending: Stage[] }> {
  const steps = await listSteps(db, runId);
  const paused = steps.find((step) => step.status === "paused_budget");
  const waiting = steps.find((step) => step.status === "waiting_input");
  const failed = steps.find((step) => step.status === "failed");
  const running = steps.find((step) => step.status === "running" || step.status === "queued");

  const status: TaskState = paused ? "paused_budget" : waiting ? "waiting_input" : failed ? "failed" : running ? "running" : steps.length > 0 ? "succeeded" : "queued";
  await setRunStatus(db, runId, status, failed?.error_code ?? null);
  return { status, pending: steps.filter((step) => step.status !== "succeeded").map((step) => step.stage) };
}

/** 一个业务日只建一次定时 run；已有就复用，重复触发不会产生第二个。 */
export async function ensureDailyRun(db: Db, input: Omit<CreateRunInput, "pipeline_version"> & { pipeline_version?: string }) {
  const version = input.pipeline_version ?? PIPELINE_VERSION;
  const [existing] = await db`
    select *, business_date::text as business_date from waibu_runs
    where mode = 'scheduled' and business_date = ${input.business_date} and pipeline_version = ${version} limit 1`;
  if (existing) return { run: await findRun(db, String(existing.id)), created: false as const };
  return { run: await createRun(db, { ...input, pipeline_version: version }), created: true as const };
}

/** 手动重跑与故障恢复：前者换新的 attemptTag（回执不复用），后者沿用已有输入。 */
export function jobFor(planned: PlannedStage, input: { run_id: string; draft_id: string | null; base_revision_id: string | null; attempt?: number }): PipelineJob {
  return {
    run_id: input.run_id,
    stage: planned.stage,
    draft_id: input.draft_id,
    base_revision_id: input.base_revision_id,
    input_hash: planned.input_hash,
    attempt: input.attempt ?? 1,
  };
}

/** 按阶段列表算出各自的输入键；同一个 run 内阶段顺序固定。 */
export function planStages(parts: {
  policy_version: string;
  prompt_version: string;
  model_config_hash: string;
  evidence_hashes: readonly string[];
  base_revision_id: string | null;
  feedback_ids: readonly string[];
  stages?: readonly Stage[];
}): PlannedStage[] {
  return (parts.stages ?? ["evidence", "outline", "draft", "check", "revise"]).map((stage) => ({
    stage,
    input_hash: stageInputHash({
      stage,
      policy_version: parts.policy_version,
      prompt_version: parts.prompt_version,
      model_config_hash: parts.model_config_hash,
      evidence_hashes: parts.evidence_hashes,
      base_revision_id: parts.base_revision_id,
      feedback_ids: parts.feedback_ids,
    }),
  }));
}

export { sql };
