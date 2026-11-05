// 私人工作台的 API 路由。F22 只装最小的一组：装配自检与稿件列表占位，
// 其余接口由后续任务在同一前缀下追加，全部经过 editorialHandler。
import type { FastifyInstance } from "fastify";
import { sql } from "@aihot/backend/db";
import { API_PREFIX, approveRequestSchema, exportRequestSchema, rejectRequestSchema } from "../../contracts/api.ts";
import { approvalGuards } from "../review/guards.ts";
import { approveDraft, rejectDraft } from "../store/review.ts";
import { createExport } from "../store/delivery.ts";
import { policyVersion } from "../../policy/index.ts";
import { loadRevisionText } from "../author-input/index.ts";
import { editorialHandler, sendProblem } from "./index.ts";

export const EDITORIAL_HEALTH_PATH = `${API_PREFIX}/health`;

/** 材料下载地址：版本正文按纯文本返回，未登录 401。 */
export const EDITORIAL_DOWNLOAD_PATH = `${API_PREFIX}/revisions/:revisionId/download`;

/** 模块装进 api 进程的 http 插口（F37 通过 ServerModule.http 注册）。 */
export function registerEditorialRoutes(app: FastifyInstance): void {
  app.get(EDITORIAL_HEALTH_PATH, editorialHandler(async (_req, reply, admin) => {
    // 私有接口统一 no-store，这里再确认一次，避免被上游中间件覆盖。
    reply.header("Cache-Control", "no-store");
    return { ok: true, policy_version: policyVersion(), admin: admin.name };
  }));

  /** 人工批准：只有带管理员会话的请求能到这里，服务端与 worker 没有这条路径。 */
  app.post(`${API_PREFIX}/drafts/:draftId/approvals`, editorialHandler(async (req, reply, admin) => {
    const { draftId } = req.params as { draftId: string };
    const body = approveRequestSchema.parse(req.body);
    const guards = await approvalGuards(sql, draftId);
    const { approval, draft } = await sql.begin((tx) =>
      approveDraft(
        tx,
        {
          draft_id: draftId,
          revision_id: body.expected_revision_id,
          expected_content_hash: body.expected_content_hash,
          actor: admin.name,
          expected_lock_version: body.expected_lock_version,
        },
        guards,
      ),
    );
    return reply.code(200).send({ approval, draft });
  }));

  app.post(`${API_PREFIX}/drafts/:draftId/reject`, editorialHandler(async (req, reply, admin) => {
    const { draftId } = req.params as { draftId: string };
    const body = rejectRequestSchema.parse(req.body);
    const draft = await sql.begin((tx) => rejectDraft(tx, { draft_id: draftId, expected_lock_version: body.expected_lock_version, reason: body.reason }));
    void admin;
    return reply.code(200).send({ draft });
  }));

  /** 导出：只对当前有效批准，失败不让稿件状态前进。 */
  app.post(`${API_PREFIX}/drafts/:draftId/exports`, editorialHandler(async (req, reply) => {
    const { draftId } = req.params as { draftId: string };
    const body = exportRequestSchema.parse(req.body);
    const created = await sql.begin((tx) =>
      createExport(tx, {
        draft_id: draftId,
        revision_id: body.expected_revision_id,
        approval_id: body.expected_approval_id,
        path: `exports/${draftId}/${body.expected_revision_id}`,
        validator_version: "pending",
      }),
    );
    return reply.code(202).send({ export: created, job_id: null });
  }));

  app.get(EDITORIAL_DOWNLOAD_PATH, editorialHandler(async (req, reply) => {
    const { revisionId } = req.params as { revisionId: string };
    const text = await loadRevisionText(sql, revisionId);
    if (!text) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "版本不存在" });
    reply.header("Content-Disposition", `attachment; filename="revision-${revisionId}.md"`);
    return reply.type("text/markdown; charset=utf-8").send(`# ${text.title}\n\n${text.body}\n`);
  }));
}
