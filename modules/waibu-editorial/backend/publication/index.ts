// 手工发布登记：作者在公众号后台发布之后，回到工作台记一笔。
//
// 三条边界：
// 1. 导出不等于发布：只有作者登记才把稿件推进到 published；
// 2. 只认当前批准版本：登记时版本对不上就拒绝，不猜；
// 3. 发布事实不改写：勘误只追加记录，不修改原登记。
import type { Db, Tx } from "@aihot/backend/db";
import { errataRowSchema, type ErrataRow, type PublicationRow } from "../../contracts/entities.ts";
import { EditorialError } from "../../contracts/errors.ts";
import { listPublications, recordPublication } from "../store/delivery.ts";
import { row, rows } from "../store/rows.ts";

export interface RegisterInput {
  draft_id: string;
  revision_id: string;
  expected_lock_version: number;
  published_at: string;
  url: string;
  recorded_by: string;
}

/** URL 只接受公众号文章链接：别的域名会被当成录错。 */
export function assertWechatUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EditorialError("invalid_request", "请填写完整的公众号文章链接");
  }
  if (!/^https?:$/u.test(parsed.protocol) || !/(^|\.)mp\.weixin\.qq\.com$/u.test(parsed.hostname)) {
    throw new EditorialError("invalid_request", "链接应当是 mp.weixin.qq.com 的文章地址");
  }
}

/** 登记发布：必须先导出过（状态 exported），且版本仍是当前批准版本。 */
export async function registerPublication(tx: Tx, input: RegisterInput): Promise<PublicationRow> {
  assertWechatUrl(input.url);
  return recordPublication(tx, {
    draft_id: input.draft_id,
    revision_id: input.revision_id,
    expected_lock_version: input.expected_lock_version,
    published_at: input.published_at,
    url: input.url,
    recorded_by: input.recorded_by,
  });
}

export interface ErrataInput {
  publication_id: string;
  note: string;
  recorded_by: string;
}

/** 勘误：只追加，不改原登记的链接、时间与版本。 */
export async function appendErrata(db: Tx, input: ErrataInput): Promise<ErrataRow> {
  const note = input.note.trim();
  if (note.length === 0) throw new EditorialError("invalid_request", "勘误内容不能为空");
  const [publication] = await db`select id from waibu_publications where id = ${input.publication_id}`;
  if (!publication) throw new EditorialError("not_found", "发布登记不存在");
  const [created] = await db`
    insert into waibu_errata (publication_id, note, recorded_by)
    values (${input.publication_id}, ${note.slice(0, 2000)}, ${input.recorded_by})
    returning *`;
  return row(errataRowSchema, created);
}

export async function listErrata(db: Db, publicationId: string): Promise<ErrataRow[]> {
  const found = await db`select * from waibu_errata where publication_id = ${publicationId} order by created_at`;
  return rows(errataRowSchema, found);
}

export interface ExternalEditInput {
  draft_id: string;
  expected_lock_version: number;
  base_revision_id: string;
  title: string;
  summary: string;
  body: string;
  policy_version: string;
}

/**
 * 在公众号后台手改过的版本要先导入成新版本：
 * 产生新版本 → 批准随之撤销 → 必须重新审核、重新导出，才能登记发布。
 * 这样“系统里的版本”永远等于“发出去的版本”，不会出现两条并行的真相。
 */
export async function importExternalEdit(tx: Tx, input: ExternalEditInput): Promise<{ revisionId: string; draftState: string }> {
  const { applyAuthorEdit } = await import("../revisions/index.ts");
  const saved = await applyAuthorEdit(tx, {
    draft_id: input.draft_id,
    expected_lock_version: input.expected_lock_version,
    base_revision_id: input.base_revision_id,
    content: {
      title: input.title,
      summary: input.summary,
      body: input.body,
      cover_asset_hash: null,
      captions: {},
      asset_hashes: [],
    },
    policy_version: input.policy_version,
  });
  return { revisionId: saved.revision.id, draftState: saved.draft.state };
}

/** 页面用：这篇稿子的全部发布记录与对应勘误。 */
export async function publicationHistory(db: Db, revisionIds: readonly string[]): Promise<Array<{ publication: PublicationRow; errata: ErrataRow[] }>> {
  const history: Array<{ publication: PublicationRow; errata: ErrataRow[] }> = [];
  for (const revisionId of revisionIds) {
    for (const publication of await listPublications(db, revisionId)) {
      history.push({ publication, errata: await listErrata(db, publication.id) });
    }
  }
  return history;
}
