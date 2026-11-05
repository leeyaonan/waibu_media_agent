// 选题、证据、事实、稿件与版本。版本只插入不更新：任何内容变化都产生新行，
// 旧版本作为审计材料保留，批准绑定在具体版本的内容 hash 上。
import type { Db, Tx } from "@aihot/backend/db";
import {
  claimRowSchema,
  draftRowSchema,
  evidenceRowSchema,
  revisionRowSchema,
  topicRowSchema,
  type ClaimRow,
  type DraftRow,
  type EvidenceRow,
  type RevisionRow,
  type TopicRow,
} from "../../contracts/entities.ts";
import { CONTENT_HASH_VERSION, contentHash, normalizeRevisionContent, type RevisionContent } from "../../contracts/content.ts";
import { stateAfterContentChange, type ArticleState } from "../../contracts/states.ts";
import { versionConflict } from "../../contracts/errors.ts";
import { row, rows } from "./rows.ts";

export async function createTopic(
  db: Db,
  input: { run_id: string; story_ids: number[]; angle: string; reason: string; evidence_status: "sufficient" | "insufficient" | "disputed"; dedupe_key: string },
): Promise<TopicRow> {
  const [created] = await db`
    insert into waibu_topics (run_id, story_ids, angle, reason, evidence_status, dedupe_key)
    values (${input.run_id}, ${input.story_ids}, ${input.angle}, ${input.reason}, ${input.evidence_status}, ${input.dedupe_key})
    returning *`;
  return row(topicRowSchema, created);
}

export async function getTopic(db: Db, topicId: string): Promise<TopicRow | null> {
  const [found] = await db`select * from waibu_topics where id = ${topicId}`;
  return found ? row(topicRowSchema, found) : null;
}

/** 同一事件同一角度已有选题时返回已有记录，不重复建。 */
export async function findTopicByDedupeKey(db: Db, dedupeKey: string): Promise<TopicRow | null> {
  const [found] = await db`select * from waibu_topics where dedupe_key = ${dedupeKey}`;
  return found ? row(topicRowSchema, found) : null;
}

export async function createEvidence(
  db: Db,
  input: { source_id: string; article_id: string; url: string; published_at: string | null; fetched_at?: Date; excerpt: string; hash: string; rights: "quotation" | "public" | "licensed" | "unknown" },
): Promise<EvidenceRow> {
  const [created] = await db`
    insert into waibu_evidence (source_id, article_id, url, published_at, fetched_at, excerpt, hash, rights)
    values (${input.source_id}, ${input.article_id}, ${input.url}, ${input.published_at}, ${input.fetched_at ?? new Date()}, ${input.excerpt}, ${input.hash}, ${input.rights})
    returning *`;
  return row(evidenceRowSchema, created);
}

export async function listEvidence(db: Db, ids: readonly string[]): Promise<EvidenceRow[]> {
  if (ids.length === 0) return [];
  const found = await db`select * from waibu_evidence where id = any(${ids}::uuid[]) order by created_at`;
  return rows(evidenceRowSchema, found);
}

/** 来源撤回或内容变化时更新有效性；证据快照本身不改写。 */
export async function setEvidenceValidity(db: Db, ids: readonly string[], validity: "valid" | "changed" | "withdrawn"): Promise<number> {
  if (ids.length === 0) return 0;
  const updated = await db`update waibu_evidence set validity = ${validity} where id = any(${ids}::uuid[])`;
  return updated.count;
}

export async function createClaim(
  db: Db,
  input: { topic_id: string; text: string; kind: "factual" | "inference" | "author_opinion"; evidence_ids: string[]; status?: "unchecked" | "supported" | "disputed" | "unsupported" },
): Promise<ClaimRow> {
  const [created] = await db`
    insert into waibu_claims (topic_id, text, kind, evidence_ids, status)
    values (${input.topic_id}, ${input.text}, ${input.kind}, ${input.evidence_ids}::uuid[], ${input.status ?? "unchecked"})
    returning *`;
  return row(claimRowSchema, created);
}

/** 核查结论：状态与核查时间一起写，页面据此区分“没查”和“查过且有问题”。 */
export async function markClaimChecked(db: Db, claimId: string, status: "supported" | "disputed" | "unsupported"): Promise<ClaimRow> {
  const [updated] = await db`
    update waibu_claims set status = ${status}, checked_at = now() where id = ${claimId} returning *`;
  return row(claimRowSchema, updated);
}

export async function listClaims(db: Db, topicId: string): Promise<ClaimRow[]> {
  const found = await db`select * from waibu_claims where topic_id = ${topicId} order by created_at`;
  return rows(claimRowSchema, found);
}

export async function createDraft(db: Db, topicId: string): Promise<DraftRow> {
  const [created] = await db`insert into waibu_drafts (topic_id) values (${topicId}) returning *`;
  return row(draftRowSchema, created);
}

export async function getDraft(db: Db, draftId: string): Promise<DraftRow | null> {
  const [found] = await db`select * from waibu_drafts where id = ${draftId}`;
  return found ? row(draftRowSchema, found) : null;
}

