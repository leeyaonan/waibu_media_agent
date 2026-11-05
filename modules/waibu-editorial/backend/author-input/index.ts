// 作者材料：手稿、笔记、实测记录。它决定两件事——
// 1. 有没有第一人称材料的依据（没有就不能写“我实测过”）；
// 2. 手稿可以直接成为一个版本，作为后续改稿的基线。
//
// 上传只接受文本类文件，按内容 hash 去重；下载走私人接口，未登录读不到。
import type { Db, Tx } from "@aihot/backend/db";
import { versionConflict } from "../../contracts/errors.ts";
import { contentHash, normalizeRevisionContent } from "../../contracts/content.ts";
import { getDraft, getRevision, listRevisions } from "../store/drafts.ts";
import { applyAuthorEdit } from "../revisions/index.ts";

/** 单个材料文件上限 2MB：文字稿不需要更大，太大通常意味着传错了文件。 */
export const AUTHOR_FILE_LIMIT = 2 * 1024 * 1024;

export const ALLOWED_MIME = ["text/plain", "text/markdown", "text/x-markdown", "application/octet-stream"] as const;

export interface AuthorFile {
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

export class AuthorFileRejected extends Error {
  readonly code: "asset_rejected" | "invalid_request";
  constructor(code: "asset_rejected" | "invalid_request", message: string) {
    super(message);
    this.name = "AuthorFileRejected";
    this.code = code;
  }
}

/** 只认纯文本类；图片、压缩包、PDF 一律拒绝，避免把二进制当正文写进版本。 */
export function validateAuthorFile(file: AuthorFile): string {
  if (!ALLOWED_MIME.includes(file.mime as (typeof ALLOWED_MIME)[number])) {
    throw new AuthorFileRejected("asset_rejected", `不支持的文件类型：${file.mime}，请上传 Markdown 或纯文本`);
  }
  if (file.bytes.byteLength > AUTHOR_FILE_LIMIT) {
    throw new AuthorFileRejected("asset_rejected", `文件超过 ${Math.round(AUTHOR_FILE_LIMIT / 1024)}KB 上限`);
  }
  if (!/\.(md|markdown|txt)$/iu.test(file.filename)) {
    throw new AuthorFileRejected("asset_rejected", "文件扩展名必须是 .md、.markdown 或 .txt");
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(file.bytes).trim();
  if (text.length === 0) throw new AuthorFileRejected("invalid_request", "文件是空的");
  if (text.includes("\u0000")) throw new AuthorFileRejected("invalid_request", "文件不是文本格式");
  return text;
}

export interface ImportResult {
  revisionId: string;
  /** 内容与已有版本相同，没有新建。 */
  duplicate: boolean;
}

/**
 * 把作者手稿存成一个新版本作为基线。同一份内容重复上传不会堆出版本。
 * 标题取文件首行（去掉 Markdown 标记），取不到就用文件名。
 */
export async function importAuthorManuscript(
  tx: Tx,
  input: { draft_id: string; expected_lock_version: number; filename: string; text: string; policy_version: string },
): Promise<ImportResult> {
  const draft = await getDraft(tx, input.draft_id);
  if (!draft) throw new AuthorFileRejected("invalid_request", "稿件不存在");

  const title = firstLineTitle(input.text) ?? input.filename.replace(/\.[^.]+$/u, "");
  const content = normalizeRevisionContent({
    title,
    summary: "",
    body: input.text,
    cover_asset_hash: null,
    captions: {},
    asset_hashes: [],
  });

  const existing = await listRevisions(tx, input.draft_id);
  const hash = contentHash(content);
  const same = existing.find((revision) => revision.content_hash === hash);
  // 重复上传先于版本校验：同一份材料再传一次不该因为“版本变了”而失败。
  if (same) return { revisionId: same.id, duplicate: true };
  if (draft.lock_version !== input.expected_lock_version) throw versionConflict(input.expected_lock_version, draft.lock_version);

  const applied = await applyAuthorEdit(tx, {
    draft_id: input.draft_id,
    expected_lock_version: draft.lock_version,
    base_revision_id: draft.current_revision_id ?? existing[0]?.id ?? null,
    content,
    policy_version: input.policy_version,
  });
  return { revisionId: applied.revision.id, duplicate: false };
}

function firstLineTitle(text: string): string | null {
  for (const line of text.split("\n")) {
    const cleaned = line.replace(/^#+\s*/u, "").trim();
    if (cleaned) return cleaned.slice(0, 200);
  }
  return null;
}

/** 这篇稿子有没有作者提供的材料（作者直接写的版本）。 */
export async function hasAuthorMaterial(db: Db, draftId: string): Promise<boolean> {
  const revisions = await listRevisions(db, draftId);
  return revisions.some((revision) => revision.created_by === "author");
}

/** 第一人称亲历标记：没有作者材料时，这些说法一律不能出现。 */
const EXPERIENCE_MARKERS = [/我(?:亲自)?(?:实测|试了|试过|用了|跑了)/u, /我花(?:了)?[^，。]{0,8}(?:小时|分钟|天)/u, /一次(?:就)?成功/u, /我的手感/u];

export interface ExperienceGuard {
  offending: string[];
  allowed: boolean;
}

/**
 * 扫描正文里的第一人称亲历。没有作者材料时返回 allowed=false，
 * 起草与自检都调用它，避免产出“我实测”这类编造。
 */
export function guardFirstPersonExperience(text: string, hasMaterial: boolean): ExperienceGuard {
  const offending: string[] = [];
  for (const marker of EXPERIENCE_MARKERS) {
    const match = marker.exec(text);
    if (match) offending.push(match[0]);
  }
  return { offending, allowed: hasMaterial || offending.length === 0 };
}

/** 材料正文下载：返回给有会话的人，作为纯文本。 */
export async function loadRevisionText(db: Db, revisionId: string): Promise<{ title: string; body: string } | null> {
  const revision = await getRevision(db, revisionId);
  return revision ? { title: revision.title, body: revision.body } : null;
}
