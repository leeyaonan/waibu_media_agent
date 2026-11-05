// 来源撤回或网页内容变化后的连锁处理。
//
// 原则：未发布的稿子可以停下来等作者，已发布的事实不能被改写——只提醒勘误。
// 具体到数据：证据标 withdrawn、引用它的结论降级、受影响稿件撤销批准并转 on_hold，
// 已发布稿只产出勘误条目。
import type { Tx } from "@aihot/backend/db";
import type { ArticleState } from "../../contracts/states.ts";

export interface InvalidationResult {
  evidence_withdrawn: number;
  claims_downgraded: number;
  /** 转 on_hold 的稿件（含原本 approved 的）。 */
  drafts_held: string[];
  /** 被撤销的批准数。 */
  approvals_revoked: number;
  /** 已发布稿的勘误提醒，不改状态。 */
  errata: Array<{ draft_id: string; revision_id: string; reason: string }>;
}

/**
 * 把一个信源下的证据标为撤回，并处理依赖它的稿件。
 * 已发布稿只生成勘误提醒：发布事实已经发生，改写它等于篡改历史。
 */
export async function invalidateSource(tx: Tx, sourceId: string, reason = "来源已撤回"): Promise<InvalidationResult> {
  const withdrawn = await tx`
    update waibu_evidence set validity = 'withdrawn'
    where source_id = ${sourceId} and validity <> 'withdrawn'
    returning id`;
  const evidenceIds = withdrawn.map((row) => String(row.id));
  if (evidenceIds.length === 0) {
    return { evidence_withdrawn: 0, claims_downgraded: 0, drafts_held: [], approvals_revoked: 0, errata: [] };
  }

  // 引用这些证据的结论降级为 unsupported：没有有效证据就不能再算已核实。
  const downgraded = await tx`
    update waibu_claims set status = 'unsupported', checked_at = now()
    where status in ('supported', 'disputed') and evidence_ids && ${evidenceIds}::uuid[]
    returning topic_id, id`;

  const topicIds = [...new Set(downgraded.map((row) => String(row.topic_id)))];
  if (topicIds.length === 0) {
    return { evidence_withdrawn: evidenceIds.length, claims_downgraded: 0, drafts_held: [], approvals_revoked: 0, errata: [] };
  }

  const drafts = await tx`
    select d.id, d.state, d.current_revision_id, d.approved_revision_id
    from waibu_drafts d join waibu_topics t on t.id = d.topic_id
    where t.id = any(${topicIds}::uuid[])`;

  const held: string[] = [];
  const errata: InvalidationResult["errata"] = [];
  let revoked = 0;

  for (const draft of drafts) {
    const state = String(draft.state) as ArticleState;
    if (state === "published") {
      if (draft.approved_revision_id) {
        errata.push({ draft_id: String(draft.id), revision_id: String(draft.approved_revision_id), reason });
      }
      continue;
    }
    if (state === "rejected") continue;

    const revokedNow = await tx`
      update waibu_approvals set revoked_at = now(), reason = ${reason}
      where draft_id = ${draft.id} and revoked_at is null returning id`;
    revoked += revokedNow.length;

    await tx`
      update waibu_drafts set state = 'on_hold', approved_revision_id = null, lock_version = lock_version + 1, updated_at = now()
      where id = ${draft.id}`;
    held.push(String(draft.id));
  }

  return { evidence_withdrawn: evidenceIds.length, claims_downgraded: downgraded.length, drafts_held: held, approvals_revoked: revoked, errata };
}

/** 导出前的最后一道检查：批准对应的证据是否仍然有效。 */
export async function validateEvidenceForExport(tx: Tx, draftId: string): Promise<{ ok: boolean; invalid: number }> {
  const [row] = await tx`
    select count(distinct e.id)::int as invalid
    from waibu_drafts d
    join waibu_claims c on c.topic_id = d.topic_id
    cross join lateral unnest(c.evidence_ids) as ev(id)
    join waibu_evidence e on e.id = ev.id
    where d.id = ${draftId} and e.validity <> 'valid'`;
  const invalid = Number(row?.invalid ?? 0);
  return { ok: invalid === 0, invalid };
}