/** 行锁读稿件，用于批准这类必须串行的判断；必须在事务里调用。 */
export async function lockDraft(db: Db, draftId: string): Promise<DraftRow> {
  const [found] = await db`select * from waibu_drafts where id = ${draftId} for update`;
  if (!found) throw new Error(`稿件不存在：${draftId}`);
  return row(draftRowSchema, found);
}

export interface AppendRevisionInput {
  draft_id: string;
  parent_id: string | null;
  content: RevisionContent;
  policy_version: string;
  created_by: "model" | "author" | "model_after_feedback";
  expected_lock_version: number;
  /** 新版本落库后稿件的目标状态；内容变化对批准的影响由这里统一处理。 */
  next_state: ArticleState;
}

/**
 * 追加一个版本并推进 current 指针（乐观并发）。
 * 内容离开批准状态时，同一事务里撤销有效批准并清空 approved_revision_id：
 * 旧批准不能继续用于导出（AGENTS.md 的不可变条件）。
 */
export async function appendRevision(db: Tx, input: AppendRevisionInput): Promise<{ revision: RevisionRow; draft: DraftRow }> {
  // 先锁稿件再写版本：版本号不对时直接失败，不会留下没人引用的孤儿版本。
  const current = await lockDraft(db, input.draft_id);
  if (current.lock_version !== input.expected_lock_version) throw versionConflict(input.expected_lock_version, current.lock_version);

  const content = normalizeRevisionContent(input.content);
  const hash = contentHash(content);
  const [created] = await db`
    insert into waibu_revisions (draft_id, parent_id, title, summary, body, cover_asset_hash, captions, asset_hashes, content_hash, content_hash_version, policy_version, created_by)
    values (
      ${input.draft_id}, ${input.parent_id}, ${content.title}, ${content.summary}, ${content.body},
      ${content.cover_asset_hash}, ${db.json(content.captions as never)}, ${content.asset_hashes},
      ${hash}, ${CONTENT_HASH_VERSION}, ${input.policy_version}, ${input.created_by}
    )
    returning *`;
  const revision = row(revisionRowSchema, created);

  const keepsApproval = input.next_state === "approved" || input.next_state === "exported" || input.next_state === "published";
  const [draft] = await db`
    update waibu_drafts set
      current_revision_id = ${revision.id},
      state = ${input.next_state},
      approved_revision_id = case when ${keepsApproval} then approved_revision_id else null end,
      lock_version = lock_version + 1,
      updated_at = now()
    where id = ${input.draft_id}
    returning *`;
  if (!keepsApproval) await revokeActiveApproval(db, input.draft_id, "content_changed");
  return { revision, draft: row(draftRowSchema, draft) };
}

/** 按状态机迁移稿件状态（不产生新版本），用于提交审核、驳回、发布登记等。 */
export async function setDraftState(db: Db, input: { draft_id: string; expected_lock_version: number; next_state: ArticleState }): Promise<DraftRow> {
  const [draft] = await db`
    update waibu_drafts set state = ${input.next_state}, lock_version = lock_version + 1, updated_at = now()
    where id = ${input.draft_id} and lock_version = ${input.expected_lock_version}
    returning *`;
  if (!draft) {
    const current = await getDraft(db, input.draft_id);
    throw versionConflict(input.expected_lock_version, current?.lock_version ?? 0);
  }
  return row(draftRowSchema, draft);
}

/** 内容变化后的目标状态，供调用方在事务里使用。 */
export function nextStateForContentChange(current: ArticleState): ArticleState {
  return stateAfterContentChange(current);
}

export async function getRevision(db: Db, revisionId: string): Promise<RevisionRow | null> {
  const [found] = await db`select * from waibu_revisions where id = ${revisionId}`;
  return found ? row(revisionRowSchema, found) : null;
}

export async function listRevisions(db: Db, draftId: string): Promise<RevisionRow[]> {
  const found = await db`select * from waibu_revisions where draft_id = ${draftId} order by created_at desc, id desc`;
  return rows(revisionRowSchema, found);
}

/** 正文段落 → 事实的映射；同一版本重复写入按块覆盖。 */
export async function linkRevisionClaims(db: Db, revisionId: string, links: ReadonlyArray<{ block_id: string; claim_id: string }>): Promise<void> {
  if (links.length === 0) return;
  await db`
    insert into waibu_revision_claims ${db(links.map((link) => ({ revision_id: revisionId, block_id: link.block_id, claim_id: link.claim_id })))}
    on conflict (revision_id, block_id) do update set claim_id = excluded.claim_id`;
}

export async function listRevisionClaims(db: Db, revisionId: string): Promise<Array<{ block_id: string; claim_id: string }>> {
  const found = await db`select block_id, claim_id from waibu_revision_claims where revision_id = ${revisionId} order by block_id`;
  return found.map((item) => ({ block_id: String(item.block_id), claim_id: String(item.claim_id) }));
}

/**
 * 撤销一份稿件的有效批准。放在这里而不是审批模块，是为了让“换版本”和“撤销批准”在同一个事务里完成；
 * 审批模块的公开函数会复用它。
 */
export async function revokeActiveApproval(db: Db, draftId: string, reason: string): Promise<number> {
  const revoked = await db`
    update waibu_approvals set revoked_at = now(), reason = ${reason}
    where draft_id = ${draftId} and revoked_at is null`;
  return revoked.count;
}
