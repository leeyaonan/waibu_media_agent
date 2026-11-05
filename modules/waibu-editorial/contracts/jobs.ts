// 队列载荷与阶段键。生产者（API）与消费者（worker）共用这里的类型，载荷不会在两边漂移。
//
// 可重复投递是既定前提：任务可能被重投多次，业务侧靠唯一约束、输入 hash 和版本比较保证幂等，
// 不承诺付费请求绝对只执行一次（见上游 receipts.ts 的未知结果放行）。
import { z } from "zod";
import { STAGES, hashSchema, uuidSchema } from "./entities.ts";

/** 模块自有队列名，必须带模块前缀，避免和引擎队列冲突。 */
export const WAIBU_QUEUES = {
  pipeline: "waibu.pipeline",
  export: "waibu.export",
} as const;

export type WaibuQueueName = (typeof WAIBU_QUEUES)[keyof typeof WAIBU_QUEUES];

/** 一次阶段执行。stage 决定 worker 走哪段逻辑，input_hash 决定“同样的输入不重做”。 */
export const pipelineJobSchema = z.object({
  run_id: uuidSchema,
  stage: z.enum(STAGES),
  /** 证据与选题阶段没有稿子。 */
  draft_id: uuidSchema.nullable(),
  /** 生成类阶段记录基准版本；回写时比较当前版本，旧结果不覆盖新稿。 */
  base_revision_id: uuidSchema.nullable(),
  input_hash: hashSchema,
  attempt: z.number().int().min(1).default(1),
});

export type PipelineJob = z.infer<typeof pipelineJobSchema>;

export const exportJobSchema = z.object({
  export_id: uuidSchema,
});

export type ExportJob = z.infer<typeof exportJobSchema>;

/** 队列到载荷的映射，F05 注册队列时使用。 */
export interface WaibuJobData {
  "waibu.pipeline": PipelineJob;
  "waibu.export": ExportJob;
}

/** 按队列名做运行时校验，避免 API 手拼的载荷进队列后在 worker 里才发现字段不对。 */
export function parseJob<T extends WaibuQueueName>(queue: T, data: unknown): WaibuJobData[T] {
  return (queue === WAIBU_QUEUES.pipeline ? pipelineJobSchema.parse(data) : exportJobSchema.parse(data)) as WaibuJobData[T];
}
