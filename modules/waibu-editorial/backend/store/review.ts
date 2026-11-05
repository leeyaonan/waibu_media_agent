// 作者意见、批准与驳回。批准是整条流程里唯一必须由人发起的状态变化：
// 这里不发号施令，只做服务端能验证的事——版本、内容 hash、自检结果、来源有效性。
import type { Db, Tx } from "@aihot/backend/db";
import { approvalRowSchema, feedbackRowSchema, type ApprovalRow, type FeedbackRow } from "../../contracts/entities.ts";
import { canApprove } from "../../contracts/states.ts";
import { EditorialError, versionConflict } from "../../contracts/errors.ts";
import { getDraft, getRevision, lockDraft, setDraftState } from "./drafts.ts";
import { row, rows } from "./rows.ts";

export async function createFeedback(
  db: Db,
  input: { draft_id: string; revision_id: string; block_id: string | null; text: string },
): Promise<FeedbackRow> {
  const [created] = await db`
    insert into waibu_feedback (draft_id, revision_id, block_id, text)
    values (${input.draft_id}, ${input.revision_id}, ${input.block_id}, ${input.text})
    returning *`;
  return row(feedbackRowSchema, created);
}

export async function listFeedback(db: Db, draftId: string): Promise<FeedbackRow[]> {
  const found = await db`select * from waibu_feedback where draft_id = ${draftId} order by created_at, id`;
  return rows(feedbackRowSchema, found);
}

/** 改稿落实后回填产生的版本，页面上才能逐项显示“这条意见处理成了哪版”。 */
export async function resolveFeedback(db: Db, feedbackIds: readonly string[], revisionId: string): Promise<void> {
  if (feedbackIds.length === 0) return;
  await db`update waibu_feedback set resolution_revision_id = ${revisionId} where id = any(${feedbackIds}::uuid[])`;
}

export async function findActiveApproval(db: Db, draftId: string): Promise<ApprovalRow | null> {
  const [found] = await db`
    select * from waibu_approvals where draft_id = ${draftId} and revoked_at is null order by approved_at desc limit 1`;
  return found ? row(approvalRowSchema, found) : null;
}

export async function listApprovals(db: Db, draftId: string): Promise<ApprovalRow[]> {
  const found = await db`select * from waibu_approvals where draft_id = ${draftId} order by approved_at desc`;
  return rows(approvalRowSchema, found);
}

export interface ApproveInput {
  draft_id: string;
  revision_id: string;
  expected_content_hash: string;
  actor: string;
  expected_lock_version: number;
}

/**
 * 人工批准。必须在事务里调用：行锁稿件，逐项验证后写批准并推进状态。
 * 任何一项不满足都不写批准记录，返回明确的错误码让页面提示。
 */
export async function approveDraft(
  db: Tx,
  input: ApproveInput,
  guards: { blockingIssues: number; invalidEvidence: number },
): Promise<{ approval: ApprovalRow; draft: Awaited<ReturnType<typeof getDraft>> }> {
  const draft = await lockDraft(db, input.draft_id);
  if (draft.lock_version !== input.expected_lock_version) throw versionConflict(input.expected_lock_version, draft.lock_version);
  if (!canApprove(draft.state)) throw new EditorialError("conflict_state", `当前状态 ${draft.state} 不能批准`, { state: draft.state });
  if (draft.current_revision_id !== input.revision_id) {
    throw new EditorialError("approval_stale", "要批准的版本已不是当前版本", { current: draft.current_revision_id });
  }
  const revision = await getRevision(db, input.revision_id);
  if (!revision) throw new EditorialError("not_found", "版本不存在");
  if (revision.content_hash !== input.expected_content_hash) {
    throw new EditorialError("approval_stale", "内容 hash 与要批准的版本不一致，请刷新后重新审核", {
      expected: input.expected_content_hash,
      actual: revision.content_hash,
    });
  }
  if (guards.blockingIssues > 0) throw new EditorialError("check_blocked", `还有 ${guards.blockingIssues} 项自检阻断未解决`);
  if (guards.invalidEvidence > 0) throw new EditorialError("evidence_invalid", `有 ${guards.invalidEvidence} 条关键证据失效`);

  const [created] = await db`
    insert into waibu_approvals (draft_id, revision_id, content_hash, actor)
    values (${input.draft_id}, ${input.revision_id}, ${input.expected_content_hash}, ${input.actor})
    returning *`;

  const [updated] = await db`
    update waibu_drafts set state = 'approved', approved_revision_id = ${input.revision_id}, reject_reason = null,
      lock_version = lock_version + 1, updated_at = now()
    where id = ${input.draft_id} and lock_version = ${input.expected_lock_version}
    returning *`;
  if (!updated) {
    const current = await getDraft(db, input.draft_id);
    throw versionConflict(input.expected_lock_version, current?.lock_version ?? 0);
  }
  return { approval: row(approvalRowSchema, created), draft: await getDraft(db, input.draft_id) };
}

/** 撤销批准：内容变化、来源失效或作者反悔。撤销后旧批准不能再用于导出。 */
export async function revokeApproval(db: Db, approvalId: string, reason: string): Promise<ApprovalRow> {
  const [updated] = await db`
    update waibu_approvals set revoked_at = now(), reason = ${reason}
    where id = ${approvalId} and revoked_at is null
    returning *`;
  if (!updated) throw new EditorialError("not_found", "批准记录不存在或已撤销");
  return row(approvalRowSchema, updated);
}

/** 作者驳回：记录原因并进入 rejected，可再次从 drafting 重开。 */
export async function rejectDraft(
  db: Tx,
  input: { draft_id: string; expected_lock_version: number; reason: string },
): Promise<NonNullable<Awaited<ReturnType<typeof getDraft>>>> {
  const draft = await lockDraft(db, input.draft_id);
  if (draft.lock_version !== input.expected_lock_version) throw versionConflict(input.expected_lock_version, draft.lock_version);
  const next = await setDraftState(db, { draft_id: input.draft_id, expected_lock_version: input.expected_lock_version, next_state: "rejected" });
  await db`update waibu_drafts set reject_reason = ${input.reason} where id = ${input.draft_id}`;
  return { ...next, reject_reason: input.reason };
}
