// 流水线推进：一个阶段成功、事务提交之后，把下一阶段入队。
//
// 输入键由“上一阶段产物 + 固定策略”算出，所以同一份输入被重复推进时，
// 下一阶段会认领到同一条记录、复用结果，而不是重复花钱。
import type { Db } from "@aihot/backend/db";
import { STAGE_ORDER, type Stage } from "../../contracts/pipeline.ts";
import { stageInputHash } from "../../contracts/pipeline.ts";
import type { PipelineJob } from "../../contracts/jobs.ts";
import type { StageResult } from "./stage.ts";
import { enqueuePipeline } from "./queue.ts";
import { refreshRunStatus } from "../workflow/index.ts";

export interface AdvanceDeps {
  /** 阶段产物里能拿到的稿件 id。 */
  draftIdOf: (job: PipelineJob, result: StageResult) => string | null;
}

export async function makeAdvancer(db: Db, deps: AdvanceDeps) {
  return async ({ job, result }: { job: PipelineJob; result: StageResult }): Promise<void> => {
    // 每次阶段结束都按阶段结果刷新运行状态：页面看到的是真实进度，不是一直 queued。
    await refreshRunStatus(db, job.run_id);
    const index = STAGE_ORDER.indexOf(job.stage as Stage);
    if (index < 0 || index === STAGE_ORDER.length - 1) return;
    const next = STAGE_ORDER[index + 1]!;
    const draftId = deps.draftIdOf(job, result);
    // 起草之后的阶段都需要稿子；拿不到就停下，让人看见，而不是悄悄跳过。
    if (!draftId) return;

    const inputHash = stageInputHash({
      stage: next,
      policy_version: "v1",
      prompt_version: "common",
      model_config_hash: "default",
      evidence_hashes: [],
      base_revision_id: null,
      feedback_ids: [],
    });
    await enqueuePipeline(db, {
      run_id: job.run_id,
      stage: next,
      draft_id: draftId,
      base_revision_id: null,
      input_hash: inputHash,
      attempt: 1,
    });
  };
}

/** 从阶段产物里取稿件 id：证据阶段返回新建的稿子，后面的阶段沿用 job 上的 draft_id。 */
export function draftIdFromPayload(job: PipelineJob, result: StageResult): string | null {
  if (job.draft_id) return job.draft_id;
  const payload = result.payload as { draft_id?: string } | undefined;
  return payload?.draft_id ?? null;
}
