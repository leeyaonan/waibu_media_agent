// 运行与阶段的读写。所有函数接收调用方的 db（可能是事务），自己不开事务：
// API 在事务里落库并入队，worker 在自己的事务里推进阶段，两边复用同一套语句。
import type { Db } from "@aihot/backend/db";
import { runRowSchema, stepRowSchema, type RunRow, type StepRow } from "../../contracts/entities.ts";
import type { Stage } from "../../contracts/pipeline.ts";
import type { TaskState } from "../../contracts/states.ts";
import { row, rows } from "./rows.ts";

export interface CreateRunInput {
  business_date: string;
  mode: "scheduled" | "manual";
  pipeline_version: string;
  input_hash: string;
  /** 创建时生效的配置版本；不填表示没记录。 */
  config_version?: number | null;
}

/** 新建运行。定时运行按业务日期与管线版本唯一，重复触发会撞唯一约束并抛错。 */
export async function createRun(db: Db, input: CreateRunInput): Promise<RunRow> {
  const [created] = await db`
    insert into waibu_runs (business_date, mode, pipeline_version, input_hash, config_version)
    values (${input.business_date}, ${input.mode}, ${input.pipeline_version}, ${input.input_hash}, ${input.config_version ?? null})
    returning *, business_date::text as business_date`;
  return row(runRowSchema, created);
}

export async function findRun(db: Db, runId: string): Promise<RunRow | null> {
  const [found] = await db`select *, business_date::text as business_date from waibu_runs where id = ${runId}`;
  return found ? row(runRowSchema, found) : null;
}

export async function findScheduledRun(db: Db, businessDate: string, pipelineVersion: string): Promise<RunRow | null> {
  const [found] = await db`
    select *, business_date::text as business_date from waibu_runs
    where mode = 'scheduled' and business_date = ${businessDate} and pipeline_version = ${pipelineVersion}`;
  return found ? row(runRowSchema, found) : null;
}

export async function setRunStatus(db: Db, runId: string, status: TaskState, errorCode: string | null = null): Promise<RunRow> {
  const [updated] = await db`
    update waibu_runs set status = ${status}, error_code = ${errorCode}, updated_at = now()
    where id = ${runId}
    returning *, business_date::text as business_date`;
  return row(runRowSchema, updated);
}

export interface StartStepInput {
  run_id: string;
  stage: Stage;
  input_hash: string;
  attempt?: number;
}

/**
 * 声明一个阶段开始执行。同一输入已在执行或已成功时，唯一约束会拦住重复插入；
 * 调用方应先查已有的 step（findReusableStep），而不是靠捕获异常做流程控制。
 */
export async function startStep(db: Db, input: StartStepInput): Promise<StepRow> {
  const [created] = await db`
    insert into waibu_steps (run_id, stage, input_hash, attempt, status)
    values (${input.run_id}, ${input.stage}, ${input.input_hash}, ${input.attempt ?? 1}, 'running')
    on conflict (run_id, stage, input_hash, attempt) do update set updated_at = now()
    returning *`;
  return row(stepRowSchema, created);
}

/** 同一阶段同一输入已经成功的记录；恢复时直接复用它的产物，不再调用模型。 */
export async function findSucceededStep(db: Db, runId: string, stage: Stage, inputHash: string): Promise<StepRow | null> {
  const [found] = await db`
    select * from waibu_steps
    where run_id = ${runId} and stage = ${stage} and input_hash = ${inputHash} and status = 'succeeded'
    order by attempt desc limit 1`;
  return found ? row(stepRowSchema, found) : null;
}

export async function finishStep(
  db: Db,
  stepId: string,
  status: TaskState,
  patch: { receipt_id?: number | null; output_ref?: string | null; error_code?: string | null } = {},
): Promise<StepRow> {
  const [updated] = await db`
    update waibu_steps set
      status = ${status},
      receipt_id = coalesce(${patch.receipt_id ?? null}, receipt_id),
      output_ref = coalesce(${patch.output_ref ?? null}, output_ref),
      error_code = ${patch.error_code ?? null},
      updated_at = now()
    where id = ${stepId}
    returning *`;
  return row(stepRowSchema, updated);
}

export async function listSteps(db: Db, runId: string): Promise<StepRow[]> {
  const found = await db`select * from waibu_steps where run_id = ${runId} order by created_at, stage`;
  return rows(stepRowSchema, found);
}
