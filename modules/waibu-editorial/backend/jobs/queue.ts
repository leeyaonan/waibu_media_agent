// 模块队列定义。生产者（API）用 enqueuePipeline / enqueueExport，
// 消费者由 worker 通过 serverModules().queues 注册（workModuleQueues）。
//
// 队列只管调度：重试策略、过期时间在这里定；幂等与恢复语义在 stage.ts / export.ts 里。
import { enqueueOn } from "@aihot/backend/jobs/queue";
import type { Db } from "@aihot/backend/db";
import { defineQueue, type ModuleQueue } from "@aihot/backend/modules";
import { WAIBU_QUEUES, type ExportJob, type PipelineJob } from "../../contracts/jobs.ts";
import { executePipelineJob } from "./stage.ts";

/** 单次只取一个任务：阶段任务重（模型调用），批量执行只会放大失败面。 */
export const PIPELINE_QUEUE: ModuleQueue<PipelineJob> = defineQueue<PipelineJob>({
  name: WAIBU_QUEUES.pipeline,
  options: { policy: "short", retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  worker: { batchSize: 1 },
  run: async (jobs) => {
    for (const job of jobs) await executePipelineJob(job);
  },
});

export type ExportHandler = (job: ExportJob) => Promise<{ output_ref: string }>;

let exportHandler: ExportHandler | null = null;

/** 导出任务的具体实现由发布包任务注册；没注册时队列明确失败，而不是返回一个假成功。 */
export function registerExportHandler(handler: ExportHandler): void {
  exportHandler = handler;
}

export const EXPORT_QUEUE: ModuleQueue<ExportJob> = defineQueue<ExportJob>({
  name: WAIBU_QUEUES.export,
  options: { policy: "short", retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 900 },
  worker: { batchSize: 1 },
  run: async (jobs) => {
    for (const job of jobs) {
      if (!exportHandler) throw new Error("导出任务还没有实现");
      await exportHandler(job);
    }
  },
});

export const WAIBU_MODULE_QUEUES: ModuleQueue<never>[] = [PIPELINE_QUEUE, EXPORT_QUEUE] as unknown as ModuleQueue<never>[];

/**
 * 事务内入队：阶段任务和触发它的业务写入一起提交，
 * 不会出现“稿子回滚了但任务还在队列里”。
 */
export async function enqueuePipeline(tx: Db, job: PipelineJob): Promise<string | null> {
  return enqueueOn(PIPELINE_QUEUE, job, {}, tx);
}

export async function enqueueExport(tx: Db, job: ExportJob): Promise<string | null> {
  return enqueueOn(EXPORT_QUEUE, job, {}, tx);
}
