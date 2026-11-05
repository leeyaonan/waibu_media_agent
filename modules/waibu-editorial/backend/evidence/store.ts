// 证据落库与结论登记。快照只追加：同一篇文章的新摘要作为新行，旧行标 changed，
// 这样“作者当时依据的是哪一版网页”永远查得到。
import type { Db } from "@aihot/backend/db";
import { evidenceRowSchema, claimRowSchema, type ClaimRow, type EvidenceRow } from "../../contracts/entities.ts";
import type { MaterialSource } from "../materials/adapter.ts";
import { findConflictingClaims, judgeSupport, sanitizeUntrusted } from "./support.ts";
import { row, rows } from "../store/rows.ts";

export interface PersistResult {
  inserted: number;
  unchanged: number;
  /** 内容变过、旧快照被标为 changed 的文章。 */
  changed: string[];
}

/**
 * 把素材写成证据快照。同一篇文章同一摘要重复导入不产生新行；
 * 摘要变了就追加新行并把旧的标为 changed——网页更新不会覆盖历史。
 */
export async function persistMaterials(db: Db, materials: readonly MaterialSource[]): Promise<PersistResult> {
  let inserted = 0;
  let unchanged = 0;
  const changed: string[] = [];

  for (const material of materials) {
    const [existing] = await db`
      select id from waibu_evidence where article_id = ${material.article_id} and hash = ${material.hash} limit 1`;
    if (existing) {
      unchanged += 1;
      continue;
    }

    const superseded = await db`
      update waibu_evidence set validity = 'changed'
      where article_id = ${material.article_id} and validity = 'valid'
      returning id`;
    if (superseded.length > 0) changed.push(material.article_id);

    const sanitized = sanitizeUntrusted(material.excerpt);
    await db`
      insert into waibu_evidence (source_id, article_id, url, published_at, excerpt, hash, rights)
      values (${material.source_id}, ${material.article_id}, ${material.url}, ${material.published_at},
              ${sanitized.text}, ${material.hash}, ${material.rights})`;
    inserted += 1;
  }

  return { inserted, unchanged, changed };
}

export async function evidenceFor(db: Db, ids: readonly string[]): Promise<EvidenceRow[]> {
  if (ids.length === 0) return [];
  const found = await db`select * from waibu_evidence where id = any(${ids}::uuid[]) order by created_at`;
  return rows(evidenceRowSchema, found);
}

export interface ClaimDraft {
  text: string;
  kind: "factual" | "inference" | "author_opinion";
  evidence_ids: string[];
}

export interface RecordedClaim extends ClaimRow {
  /** 判定原因，页面在证据抽屉里显示。 */
  reason: string;
}

/**
 * 登记模型给出的结论，并当场算状态：
 * 数字找不到出处、只有摘要、证据不足的都进 unsupported；
 * 同一稿子里互相打架的两条标 disputed，不替作者挑。
 */
export async function recordClaims(db: Db, topicId: string, drafts: readonly ClaimDraft[]): Promise<RecordedClaim[]> {
  const allEvidence = await evidenceFor(db, [...new Set(drafts.flatMap((draft) => draft.evidence_ids))]);
  const byId = new Map(allEvidence.map((evidence) => [evidence.id, evidence]));

  const provisional = drafts.map((draft, index) => {
    const evidences = draft.evidence_ids.map((id) => byId.get(id)).filter((item): item is EvidenceRow => Boolean(item));
    const verdict = draft.kind === "factual" ? judgeSupport(draft.text, evidences) : { status: "supported" as const, missing: [], independent: evidences.length, reason: "推断或作者观点，不要求逐条证据" };
    return { draft, verdict, index, id: `draft-${index}` };
  });

  const conflicts = findConflictingClaims(provisional.map(({ draft, id }) => ({ id, text: draft.text, kind: draft.kind, evidence_ids: draft.evidence_ids })));

  const recorded: RecordedClaim[] = [];
  for (const item of provisional) {
    const disputed = conflicts.has(item.id);
    const status = disputed ? "disputed" : item.verdict.status;
    const reason = disputed ? "同一篇稿子里出现互相冲突的取值，交由作者判断" : item.verdict.reason;
    const [inserted] = await db`
      insert into waibu_claims (topic_id, text, kind, evidence_ids, status, checked_at)
      values (${topicId}, ${item.draft.text}, ${item.draft.kind}, ${item.draft.evidence_ids}::uuid[],
              ${status}, ${new Date()})
      returning *`;
    recorded.push({ ...row(claimRowSchema, inserted), reason });
  }
  return recorded;
}
