// 批准前的守卫数据：还有多少阻断项、多少关键证据失效。
// 这些数字从库里现算，不接受客户端传"没问题"。
import type { Db } from "@aihot/backend/db";

export interface ApprovalGuards {
  /** 未解决的事实缺口：unsupported / disputed 的结论数。 */
  blockingIssues: number;
  /** 引用到的、已经失效（changed/withdrawn）的证据条数。 */
  invalidEvidence: number;
}

export async function approvalGuards(db: Db, draftId: string): Promise<ApprovalGuards> {
  const [draft] = await db`select topic_id from waibu_drafts where id = ${draftId}`;
  if (!draft) return { blockingIssues: 0, invalidEvidence: 0 };

  const [claims] = await db`
    select
      count(*) filter (where status in ('unsupported', 'disputed'))::int as blocking,
      count(*) filter (where status = 'unchecked')::int as unchecked
    from waibu_claims where topic_id = ${draft.topic_id}`;

  const [evidence] = await db`
    select count(distinct e.id)::int as invalid
    from waibu_claims c
    cross join lateral unnest(c.evidence_ids) as ev(id)
    join waibu_evidence e on e.id = ev.id
    where c.topic_id = ${draft.topic_id} and e.validity <> 'valid'`;

  // 还没核查过的结论也算阻断：没查过就不能当已核实。
  return {
    blockingIssues: Number(claims?.blocking ?? 0) + Number(claims?.unchecked ?? 0),
    invalidEvidence: Number(evidence?.invalid ?? 0),
  };
}
