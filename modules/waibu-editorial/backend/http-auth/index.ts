// 私人接口的统一入口。模块路由不会天然继承后台登录保护，所以每条私人 API 都必须显式走这里：
// 校验管理员会话、写请求校验 CSRF、响应不缓存、业务错误转成稳定的错误码。
//
// 这里不复用 apps/api 里的 adminHandler：模块不能依赖应用层代码。会话与 CSRF 的判定原语
// 来自 @aihot/backend/admin/auth，与后台是同一条会话，不存在第二套登录。
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { sessionPrincipal, type AdminPrincipal } from "@aihot/backend/admin/auth";
import { EditorialError } from "../../contracts/errors.ts";

export interface ProblemInit {
  status: number;
  code: string;
  detail: string;
  details?: Record<string, unknown>;
}

/** 与 apps/api 的 sendProblem 同形：type/title/status/detail/code/requestId。 */
export function sendProblem(req: FastifyRequest, reply: FastifyReply, problem: ProblemInit) {
  const body: Record<string, unknown> = {
    type: `/problems/${problem.code.replace(/_/gu, "-")}`,
    title: problem.status === 401 ? "Unauthorized" : problem.status === 403 ? "Forbidden" : problem.status === 404 ? "Not Found" : problem.status === 409 ? "Conflict" : problem.status === 422 ? "Unprocessable Content" : problem.status === 429 ? "Too Many Requests" : "Error",
    status: problem.status,
    detail: problem.detail,
    code: problem.code,
    requestId: req.id,
  };
  if (problem.details) body.details = problem.details;
  return reply.code(problem.status).type("application/problem+json").send(body);
}

export type EditorialHandler = (req: FastifyRequest, reply: FastifyReply, admin: AdminPrincipal) => Promise<unknown>;

/**
 * 私人接口守卫。GET/HEAD 只校验会话；写请求额外校验 CSRF 头。
 * 任何响应都带 no-store：稿件与批注不能进共享缓存。
 */
export function editorialHandler(fn: EditorialHandler) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    const admin = await sessionPrincipal(req.headers.cookie);
    if (!admin) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "请先登录管理员后台" });
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-csrf-token"] !== admin.csrf) {
      return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "缺少或过期的 CSRF 令牌" });
    }
    try {
      return await fn(req, reply, admin);
    } catch (error) {
      if (error instanceof EditorialError) {
        return sendProblem(req, reply, { status: error.status, code: error.code, detail: error.message, details: error.details });
      }
      if (error instanceof ZodError) {
        return sendProblem(req, reply, {
          status: 400,
          code: "invalid_request",
          detail: error.issues.map((issue) => `${issue.path.join(".") || "请求"}: ${issue.message}`).join("; ").slice(0, 300),
        });
      }
      req.log.error({ err: error }, "editorial api error");
      return sendProblem(req, reply, { status: 500, code: "internal_error", detail: "处理失败" });
    }
  };
}
