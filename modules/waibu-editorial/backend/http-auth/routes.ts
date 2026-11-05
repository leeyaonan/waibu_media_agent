// 私人工作台的 API 路由。F22 只装最小的一组：装配自检与稿件列表占位，
// 其余接口由后续任务在同一前缀下追加，全部经过 editorialHandler。
import type { FastifyInstance } from "fastify";
import { sql } from "@aihot/backend/db";
import { API_PREFIX, approveRequestSchema, exportRequestSchema, rejectRequestSchema } from "../../contracts/api.ts";
import { approvalGuards } from "../review/guards.ts";
import { loadReviewDetail } from "../review/detail.ts";
import { applyAuthorEdit, diffRevisions } from "../revisions/index.ts";
import { saveRevisionRequestSchema } from "../../contracts/api.ts";
import { listRevisions } from "../store/drafts.ts";
import { createFeedback } from "../store/review.ts";
import { feedbackRequestSchema } from "../../contracts/api.ts";
import { EditorialError } from "../../contracts/errors.ts";
import { requestHashOf, withIdempotency } from "../idempotency/index.ts";
import { IDEMPOTENCY_HEADER } from "../../contracts/api.ts";
import { approveDraft, rejectDraft } from "../store/review.ts";
import { createExport } from "../store/delivery.ts";
import { listDrafts, listTopics, pendingReviewCount } from "../board/index.ts";
import { listRuns, resumableStages, runDetail } from "../runs/index.ts";
import { listQuerySchema } from "../../contracts/api.ts";
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
    return { ok: true, policy_version: policyVersion(), admin: admin.name, csrf: admin.csrf };
  }));

  /** 稿件队列：按状态过滤，游标分页；同时给出待审积压数，页面据此提示暂停自动起草。 */
  app.get(`${API_PREFIX}/drafts`, editorialHandler(async (req) => {
    const query = listQuerySchema.parse(req.query);
    const state = typeof (req.query as Record<string, unknown>).state === "string" ? String((req.query as Record<string, unknown>).state) : undefined;
    const page = await listDrafts(sql, { state, cursor: query.cursor, limit: query.limit });
    return { ...page, pending_review: await pendingReviewCount(sql) };
  }));

  /** 候选选题。 */
  app.get(`${API_PREFIX}/topics`, editorialHandler(async (req) => {
    const query = listQuerySchema.parse(req.query);
    return listTopics(sql, { cursor: query.cursor, limit: query.limit });
  }));

  /** 运行列表：最近若干次，带阶段完成数与 token。 */
  app.get(`${API_PREFIX}/runs`, editorialHandler(async () => ({ items: await listRuns(sql) })));

  /** 运行详情：阶段、token、费用与暂停原因；恢复只补未成功的阶段。 */
  app.get(`${API_PREFIX}/runs/:runId`, editorialHandler(async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const detail = await runDetail(sql, runId);
    if (!detail) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "运行不存在" });
    return { ...detail, resumable: resumableStages(detail.steps) };
  }));

  /** 审核详情：正文分段、段落引用的事实、事实对应的证据摘录、意见与批准状态。 */
  app.get(`${API_PREFIX}/drafts/:draftId`, editorialHandler(async (req, reply) => {
    const { draftId } = req.params as { draftId: string };
    const detail = await loadReviewDetail(sql, draftId);
    if (!detail) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" });
    return detail;
  }));

  /** 版本历史：每个版本附上相对上一版的差异，页面直接展示，不再自己算。 */
  app.get(`${API_PREFIX}/drafts/:draftId/revisions`, editorialHandler(async (req) => {
    const { draftId } = req.params as { draftId: string };
    const history = await listRevisions(sql, draftId);
    return {
      items: history.map((revision, index) => {
        const previous = history[index + 1] ?? null;
        return {
          revision,
          diff: previous ? diffRevisions(previous, revision) : null,
          is_current: index === 0,
        };
      }),
    };
  }));

  /** 作者手动编辑：产生新版本、撤销批准、回自检；版本号不对就拒绝，不覆盖作者最新稿。 */
  app.post(`${API_PREFIX}/drafts/:draftId/revisions`, editorialHandler(async (req, reply, admin) => {
    const { draftId } = req.params as { draftId: string };
    const body = saveRevisionRequestSchema.parse(req.body);
    const detail = await loadReviewDetail(sql, draftId);
    if (!detail || !detail.revision) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在或没有版本" });

    const saved = await sql.begin((tx) =>
      applyAuthorEdit(tx, {
        draft_id: draftId,
        expected_lock_version: body.expected_lock_version,
        base_revision_id: detail.revision!.id,
        content: {
          title: body.title,
          summary: body.summary,
          body: body.body,
          cover_asset_hash: body.cover_asset_hash,
          captions: body.captions,
          asset_hashes: body.asset_hashes,
        },
        policy_version: detail.revision!.policy_version,
      }),
    );
    void admin;
    return reply.code(201).send({ revision: saved.revision, draft: saved.draft, requeued: true, job_id: null });
  }));

  /**
   * 提交意见并请求改稿。带 Idempotency-Key 时重复提交只产生一份意见；
   * 稿件进入 revising，改稿失败也不会丢掉作者写的意见。
   */
  app.post(`${API_PREFIX}/drafts/:draftId/feedback`, editorialHandler(async (req, reply, admin) => {
    const { draftId } = req.params as { draftId: string };
    const body = feedbackRequestSchema.parse(req.body);
    const key = req.headers[IDEMPOTENCY_HEADER] ? String(req.headers[IDEMPOTENCY_HEADER]) : null;

    const result = await withIdempotency({
      db: sql,
      key,
      actor: admin.name,
      path: `/drafts/${draftId}/feedback`,
      requestHash: requestHashOf({ draftId, ...body }),
      run: async () => {
        // 意见必须针对当前版本；旧版本上提的意见会让改稿结果错位。
        const current = await sql`select current_revision_id, state from waibu_drafts where id = ${draftId}`;
        if (current.length === 0) throw new EditorialError("not_found", "稿件不存在");
        if (String(current[0]!.current_revision_id) !== body.expected_revision_id) {
          throw new EditorialError("conflict_version", "这条意见针对的版本已经不是当前版本，请刷新后重新定位");
        }

        const feedback = await sql.begin(async (tx) => {
          const created = await createFeedback(tx, {
            draft_id: draftId,
            revision_id: body.expected_revision_id,
            block_id: body.block_id ?? null,
            text: body.text,
          });
          // 只有待审稿会因为提意见进入改稿；其他状态保持原样，意见照样保存。
          if (String(current[0]!.state) === "in_review") {
            await tx`update waibu_drafts set state = 'revising', lock_version = lock_version + 1, updated_at = now() where id = ${draftId}`;
          }
          return created;
        });
        return { feedback, job_id: null };
      },
    });

    // 重复提交返回 200，第一次返回 202：页面据此区分“又点了一次”。
    return reply.code(result.replayed ? 200 : 202).send({ ...result.response, replayed: result.replayed });
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
