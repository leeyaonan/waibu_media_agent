// 审核页需要的全部数据：正文分段、每段引用了哪些事实、每条事实对应的证据摘录、
// 历史意见、当前批准与最近导出。一次给全，避免页面发一串请求拼数据。
import type { Db } from "@aihot/backend/db";
import { approvalRowSchema, claimRowSchema, draftRowSchema, evidenceRowSchema, exportRowSchema, feedbackRowSchema, revisionRowSchema, type ApprovalRow, type ClaimRow, type DraftRow, type EvidenceRow, type ExportRow, type FeedbackRow, type RevisionRow } from "../../contracts/entities.ts";
import { splitBlocks } from "../feedback/index.ts";
import { row, rows } from "../store/rows.ts";

export interface ReviewBlock {
  block_id: string;
  index: number;
  text: string;
  claim_ids: string[];
}

export interface ReviewClaim extends ClaimRow {
  /** 支撑它的事实摘录；页面用抽屉展示。 */
  evidence: EvidenceRow[];
}

export interface ReviewDetail {
  draft: DraftRow;
  revision: RevisionRow;
  blocks: ReviewBlock[];
  claims: ReviewClaim[];
  feedback: FeedbackRow[];
  approval: ApprovalRow | null;
  export: ExportRow | null;
}

export async function loadReviewDetail(db: Db, draftId: string): Promise<ReviewDetail | null> {
  const [draftRow] = await db`select * from waibu_drafts where id = ${draftId}`;
  if (!draftRow) return null;
  const draft = row(draftRowSchema, draftRow);

  const [revisionRow] = await db`
    select * from waibu_revisions where draft_id = ${draftId} order by created_at desc, id desc limit 1`;
  if (!revisionRow) return { draft, revision: null as unknown as RevisionRow, blocks: [], claims: [], feedback: [], approval: null, export: null };
  const revision = row(revisionRowSchema, revisionRow);

  const [topicRow] = await db`select topic_id from waibu_drafts where id = ${draftId}`;
  const claimsRows = await db`select * from waibu_claims where topic_id = ${topicRow!.topic_id} order by created_at`;
  const claims = rows(claimRowSchema, claimsRows);

  const evidenceIds = [...new Set(claims.flatMap((claim) => claim.evidence_ids))];
  const evidenceRows = evidenceIds.length
    ? await db`select * from waibu_evidence where id = any(${evidenceIds}::uuid[]) order by created_at`
    : [];
  const evidence = rows(evidenceRowSchema, evidenceRows);
  const byId = new Map(evidence.map((item) => [item.id, item]));

  const links = await db`select block_id, claim_id from waibu_revision_claims where revision_id = ${revision.id}`;
  const byBlock = new Map<string, string[]>();
  for (const link of links) {
    const key = String(link.block_id);
    byBlock.set(key, [...(byBlock.get(key) ?? []), String(link.claim_id)]);
  }

  // 段落序号即 block_id：与批注定位、正文事实映射共用同一套切法。
  const blocks: ReviewBlock[] = splitBlocks(revision.body).map((text, index) => ({
    block_id: String(index),
    index,
    text,
    claim_ids: byBlock.get(String(index)) ?? [],
  }));

  const feedbackRows = await db`select * from waibu_feedback where draft_id = ${draftId} order by created_at`;
  const [approvalRow] = await db`
    select * from waibu_approvals where draft_id = ${draftId} and revoked_at is null order by approved_at desc limit 1`;
  const [exportRow] = await db`
    select * from waibu_exports where revision_id = ${revision.id} and status = 'succeeded' order by created_at desc limit 1`;

  return {
    draft,
    revision,
    blocks,
    claims: claims.map((claim) => ({
      ...claim,
      evidence: claim.evidence_ids.map((id) => byId.get(id)).filter((item): item is EvidenceRow => Boolean(item)),
    })),
    feedback: rows(feedbackRowSchema, feedbackRows),
    approval: approvalRow ? row(approvalRowSchema, approvalRow) : null,
    export: exportRow ? row(exportRowSchema, exportRow) : null,
  };
}
