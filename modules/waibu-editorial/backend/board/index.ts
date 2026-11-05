// 队列与选题的读取。分页用「排序键 + id」的游标，不用 offset：
// 作者一边翻页、后台一边生成新稿时，offset 会让同一条稿子出现两次或漏掉。
import type { Db } from "@aihot/backend/db";
import { draftRowSchema, topicRowSchema, type DraftRow, type TopicRow } from "../../contracts/entities.ts";

export interface DraftListItem {
  draft: DraftRow;
  topic: TopicRow;
  title: string;
  /** 未解决的自检阻断项数量，0 表示可以批准。 */
  blocking_issues: number;
}

export interface TopicListItem {
  topic: TopicRow;
  draft_id: string | null;
  evidence_count: number;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** 游标：`更新时间的毫秒数:id`，两段一起比较，时间相同也能稳定排序。 */
function encodeCursor(updatedAt: string, id: string): string {
  return `${new Date(updatedAt).getTime()}:${id}`;
}

function decodeCursor(cursor: string | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split(":");
  if (!at || !id || Number.isNaN(Number(at))) return null;
  return { at: Number(at), id };
}

/** 稿件队列：按状态过滤，默认只列未发布的。 */
export async function listDrafts(db: Db, options: { state?: string; cursor?: string; limit?: number } = {}): Promise<Page<DraftListItem>> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const cursor = decodeCursor(options.cursor);
  const rows = await db`
    select d.id as draft_id, d.topic_id, d.state, d.current_revision_id, d.approved_revision_id, d.lock_version, d.reject_reason,
           d.created_at as draft_created_at, d.updated_at as draft_updated_at,
           t.id as t_id, t.run_id, t.story_ids, t.angle, t.reason, t.evidence_status, t.dedupe_key, t.created_at as topic_created_at,
           coalesce(r.title, '') as title,
           (select count(*)::int from waibu_claims c where c.topic_id = d.topic_id and c.status in ('unsupported', 'disputed', 'unchecked')) as blocking
    from waibu_drafts d
    join waibu_topics t on t.id = d.topic_id
    left join waibu_revisions r on r.id = d.current_revision_id
    where (${options.state ?? null}::text is null or d.state = ${options.state ?? null})
      and (${cursor?.at ?? null}::bigint is null or (extract(epoch from d.updated_at) * 1000)::bigint < ${cursor?.at ?? null}::bigint
           or ((extract(epoch from d.updated_at) * 1000)::bigint = ${cursor?.at ?? null}::bigint and d.id < ${cursor?.id ?? null}::uuid))
    order by d.updated_at desc, d.id desc
    limit ${limit + 1}`;

  const page = rows.slice(0, limit).map((row) => ({
    draft: draftRowSchema.parse({
      id: String(row.draft_id),
      topic_id: String(row.topic_id),
      state: row.state,
      current_revision_id: row.current_revision_id ? String(row.current_revision_id) : null,
      approved_revision_id: row.approved_revision_id ? String(row.approved_revision_id) : null,
      lock_version: Number(row.lock_version),
      reject_reason: row.reject_reason ?? null,
      created_at: new Date(row.draft_created_at as string).toISOString(),
      updated_at: new Date(row.draft_updated_at as string).toISOString(),
    }),
    topic: topicRowSchema.parse({
      id: String(row.t_id),
      run_id: String(row.run_id),
      story_ids: (row.story_ids as number[]).map(Number),
      angle: String(row.angle),
      reason: String(row.reason ?? ""),
      evidence_status: row.evidence_status,
      dedupe_key: String(row.dedupe_key),
      created_at: new Date(row.topic_created_at as string).toISOString(),
    }),
    title: String(row.title ?? ""),
    blocking_issues: Number(row.blocking ?? 0),
  }));

  const last = page.at(-1);
  return {
    items: page,
    next_cursor: rows.length > limit && last ? encodeCursor(last.draft.updated_at, last.draft.id) : null,
  };
}

/** 候选选题：按生成时间倒序，带证据条数与是否已建稿。 */
export async function listTopics(db: Db, options: { cursor?: string; limit?: number } = {}): Promise<Page<TopicListItem>> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const cursor = decodeCursor(options.cursor);
  const rows = await db`
    select t.*, d.id as draft_id,
           (select count(*)::int from waibu_claims c where c.topic_id = t.id) as claim_count
    from waibu_topics t
    left join waibu_drafts d on d.topic_id = t.id
    where (${cursor?.at ?? null}::bigint is null or (extract(epoch from t.created_at) * 1000)::bigint < ${cursor?.at ?? null}::bigint
           or ((extract(epoch from t.created_at) * 1000)::bigint = ${cursor?.at ?? null}::bigint and t.id < ${cursor?.id ?? null}::uuid))
    order by t.created_at desc, t.id desc
    limit ${limit + 1}`;

  const page = rows.slice(0, limit).map((row) => ({
    topic: topicRowSchema.parse({
      id: String(row.id),
      run_id: String(row.run_id),
      story_ids: (row.story_ids as number[]).map(Number),
      angle: String(row.angle),
      reason: String(row.reason ?? ""),
      evidence_status: row.evidence_status,
      dedupe_key: String(row.dedupe_key),
      created_at: new Date(row.created_at as string).toISOString(),
    }),
    draft_id: row.draft_id ? String(row.draft_id) : null,
    evidence_count: Number(row.claim_count ?? 0),
  }));

  const last = page.at(-1);
  return {
    items: page,
    next_cursor: rows.length > limit && last ? encodeCursor(last.topic.created_at, last.topic.id) : null,
  };
}

/** 待审积压数：达到上限时暂停自动起草，页面要显示这个数字。 */
export async function pendingReviewCount(db: Db): Promise<number> {
  const [row] = await db`select count(*)::int as n from waibu_drafts where state in ('in_review', 'revising', 'checking')`;
  return Number(row?.n ?? 0);
}
