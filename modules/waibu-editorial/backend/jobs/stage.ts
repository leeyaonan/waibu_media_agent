// 阶段执行：认领 → 执行 → 结账。队列至少按“可重复投递”设计，这里负责让重复投递变成幂等：
//
// 1. 同一 (run, stage, input_hash) 已有成功的步骤，直接复用，不再执行；
// 2. 认领用唯一约束抢占：并发投递只有一方能插入当前 attempt，另一方让开；
// 3. 业务写入与“步骤成功”在同一个事务里提交，进程在提交前被杀则全部回滚，重投时重来一次，
//    不会出现“写了稿子但步骤没结账”或“步骤成功但稿子没落库”。
import { sql, type Tx } from "@aihot/backend/db";
import type { PipelineJob } from "../../contracts/jobs.ts";
import type { Stage } from "../../contracts/pipeline.ts";
import { stepRowSchema, type StepRow } from "../../contracts/entities.ts";
import { finishStep, findSucceededStep } from "../store/runs.ts";
import { row } from "../store/rows.ts";

export interface StageResult {
  /** 产物引用（表名 + 主键），写进步骤记录，便于审计和复用。 */
  output_ref: string;
  /** 模型回执 id；确定性阶段为 null。 */
  receipt_id?: number | null;
}

export interface StageContext {
  db: Tx;
  job: PipelineJob;
}

export type StageHandler = (context: StageContext) => Promise<StageResult>;

const handlers = new Map<Stage, StageHandler>();

/** 各任务在模块装配时注册自己的阶段实现；没注册的阶段会明确报错，而不是静默跳过。 */
export function registerStageHandler(stage: Stage, handler: StageHandler): void {
  handlers.set(stage, handler);
}

export function registeredStages(): Stage[] {
  return [...handlers.keys()];
}

export type PipelineOutcome = "reused" | "executed";

type Claim =
  | { kind: "reused"; step: StepRow }
  | { kind: "busy" }
  | { kind: "claimed"; step: StepRow };

/** 超过这个时长还挂在 running 的步骤，视为执行它的进程已经没了。 */
const STALE_RUNNING = "10 minutes";

/**
 * 认领当前 attempt。同一输入的认领在一个事务里串行：
 * 先找成功的记录（复用），再清理僵尸 running，最后才插入新尝试。
 * 并发投递时只有一方拿到 claimed，另一方得到 busy 并让队列稍后重试。
 */
async function claim(job: PipelineJob): Promise<Claim> {
  const key = `${job.run_id}:${job.stage}:${job.input_hash}`;
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

    const [done] = await tx`
      select * from waibu_steps
      where run_id = ${job.run_id} and stage = ${job.stage} and input_hash = ${job.input_hash} and status = 'succeeded'
      limit 1`;
    if (done) return { kind: "reused", step: row(stepRowSchema, done) };

    // 进程崩溃留下的 running 记录不会自己结束；过了执行窗口就标为失败，让新的尝试接上。
    await tx`
      update waibu_steps set status = 'failed', error_code = 'attempt_interrupted', updated_at = now()
      where run_id = ${job.run_id} and stage = ${job.stage} and input_hash = ${job.input_hash}
        and status = 'running' and updated_at < now() - ${STALE_RUNNING}::interval`;

    const [running] = await tx`
      select id from waibu_steps
      where run_id = ${job.run_id} and stage = ${job.stage} and input_hash = ${job.input_hash} and status = 'running'
      limit 1`;
    if (running) return { kind: "busy" };

    const [claimed] = await tx`
      insert into waibu_steps (run_id, stage, input_hash, attempt, status)
      select ${job.run_id}, ${job.stage}, ${job.input_hash}, coalesce(max(attempt), 0) + 1, 'running'
      from waibu_steps
      where run_id = ${job.run_id} and stage = ${job.stage} and input_hash = ${job.input_hash}
      returning *`;
    return { kind: "claimed", step: row(stepRowSchema, claimed) };
  }) as Promise<Claim>;
}

/**
 * 执行一次阶段任务。reused 表示结果已在库里（本次什么都没做），executed 表示这次真的跑了；
 * 另一个 worker 正在跑同一输入时抛错，交给队列重试，绝不谎报成功。
 */
export async function executePipelineJob(job: PipelineJob): Promise<PipelineOutcome> {
  const done = await findSucceededStep(sql, job.run_id, job.stage, job.input_hash);
  if (done) return "reused";

  const handler = handlers.get(job.stage);
  if (!handler) throw new Error(`阶段 ${job.stage} 还没有实现`);

  const claimed = await claim(job);
  if (claimed.kind === "reused") return "reused";
  // 别人正在跑同一份输入：让队列按重试策略稍后再来，不能假装成功。
  if (claimed.kind === "busy") throw new Error("stage busy: another attempt is running");
  const step = claimed.step;

  try {
    await sql.begin(async (tx) => {
      const result = await handler({ db: tx, job });
      await finishStep(tx, step.id, "succeeded", { output_ref: result.output_ref, receipt_id: result.receipt_id ?? null });
    });
    return "executed";
  } catch (error) {
    // 事务已回滚，业务写入不会留下半成品；这里单独记失败原因，供页面和排障读。
    const code = error instanceof Error ? error.name.slice(0, 64) : "unknown";
    await finishStep(sql, step.id, "failed", { error_code: code }).catch(() => undefined);
    throw error;
  }
}
