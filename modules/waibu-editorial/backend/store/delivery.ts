// 素材、发布包与发布登记。导出只对当前有效批准生成；导出不等于已发布，发布事实只由作者登记。
import type { Db, Tx } from "@aihot/backend/db";
import { assetRowSchema, exportRowSchema, publicationRowSchema, type AssetRow, type ExportRow, type PublicationRow } from "../../contracts/entities.ts";
import { EditorialError, versionConflict } from "../../contracts/errors.ts";
import { canTransition } from "../../contracts/states.ts";
import { getDraft, getRevision, lockDraft, setDraftState } from "./drafts.ts";
import { findActiveApproval } from "./review.ts";
import { row, rows } from "./rows.ts";
import { assertAssetUsable } from "../assets/index.ts";
import { assertRevisionValidated } from "../validate/store.ts";

export async function upsertAsset(
  db: Db,
  input: { hash: string; path: string; mime: string; width: number; height: number; origin: AssetRow["origin"]; rights: AssetRow["rights"] },
): Promise<AssetRow> {
  const [saved] = await db`
    insert into waibu_assets (hash, path, mime, width, height, origin, rights)
    values (${input.hash}, ${input.path}, ${input.mime}, ${input.width}, ${input.height}, ${input.origin}, ${input.rights})
    on conflict (hash) do update set path = excluded.path
    returning *`;
  return row(assetRowSchema, saved);
}

export async function getAsset(db: Db, assetId: string): Promise<AssetRow | null> {
  const [found] = await db`select * from waibu_assets where id = ${assetId}`;
  return found ? row(assetRowSchema, found) : null;
}

export async function listAssets(db: Db, hashes: readonly string[]): Promise<AssetRow[]> {
  if (hashes.length === 0) return [];
  const found = await db`select * from waibu_assets where hash = any(${hashes}::text[]) order by created_at`;
  return rows(assetRowSchema, found);
}

export interface CreateExportInput {
  draft_id: string;
  revision_id: string;
  approval_id: string;
  path: string;
  validator_version: string;
}

/**
 * 为“当前有效批准”生成发布包记录。批准被撤销、版本不是批准版本、稿件不在批准或已导出状态时都拒绝。
 * manifest_hash 在渲染完成后由导出任务回填，这里先记为占位失败时也不会出现“可下载”的包。
 */
export async function createExport(db: Tx, input: CreateExportInput): Promise<ExportRow> {
  // 素材授权闸门：使用依据不明的图不能进正式包（封面与配图都算）。
  const revision = await getRevision(db, input.revision_id);
  const referenced = [...(revision?.asset_hashes ?? []), ...(revision?.cover_asset_hash ? [revision.cover_asset_hash] : [])];
  if (referenced.length > 0) {
    const assets = await listAssets(db, referenced);
    const known = new Set(assets.map((asset) => asset.hash));
    for (const hash of referenced) {
      if (!known.has(hash)) throw new EditorialError("asset_not_found", `版本引用的素材不存在：${hash.slice(0, 15)}`);
    }
    for (const asset of assets) assertAssetUsable(asset);
  }

  const draft = await lockDraft(db, input.draft_id);
  const approval = await findActiveApproval(db, input.draft_id);
  if (!approval) throw new EditorialError("approval_required", "没有有效批准，不能导出");
  if (approval.id !== input.approval_id) throw new EditorialError("approval_stale", "批准已变化，请刷新页面后重试");
  if (approval.revision_id !== input.revision_id) throw new EditorialError("approval_stale", "只能导出批准的那一版");
  if (draft.approved_revision_id !== input.revision_id) throw new EditorialError("approval_stale", "当前批准版本已变化");
  if (draft.state !== "approved" && draft.state !== "exported") throw new EditorialError("conflict_state", `当前状态 ${draft.state} 不能导出`, { state: draft.state });
  // 排版校验闸门：批准之后才该校验，没有通过的记录不能生成正式包。
  await assertRevisionValidated(db, input.revision_id);

  const [created] = await db`
    insert into waibu_exports (revision_id, approval_id, manifest_hash, path, validator_version, status)
    values (${input.revision_id}, ${input.approval_id}, ${"sha256:" + "0".repeat(64)}, ${input.path}, ${input.validator_version}, 'queued')
    returning *`;
  return row(exportRowSchema, created);
}

/**
 * 导出任务成功后才写 manifest hash，并把稿件推进到 exported；失败不改稿件状态，
 * 也不产生“可下载但没校验”的包。
 */
export async function finishExport(
  db: Tx,
  exportId: string,
  input: { status: "succeeded" | "failed"; manifest_hash?: string; path?: string },
): Promise<ExportRow> {
  const [saved] = await db`
    update waibu_exports set status = ${input.status},
      manifest_hash = coalesce(${input.manifest_hash ?? null}, manifest_hash),
      path = coalesce(${input.path ?? null}, path)
    where id = ${exportId}
    returning *`;
  if (input.status === "succeeded") {
    await db`
      update waibu_drafts d set state = 'exported', lock_version = d.lock_version + 1, updated_at = now()
      from waibu_revisions r
      where r.id = ${saved.revision_id} and d.id = r.draft_id and d.state = 'approved'`;
  }
  return row(exportRowSchema, saved);
}

export async function getExport(db: Db, exportId: string): Promise<ExportRow | null> {
  const [found] = await db`select * from waibu_exports where id = ${exportId}`;
  return found ? row(exportRowSchema, found) : null;
}

export async function findSucceededExport(db: Db, revisionId: string): Promise<ExportRow | null> {
  const [found] = await db`
    select * from waibu_exports where revision_id = ${revisionId} and status = 'succeeded'
    order by created_at desc limit 1`;
  return found ? row(exportRowSchema, found) : null;
}

export interface RecordPublicationInput {
  draft_id: string;
  revision_id: string;
  published_at: string;
  url: string | null;
  recorded_by: string;
  expected_lock_version: number;
}

/** 作者登记发布事实：exported → published，这是唯一能写 published 的入口。 */
export async function recordPublication(db: Tx, input: RecordPublicationInput): Promise<PublicationRow> {
  const draft = await lockDraft(db, input.draft_id);
  if (draft.lock_version !== input.expected_lock_version) throw versionConflict(input.expected_lock_version, draft.lock_version);
  if (draft.approved_revision_id !== input.revision_id) throw new EditorialError("approval_stale", "只能登记已批准版本的发布");
  if (!canTransition(draft.state, "published", "human")) {
    throw new EditorialError("conflict_state", `当前状态 ${draft.state} 不能登记发布`, { state: draft.state });
  }
  const [created] = await db`
    insert into waibu_publications (revision_id, channel, published_at, url, recorded_by)
    values (${input.revision_id}, 'wechat_mp', ${input.published_at}, ${input.url}, ${input.recorded_by})
    returning *`;
  await setDraftState(db, { draft_id: input.draft_id, expected_lock_version: input.expected_lock_version, next_state: "published" });
  return row(publicationRowSchema, created);
}

export async function listPublications(db: Db, revisionId: string): Promise<PublicationRow[]> {
  const found = await db`select * from waibu_publications where revision_id = ${revisionId} order by published_at desc`;
  return rows(publicationRowSchema, found);
}

/** 供页面判断是否显示“已发布”：以登记记录为准，不看导出状态。 */
export async function draftOfPublication(db: Db, publicationId: string): Promise<string | null> {
  const [found] = await db`
    select r.draft_id from waibu_publications p join waibu_revisions r on r.id = p.revision_id where p.id = ${publicationId}`;
  return found ? String(found.draft_id) : null;
}

export { getDraft };
