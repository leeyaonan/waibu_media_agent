// 模块对外错误码。HTTP 状态与 code 的对应关系在这里定死，API 层只负责按 code 输出，
// 页面和测试按 code 判断，不去匹配人类可读的 detail 文字。
import { z } from "zod";

/** code 到 HTTP 状态的唯一映射，与 apps/api 的 sendProblem 输出形状一致。 */
export const ERROR_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict_version: 409,
  conflict_state: 409,
  approval_required: 409,
  approval_stale: 409,
  check_blocked: 422,
  evidence_invalid: 409,
  budget_paused: 429,
  asset_rejected: 400,
  asset_not_found: 404,
  asset_rights_unknown: 422,
  validation_failed: 422,
  validation_error: 503,
  export_failed: 500,
  idempotency_conflict: 409,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/**
 * 模块内可抛的业务错误。API 层捕获后转成 { type, title, status, detail, code, requestId }，
 * 与上游 sendProblem 的输出保持一致。
 */
export class EditorialError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, detail: string, details: Record<string, unknown> = {}) {
    super(detail);
    this.name = "EditorialError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

/** 乐观并发冲突：带上期望版本与当前版本，页面据此刷新而不是盲目重试。 */
export function versionConflict(expected: number, current: number): EditorialError {
  return new EditorialError("conflict_version", `版本不一致：期望 ${expected}，当前 ${current}`, { expected, current });
}

/** 状态机不允许的迁移。 */
export function stateConflict(from: string, to: string, by: string): EditorialError {
  return new EditorialError("conflict_state", `不允许的状态迁移：${from} → ${to}（发起方 ${by}）`, { from, to, by });
}

/** 问题详情响应体，字段与 apps/api/src/http/respond.ts 一致。 */
export const apiProblemSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: z.string(),
  requestId: z.string().optional(),
  retryAfter: z.number().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ApiProblem = z.infer<typeof apiProblemSchema>;
