// 私人工作台的 HTTP 契约（/api/admin/editorial/*）。全部接口都要求管理员会话，写请求另要 CSRF。
// 约定：
// - 写请求乐观并发：带 expected_revision_id / expected_lock_version，冲突返回 409 conflict_version；
// - 重复提交带 Idempotency-Key，服务端复用第一次的结果而不是再执行一次；
// - API 只落库并入队，返回 202 + job_id，不同步等模型。
import { z } from "zod";
import { draftRowSchema, feedbackRowSchema, revisionRowSchema, claimRowSchema, approvalRowSchema, exportRowSchema, topicRowSchema, runRowSchema, uuidSchema, hashSchema, isoDateTimeSchema, businessDateSchema } from "./entities.ts";

/** 模块所有私人接口共用前缀。 */
export const API_PREFIX = "/api/admin/editorial";

/** 重复提交去重的请求头，服务端按“用户 + 路径 + 键 + 请求体 hash”记录首次结果。 */
export const IDEMPOTENCY_HEADER = "idempotency-key";

/** 列表分页：游标是上一页最后一条的排序键，不用偏移量，避免翻页时数据错位。 */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
  });

/** POST /runs：手动重跑与故障恢复是两条不同的命令，恢复不产生新的业务身份。 */
export const createRunRequestSchema = z
  .object({
    kind: z.enum(["rerun", "recover"]),
    /** 恢复时指定要接着跑的那篇稿子。 */
    draft_id: uuidSchema.optional(),
    /** 补跑最近一个业务日；更早的日期需要人工明确指定并留痕。 */
    business_date: businessDateSchema.optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => v.kind !== "recover" || v.draft_id !== undefined, { message: "恢复必须指定 draft_id", path: ["draft_id"] });

export const createRunResponseSchema = z.object({
  run_id: uuidSchema,
  job_id: z.string().nullable(),
  status: z.enum(["queued", "running"]),
});

/** POST /drafts/:id/revisions：作者直接编辑，产生新版本并重新自检。 */
export const saveRevisionRequestSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(1000),
  body: z.string().min(1).max(200_000),
  captions: z.record(z.string(), z.string().max(500)).default({}),
  cover_asset_hash: hashSchema.nullable().default(null),
  asset_hashes: z.array(hashSchema).default([]),
  /** 基于哪个版本改；不是当前版本时返回 409，不覆盖作者最新稿。 */
  expected_revision_id: uuidSchema,
  expected_lock_version: z.number().int().min(1),
});

export const revisionResponseSchema = z.object({
  revision: revisionRowSchema,
  /** 新版本是否需要重新自检（总是需要；字段留给页面展示状态）。 */
  requeued: z.boolean(),
  job_id: z.string().nullable(),
});

/** POST /drafts/:id/feedback：批注 + 基于指定版本改稿。 */
export const feedbackRequestSchema = z.object({
  text: z.string().min(1).max(4000),
  /** 段落级意见；为空表示整篇。 */
  block_id: z.string().min(1).max(64).optional(),
  expected_revision_id: uuidSchema,
});

export const feedbackResponseSchema = z.object({
  feedback: feedbackRowSchema,
  job_id: z.string().nullable(),
});

/** POST /drafts/:id/approvals：人工批准，绑定 revision + content_hash。 */
export const approveRequestSchema = z.object({
  expected_revision_id: uuidSchema,
  expected_content_hash: hashSchema,
  expected_lock_version: z.number().int().min(1),
  note: z.string().max(500).optional(),
});

export const approveResponseSchema = z.object({
  approval: approvalRowSchema,
  draft: draftRowSchema,
});

export const rejectRequestSchema = z.object({
  reason: z.string().min(1).max(500),
  expected_revision_id: uuidSchema,
  expected_lock_version: z.number().int().min(1),
});

/** POST /drafts/:id/exports：只对当前有效批准版本生成发布包。 */
export const exportRequestSchema = z.object({
  expected_revision_id: uuidSchema,
  expected_approval_id: uuidSchema,
});

export const exportResponseSchema = z.object({
  export: exportRowSchema,
  job_id: z.string().nullable(),
});

/** POST /drafts/:id/publications：作者明确登记发布事实，不推断。 */
export const publicationRequestSchema = z.object({
  published_at: isoDateTimeSchema,
  url: z.string().url().max(2000).optional(),
  expected_revision_id: uuidSchema,
});

/** GET /drafts/:id 的响应：审核页需要的一切，一次给全。 */
export const draftDetailResponseSchema = z.object({
  draft: draftRowSchema,
  revision: revisionRowSchema,
  /** 正文中每个段落引用的事实。 */
  claims: z.array(claimRowSchema),
  /** 本稿全部历史意见（含已落实的）。 */
  feedback: z.array(feedbackRowSchema),
  /** 当前有效批准。 */
  approval: approvalRowSchema.nullable(),
  /** 可直接下载的最近一次成功导出。 */
  export: exportRowSchema.nullable(),
});

export const draftListResponseSchema = pageSchema(
  z.object({
    draft: draftRowSchema,
    topic: topicRowSchema,
    title: z.string(),
    /** 自检阻断项数量；0 表示可以批准。 */
    blocking_issues: z.number().int().min(0),
  }),
);

export const topicListResponseSchema = pageSchema(
  z.object({
    topic: topicRowSchema,
    /** 已生成的稿子；还没起草时为空。 */
    draft_id: uuidSchema.nullable(),
    evidence_count: z.number().int().min(0),
  }),
);

export const runDetailResponseSchema = z.object({
  run: runRowSchema,
  steps: z.array(
    z.object({
      stage: z.enum(["evidence", "outline", "draft", "check", "revise"]),
      status: z.enum(["queued", "running", "succeeded", "failed", "paused_budget", "waiting_input", "cancelled"]),
      attempt: z.number().int().min(1),
      started_at: isoDateTimeSchema.nullable(),
      finished_at: isoDateTimeSchema.nullable(),
      error_code: z.string().nullable(),
      /** 该阶段消耗的 token；确定性阶段为 0。 */
      total_tokens: z.number().int().min(0),
    }),
  ),
});

export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;
export type SaveRevisionRequest = z.infer<typeof saveRevisionRequestSchema>;
export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;
export type ApproveRequest = z.infer<typeof approveRequestSchema>;
export type RejectRequest = z.infer<typeof rejectRequestSchema>;
export type ExportRequest = z.infer<typeof exportRequestSchema>;
export type PublicationRequest = z.infer<typeof publicationRequestSchema>;
export type DraftDetailResponse = z.infer<typeof draftDetailResponseSchema>;
