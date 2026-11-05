// 版本内容与内容 hash。批准的绑定对象是 revision_id + content_hash，所以 hash 的算法一旦发布就不能改：
// 改算法等于让所有历史批准失效。新增字段时只能追加到已有字段之后并升 content_hash_version。
import { createHash } from "node:crypto";

/** 当前内容 hash 算法版本，写进 revisions 与发布包 manifest。 */
export const CONTENT_HASH_VERSION = 1;

/** 一个 revision 参与 hash 的全部内容。字段顺序即规范顺序，不依赖对象键顺序。 */
export interface RevisionContent {
  title: string;
  summary: string;
  body: string;
  /** 封面素材的内容 hash；没有封面时为 null。 */
  cover_asset_hash: string | null;
  /** 正文内图注：block_id → 图注文字。 */
  captions: Record<string, string>;
  /** 正文引用的素材内容 hash，去重后排序。 */
  asset_hashes: readonly string[];
}

/**
 * 写库前的文本规范化：统一换行、统一 Unicode 组合形式。
 * 写入与计算 hash 必须用同一份规范化结果，否则同一次保存会得到不同 hash。
 */
export function normalizeEditorialText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").normalize("NFC");
}

/** 把内容规范化成将要落库的形状；调用方存这份结果，不要存原始输入。 */
export function normalizeRevisionContent(content: RevisionContent): RevisionContent {
  const captions = Object.fromEntries(
    Object.entries(content.captions)
      .map(([block, text]) => [block, normalizeEditorialText(text)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return {
    title: normalizeEditorialText(content.title),
    summary: normalizeEditorialText(content.summary),
    body: normalizeEditorialText(content.body),
    cover_asset_hash: content.cover_asset_hash,
    captions,
    asset_hashes: [...new Set(content.asset_hashes)].sort(),
  };
}

/** 确定性 JSON：对象键排序，其余按 JSON 语义，用于把内容折成 hash 输入。 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) out[key] = walk((v as Record<string, unknown>)[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 内容 hash：覆盖标题、摘要、正文、封面、图注与素材 hash。
 * 任何一项变化都产生新 hash，从而使旧批准失效（见 states.ts stateAfterContentChange）。
 */
export function contentHash(content: RevisionContent): string {
  const normalized = normalizeRevisionContent(content);
  const payload = {
    v: CONTENT_HASH_VERSION,
    title: normalized.title,
    summary: normalized.summary,
    body: normalized.body,
    cover: normalized.cover_asset_hash,
    captions: normalized.captions,
    assets: normalized.asset_hashes,
  };
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

/** 发布包 manifest 的 hash：覆盖包内文件名与各自的 hash。 */
export function manifestHash(files: ReadonlyArray<{ path: string; sha256: string }>): string {
  const payload = files
    .map((f) => ({ path: f.path, sha256: f.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

/** 任务输入 hash 的通用折法：同样的输入必须得到同样的 key，恢复时不重复生成。 */
export function inputHash(parts: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(parts))}`;
}
