// 把封面与素材绑到版本上：换封面、加图都会形成新版本并重新审核。
import type { Tx } from "@aihot/backend/db";
import type { DraftRow, RevisionRow } from "../../contracts/entities.ts";
import { EditorialError } from "../../contracts/errors.ts";
import { applyAuthorEdit } from "../revisions/index.ts";
import { getRevision } from "../store/drafts.ts";
import { listAssets } from "../store/delivery.ts";
import { assertAssetUsable } from "./index.ts";

export interface BindAssetsInput {
  draft_id: string;
  expected_lock_version: number;
  base_revision_id: string;
  /** 不传就沿用当前封面；传 null 表示去掉封面。 */
  cover_asset_hash?: string | null;
  asset_hashes?: string[];
}

/** 素材必须已经在库里，且使用依据明确，才允许绑定。 */
async function assertKnownAssets(tx: Tx, hashes: readonly string[]): Promise<void> {
  if (hashes.length === 0) return;
  const found = await listAssets(tx, hashes);
  const known = new Set(found.map((asset) => asset.hash));
  for (const hash of hashes) {
    if (!known.has(hash)) throw new EditorialError("asset_not_found", `素材不存在：${hash.slice(0, 15)}`, { hash });
  }
  for (const asset of found) assertAssetUsable(asset);
}

/** 绑定素材会产生新版本：标题正文不动，但封面或配图参与 content_hash，批准随之撤销。 */
export async function bindRevisionAssets(tx: Tx, input: BindAssetsInput): Promise<{ revision: RevisionRow; draft: DraftRow }> {
  const base = await getRevision(tx, input.base_revision_id);
  if (!base || base.draft_id !== input.draft_id) throw new EditorialError("not_found", "版本不存在或不属于这篇稿件");

  const cover = input.cover_asset_hash === undefined ? base.cover_asset_hash : input.cover_asset_hash;
  const assets = input.asset_hashes ?? base.asset_hashes;
  await assertKnownAssets(tx, [...assets, ...(cover ? [cover] : [])]);

  return applyAuthorEdit(tx, {
    draft_id: input.draft_id,
    expected_lock_version: input.expected_lock_version,
    base_revision_id: input.base_revision_id,
    content: {
      title: base.title,
      summary: base.summary,
      body: base.body,
      cover_asset_hash: cover,
      captions: base.captions,
      asset_hashes: assets,
    },
    policy_version: base.policy_version,
  });
}
