// 私人工作台的 API 路由。F22 只装最小的一组：装配自检与稿件列表占位，
// 其余接口由后续任务在同一前缀下追加，全部经过 editorialHandler。
import type { FastifyInstance } from "fastify";
import { API_PREFIX } from "../../contracts/api.ts";
import { policyVersion } from "../../policy/index.ts";
import { editorialHandler } from "./index.ts";

export const EDITORIAL_HEALTH_PATH = `${API_PREFIX}/health`;

/** 模块装进 api 进程的 http 插口（F37 通过 ServerModule.http 注册）。 */
export function registerEditorialRoutes(app: FastifyInstance): void {
  app.get(EDITORIAL_HEALTH_PATH, editorialHandler(async (_req, reply, admin) => {
    // 私有接口统一 no-store，这里再确认一次，避免被上游中间件覆盖。
    reply.header("Cache-Control", "no-store");
    return { ok: true, policy_version: policyVersion(), admin: admin.name };
  }));
}
