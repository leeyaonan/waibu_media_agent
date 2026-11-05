// 数据实体契约：字段名与 SQL 列一致（snake_case），时间一律带时区的 ISO 8601 字符串。
// 物理建表由 F04 负责，这里定义的是逻辑形状；两边改动必须同步，测试会检查本文件与迁移的字段一致。
import { z } from "zod";
import { ARTICLE_STATES, TASK_STATES } from "./states.ts";
import { contentHash, normalizeRevisionContent } from "./content.ts";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, "不是合法的 UUID");
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u, "不是带时区的 ISO 8601 时间");
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "业务日期必须是 YYYY-MM-DD");
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/u, "不是 sha256: 前缀的摘要");

export const uuidSchema = uuid;
export const isoDateTimeSchema = iso;
export const businessDateSchema = businessDate;
export const hashSchema = hash;

/** 运行方式：定时任务与人工触发分开编号，补跑不会覆盖当天的定时记录。 */
export const RUN_MODES = ["scheduled", "manual"] as const;

export const runRowSchema = z.object({
  id: uuid,
  /** 北京时间业务日 YYYY-MM-DD。 */
  business_date: businessDate,
  mode: z.enum(RUN_MODES),
  pipeline_version: z.string().min(1).max(64),
  status: z.enum(TASK_STATES),
  /** 本次运行的输入摘要：来源集合、策略版本、模型配置等。 */
  input_hash: hash,
  error_code: z.string().max(64).nullable(),
  created_at: iso,
  updated_at: iso,
});

export const STAGES = ["evidence", "outline", "draft", "check", "revise"] as const;

export const stepRowSchema = z.object({
  id: uuid,
  run_id: uuid,
  stage: z.enum(STAGES),
  input_hash: hash,
  /** 同一阶段同一输入的第几次尝试；1 起。 */
  attempt: z.number().int().min(1),
  status: z.enum(TASK_STATES),
  /** 模型回执 id（providers/receipts.ts）；确定性阶段为 null。 */
  receipt_id: z.number().int().nullable(),
  /** 产物引用：表名 + 主键，便于审计。 */
  output_ref: z.string().max(200).nullable(),
  error_code: z.string().max(64).nullable(),
  created_at: iso,
  updated_at: iso,
});

/** 证据状态决定题材能不能自动写：缺证据只能出选题或等材料。 */
export const EVIDENCE_STATUSES = ["sufficient", "insufficient", "disputed"] as const;

export const topicRowSchema = z.object({
  id: uuid,
  run_id: uuid,
  /** AIHOT 侧的事件 id；一个事件可以派生多个不同角度的选题。 */
  story_ids: z.array(z.number().int().positive()).min(1),
  /** 本篇要回答的读者问题，不是标题。 */
  angle: z.string().min(1).max(500),
  reason: z.string().max(2000),
  evidence_status: z.enum(EVIDENCE_STATUSES),
  /** 同事件同角度的去重键，唯一约束落库。 */
  dedupe_key: z.string().min(1).max(200),
  created_at: iso,
});

export const EVIDENCE_RIGHTS = ["quotation", "public", "licensed", "unknown"] as const;

export const EVIDENCE_VALIDITY = ["valid", "changed", "withdrawn"] as const;

export const evidenceRowSchema = z.object({
  id: uuid,
  /** AIHOT 信源 id（引擎里是 text）。 */
  source_id: z.string().min(1).max(80),
  /** AIHOT 文章 id（引擎 articles.id 是 text，不是数字）；素材适配器写入。 */
  article_id: z.string().min(1).max(80),
  url: z.string().url().max(2000),
  /** 原文发布时间，可能缺失。 */
  published_at: iso.nullable(),
  fetched_at: iso,
  /** 支持某个 claim 的摘录，不是全文。 */
  excerpt: z.string().min(1).max(8000),
  /** 摘录 + 页面关键内容的 hash，用于检测来源变化。 */
  hash: hash,
  rights: z.enum(EVIDENCE_RIGHTS),
  validity: z.enum(EVIDENCE_VALIDITY),
  created_at: iso,
});

export const CLAIM_KINDS = ["factual", "inference", "author_opinion"] as const;

export const CLAIM_STATUSES = ["unchecked", "supported", "disputed", "unsupported"] as const;

export const claimRowSchema = z.object({
  id: uuid,
  topic_id: uuid,
  text: z.string().min(1).max(2000),
  kind: z.enum(CLAIM_KINDS),
  /** 支撑该 claim 的证据；factual 至少一条，inference 可为空。 */
  evidence_ids: z.array(uuid),
  status: z.enum(CLAIM_STATUSES),
  checked_at: iso.nullable(),
});

export const draftRowSchema = z.object({
  id: uuid,
  topic_id: uuid,
  state: z.enum(ARTICLE_STATES),
  current_revision_id: uuid.nullable(),
  /** 当前有效批准对应的 revision；内容变化时清空。 */
  approved_revision_id: uuid.nullable(),
  /** 乐观并发版本号，每次写状态或换 current_revision 都 +1。 */
  lock_version: z.number().int().min(1),
  /** 作者驳回原因；非 rejected 状态为空。 */
  reject_reason: z.string().max(500).nullable(),
  created_at: iso,
  updated_at: iso,
});

