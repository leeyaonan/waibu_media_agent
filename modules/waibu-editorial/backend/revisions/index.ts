// 稿件版本的写入策略。两条路径刻意分开：
// - 作者编辑：永远成为当前版本，旧批准作废，回自检；
// - 模型产出：带基准版本回来，基准已过期就只作为“分支产物”留档，绝不覆盖作者最新稿。
//
// 版本行只插入不更新，冲突时保存的是工件而不是覆盖，审计能看到“当时模型写了什么”。
import type { Db, Tx } from "@aihot/backend/db";
import { revisionRowSchema, type DraftRow, type RevisionRow } from "../../contracts/entities.ts";
import { contentHash, normalizeRevisionContent, type RevisionContent } from "../../contracts/content.ts";
import { stateAfterContentChange } from "../../contracts/states.ts";
import { appendRevision, getDraft, lockDraft } from "../store/drafts.ts";
import { row } from "../store/rows.ts";

export interface AuthorEditInput {
  draft_id: string;
  expected_lock_version: number;
  base_revision_id: string;
  content: RevisionContent;
  policy_version: string;
}

/** 作者直接编辑：产生新版本、撤销批准、回到自检。 */
export async function applyAuthorEdit(tx: Tx, input: AuthorEditInput): Promise<{ revision: RevisionRow; draft: DraftRow }> {
  const draft = await lockDraft(tx, input.draft_id);
  const next = stateAfterContentChange(draft.state);
  return appendRevision(tx, {
    draft_id: input.draft_id,
    parent_id: input.base_revision_id,
    content: input.content,
    policy_version: input.policy_version,
    created_by: "author",
    expected_lock_version: input.expected_lock_version,
    next_state: next,
  });
}

export type GeneratedOutcome =
  | { kind: "applied"; revision: RevisionRow; draft: DraftRow }
  | { kind: "conflict"; revision: RevisionRow; current: DraftRow };

export interface GeneratedRevisionInput {
  draft_id: string;
  /** 生成任务开始时的当前版本。 */
  base_revision_id: string;
  content: RevisionContent;
  policy_version: string;
  created_by?: "model" | "model_after_feedback";
}

/**
 * 模型产出回写。基准版本仍是当前版本才推进；否则把结果存成分支产物并报告冲突。
 * 调用方拿到 conflict 时不要重试覆盖，让作者决定要不要看这份产物。
 */
export async function applyGeneratedRevision(tx: Tx, input: GeneratedRevisionInput): Promise<GeneratedOutcome> {
  const draft = await lockDraft(tx, input.draft_id);
  if (draft.current_revision_id !== input.base_revision_id) {
    const artifact = await appendArtifact(tx, input);
    return { kind: "conflict", revision: artifact, current: draft };
  }
  const applied = await appendRevision(tx, {
    draft_id: input.draft_id,
    parent_id: input.base_revision_id,
    content: input.content,
    policy_version: input.policy_version,
    created_by: input.created_by ?? "model",
    expected_lock_version: draft.lock_version,
    next_state: "checking",
  });
  return { kind: "applied", revision: applied.revision, draft: applied.draft };
}

/** 只插入版本行，不移动 current 指针、不改 lock_version；hash 与 store 层同一套算法。 */
async function appendArtifact(tx: Db, input: GeneratedRevisionInput): Promise<RevisionRow> {
  const content = normalizeRevisionContent(input.content);
  const hash = contentHash(content);
  const [inserted] = await tx`
    insert into waibu_revisions (draft_id, parent_id, title, summary, body, cover_asset_hash, captions, asset_hashes, content_hash, policy_version, created_by)
    values (${input.draft_id}, ${input.base_revision_id}, ${content.title}, ${content.summary}, ${content.body},
            ${content.cover_asset_hash}, ${tx.json(content.captions as never)}, ${content.asset_hashes},
            ${hash}, ${input.policy_version}, ${input.created_by ?? "model"})
    returning *`;
  return row(revisionRowSchema, inserted);
}

export interface RevisionDiff {
  title_changed: boolean;
  summary_changed: boolean;
  body_changed: boolean;
  /** 按空行切段后逐段对比的结果，页面用来定位改动。 */
  blocks: Array<{ index: number; before: string | null; after: string | null }>;
}

/** 两个版本的差异。只做段落级对比，够审核页用，不做字符级 diff。 */
export function diffRevisions(before: Pick<RevisionRow, "title" | "summary" | "body">, after: Pick<RevisionRow, "title" | "summary" | "body">): RevisionDiff {
  const split = (text: string) => text.split(/\n\s*\n/u).map((block) => block.trim()).filter(Boolean);
  const a = split(before.body);
  const b = split(after.body);
  const blocks: RevisionDiff["blocks"] = [];
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? null;
    const right = b[index] ?? null;
    if (left !== right) blocks.push({ index, before: left, after: right });
  }
  return {
    title_changed: before.title !== after.title,
    summary_changed: before.summary !== after.summary,
    body_changed: before.body !== after.body,
    blocks,
  };
}

/** 页面判断“这是不是当前版本”只认这个比较，不看创建时间。 */
export function isCurrent(revision: RevisionRow, draft: DraftRow): boolean {
  return draft.current_revision_id === revision.id;
}

export async function loadDraft(tx: Db, draftId: string): Promise<DraftRow | null> {
  return getDraft(tx, draftId);
}
