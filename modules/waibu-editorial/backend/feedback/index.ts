// 定向改稿：作者的意见是基线，只改意见涉及的范围。
//
// 三条要守住：
// 1. 意见只针对某一段时，别的段落（尤其价格、版本这类结论段）不该被顺手改掉；
// 2. 意见绑定的段落在新版本里找不到时，明确告诉作者“这条批注过期了”，不要猜位置；
// 3. 建议没被采用时，当前稿保持不变——不能因为跑了一次改稿就覆盖作者的稿子。
import type { Db, Tx } from "@aihot/backend/db";
// 按意见改稿与手动编辑共用同一个出口：重新自检。
import { stateAfterAuthorEdit } from "../../contracts/states.ts";
import type { RevisionContent } from "../../contracts/content.ts";
import type { DraftRow, FeedbackRow, RevisionRow } from "../../contracts/entities.ts";
import { appendRevision, getDraft } from "../store/drafts.ts";
import { listFeedback, resolveFeedback } from "../store/review.ts";
import { createFeedback as insertFeedback } from "../store/review.ts";

/** 正文按空行切段，段落序号即批注定位用的 block_id。 */
export function splitBlocks(body: string): string[] {
  return body.split(/\n\s*\n/u).map((block) => block.trim()).filter(Boolean);
}

export interface ScopeCheck {
  ok: boolean;
  /** 意见没提到、却被改动的段落序号。 */
  unexpected_changes: number[];
  /** 意见点名但已经不存在的段落。 */
  missing_blocks: number[];
}

/**
 * 改稿范围检查：只允许改动意见涉及的段落。
 * 这是提示性的判断——页面把越界改动指出来，由作者决定要不要接受。
 */
export function checkFeedbackScope(input: {
  before: string;
  after: string;
  targeted_blocks: readonly number[];
}): ScopeCheck {
  const before = splitBlocks(input.before);
  const after = splitBlocks(input.after);
  const targeted = new Set(input.targeted_blocks);
  const unexpected: number[] = [];
  const missing: number[] = [];

  for (const index of targeted) {
    if (index >= before.length) missing.push(index);
  }

  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (targeted.has(index)) continue;
    if ((before[index] ?? null) !== (after[index] ?? null)) unexpected.push(index);
  }

  return { ok: unexpected.length === 0 && missing.length === 0, unexpected_changes: unexpected, missing_blocks: missing };
}

export interface StaleFeedback {
  id: string;
  block_id: string;
  reason: string;
}

/**
 * 过期批注：版本变了、原文段落对不上时，明确标出来让作者重新定位，
 * 而不是把它挂到相邻段落上悄悄执行。
 */
export function findStaleFeedback(feedback: readonly Pick<FeedbackRow, "id" | "block_id">[], currentBody: string): StaleFeedback[] {
  const blocks = splitBlocks(currentBody);
  const stale: StaleFeedback[] = [];
  for (const item of feedback) {
    if (item.block_id === null) continue;
    const index = Number(item.block_id);
    if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
      stale.push({ id: item.id, block_id: item.block_id, reason: "这条批注指向的段落在当前版本里已不存在，请重新定位" });
    }
  }
  return stale;
}

export interface ReviseInput {
  draft_id: string;
  expected_lock_version: number;
  base_revision_id: string;
  content: RevisionContent;
  policy_version: string;
  /** 本轮实际落实的意见。 */
  feedback_ids: string[];
}

export interface ReviseResult {
  revision: RevisionRow;
  draft: DraftRow;
  resolved: number;
}

/**
 * 落实改稿意见：产生新版本、把意见标记到落实的版本、回到自检。
 * 调用方负责先确认作者没有在期间又改过稿（expected_lock_version）。
 */
export async function applyFeedbackRevision(tx: Tx, input: ReviseInput): Promise<ReviseResult> {
  const draft = await getDraft(tx, input.draft_id);
  if (!draft) throw new Error("稿件不存在");

  const applied = await appendRevision(tx, {
    draft_id: input.draft_id,
    parent_id: input.base_revision_id,
    content: input.content,
    policy_version: input.policy_version,
    created_by: "model_after_feedback",
    expected_lock_version: input.expected_lock_version,
    next_state: stateAfterAuthorEdit(draft.state),
  });
  await resolveFeedback(tx, input.feedback_ids, applied.revision.id);
  return { revision: applied.revision, draft: applied.draft, resolved: input.feedback_ids.length };
}

/** 页面用：一条意见的当前状态（待处理/已落实/已过期）。 */
export type FeedbackState = "open" | "resolved" | "stale";

export async function feedbackStates(tx: Db, draftId: string, currentBody: string): Promise<Array<{ id: string; state: FeedbackState; block_id: string | null }>> {
  const items = await listFeedback(tx, draftId);
  const stale = new Set(findStaleFeedback(items, currentBody).map((item) => item.id));
  return items.map((item) => ({
    id: item.id,
    block_id: item.block_id,
    state: item.resolution_revision_id ? "resolved" : stale.has(item.id) ? "stale" : "open",
  }));
}

export { insertFeedback };