export const REVISION_AUTHORS = ["model", "author", "model_after_feedback"] as const;

const revisionContentFields = {
  title: z.string().max(200),
  summary: z.string().max(1000),
  body: z.string().max(200_000),
  cover_asset_hash: hash.nullable(),
  captions: z.record(z.string(), z.string().max(500)),
  asset_hashes: z.array(hash),
};

export const revisionRowSchema = z.object({
  id: uuid,
  draft_id: uuid,
  /** 上一个版本；首个版本为 null。 */
  parent_id: uuid.nullable(),
  ...revisionContentFields,
  content_hash: hash,
  content_hash_version: z.number().int().min(1),
  /** 生成时生效的编辑策略版本，来自 policy/。 */
  policy_version: z.string().min(1).max(64),
  created_by: z.enum(REVISION_AUTHORS),
  created_at: iso,
});

/** 正文事实到证据的映射：复制正文时不显示内部 ID，只在审核页与发布包清单里出现。 */
export const revisionClaimRowSchema = z.object({
  revision_id: uuid,
  /** 正文中稳定的段落标识，不是数据库行号。 */
  block_id: z.string().min(1).max(64),
  claim_id: uuid,
});

export const feedbackRowSchema = z.object({
  id: uuid,
  draft_id: uuid,
  /** 意见必须绑定它针对的版本。 */
  revision_id: uuid,
  /** 段落级意见；为空表示针对全文。 */
  block_id: z.string().min(1).max(64).nullable(),
  text: z.string().min(1).max(4000),
  /** 落实该意见产生的版本。 */
  resolution_revision_id: uuid.nullable(),
  created_at: iso,
});

export const approvalRowSchema = z.object({
  id: uuid,
  draft_id: uuid,
  revision_id: uuid,
  /** 批准时锁定的内容 hash，和 revision.content_hash 必须相同。 */
  content_hash: hash,
  /** 批准人标识（管理员会话）。 */
  actor: z.string().min(1).max(200),
  approved_at: iso,
  /** 撤销时间；撤销后不能再用它导出。 */
  revoked_at: iso.nullable(),
  reason: z.string().max(500).nullable(),
});

export const ASSET_ORIGINS = ["author_upload", "source_capture", "generated_cover", "licensed", "unknown"] as const;

export const assetRowSchema = z.object({
  id: uuid,
  /** 文件内容 hash，去重与引用都用它。 */
  hash,
  /** 私有持久卷内的相对路径，不含绝对路径。 */
  path: z.string().min(1).max(500),
  mime: z.string().min(3).max(100),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  origin: z.enum(ASSET_ORIGINS),
  rights: z.enum(EVIDENCE_RIGHTS),
  created_at: iso,
});

export const exportRowSchema = z.object({
  id: uuid,
  revision_id: uuid,
  approval_id: uuid,
  manifest_hash: hash,
  /** 发布包目录，相对私有持久卷。 */
  path: z.string().min(1).max(500),
  validator_version: z.string().min(1).max(64),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  created_at: iso,
});

/** 首版只登记公众号；其他渠道等有真实需求再加。 */
export const PUBLICATION_CHANNELS = ["wechat_mp"] as const;

export const publicationRowSchema = z.object({
  id: uuid,
  revision_id: uuid,
  channel: z.enum(PUBLICATION_CHANNELS),
  published_at: iso,
  url: z.string().url().max(2000).nullable(),
  /** 登记人；由作者明确操作产生。 */
  recorded_by: z.string().min(1).max(200),
});

export type RunRow = z.infer<typeof runRowSchema>;
export type StepRow = z.infer<typeof stepRowSchema>;
export type TopicRow = z.infer<typeof topicRowSchema>;
export type EvidenceRow = z.infer<typeof evidenceRowSchema>;
export type ClaimRow = z.infer<typeof claimRowSchema>;
export type DraftRow = z.infer<typeof draftRowSchema>;
export type RevisionRow = z.infer<typeof revisionRowSchema>;
export type RevisionClaimRow = z.infer<typeof revisionClaimRowSchema>;
export type FeedbackRow = z.infer<typeof feedbackRowSchema>;
export type ApprovalRow = z.infer<typeof approvalRowSchema>;
export type AssetRow = z.infer<typeof assetRowSchema>;
export type ExportRow = z.infer<typeof exportRowSchema>;
export type PublicationRow = z.infer<typeof publicationRowSchema>;

/**
 * 由 revision 行算出 content_hash，用于写入前自检：
 * 库里存的 hash 必须与内容一致，否则批准会绑定到错误的内容。
 */
export function hashOfRevisionRow(
  row: Pick<RevisionRow, "title" | "summary" | "body" | "cover_asset_hash" | "captions" | "asset_hashes">,
): string {
  return contentHash(
    normalizeRevisionContent({
      title: row.title,
      summary: row.summary,
      body: row.body,
      cover_asset_hash: row.cover_asset_hash,
      captions: row.captions,
      asset_hashes: row.asset_hashes,
    }),
  );
}

