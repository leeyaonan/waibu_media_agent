// 素材与封面。
//
// 两条硬规则：
// 1. 只记录真实存在的图：字节自己解出 MIME 与尺寸，不信上传时说的；
// 2. 不生成假图：没有可用配图时生成“明确是设计图”的文字封面，绝不伪造产品截图。
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssetRow } from "../../contracts/entities.ts";
import { EditorialError } from "../../contracts/errors.ts";

/** 单张图上限 5MB：公众号封面与配图远小于此。 */
export const ASSET_LIMIT = 5 * 1024 * 1024;
/** 公众号头条封面比例 2.35:1。 */
export const COVER_WIDTH = 1175;
export const COVER_HEIGHT = 500;

export interface ImageInfo {
  mime: string;
  width: number;
  height: number;
}

/** 从字节头解析图片类型与尺寸；解析不了就拒绝，不靠扩展名猜。 */
export function detectImage(bytes: Uint8Array): ImageInfo {
  if (bytes.byteLength > ASSET_LIMIT) throw new EditorialError("asset_rejected", `图片超过 ${Math.round(ASSET_LIMIT / 1024 / 1024)}MB`);
  if (bytes.byteLength < 12) throw new EditorialError("asset_rejected", "文件太小，不是有效图片");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG：89 50 4E 47 0D 0A 1A 0A，宽高在 IHDR
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG：FF D8，扫段找 SOF
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1]!;
      const length = view.getUint16(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
    throw new EditorialError("asset_rejected", "JPEG 里找不到尺寸信息");
  }
  // GIF：GIF8，宽高是小端 16 位
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { mime: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  // WebP：RIFF....WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) {
    const format = String.fromCharCode(...bytes.slice(12, 16));
    if (format === "VP8X") {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return { mime: "image/webp", width, height };
    }
    if (format === "VP8 ") {
      return { mime: "image/webp", width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
  }
  throw new EditorialError("asset_rejected", "只支持 PNG、JPEG、GIF、WebP 图片");
}

/** 素材能否进正式发布包：使用依据必须是明确的，unknown 一律不放过。 */
export function assertAssetUsable(asset: Pick<AssetRow, "hash" | "rights" | "origin">): void {
  if (asset.rights === "unknown") {
    throw new EditorialError("asset_rights_unknown", `素材 ${asset.hash.slice(7, 15)} 没有明确的使用依据，不能进正式发布包`, { hash: asset.hash });
  }
}

export function assetHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** 落到私有数据目录：按 hash 分两级目录，文件名就是 hash，天然去重。 */
export async function writeAssetFile(dataDir: string, bytes: Uint8Array, hash: string): Promise<string> {
  const digest = hash.replace(/^sha256:/u, "");
  const relative = path.posix.join("assets", digest.slice(0, 2), `${digest}.bin`);
  const absolute = path.join(dataDir, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  return relative;
}

/**
 * 确定性文字封面：同一标题永远得到同一份字节。
 * 页脚明确写“设计图”，避免被当成产品截图。
 */
export function renderTextCover(input: { title: string; kicker?: string; brand?: string }): { svg: string; bytes: Uint8Array } {
  const brand = input.brand ?? "歪布";
  const kicker = (input.kicker ?? "AI 歪布").slice(0, 24);
  // 按字数折行：一行最多 14 个全角字符，最多三行。
  const chars = [...input.title.trim()];
  const lines: string[] = [];
  for (let i = 0; i < chars.length && lines.length < 3; i += 14) lines.push(chars.slice(i, i + 14).join(""));
  const escape = (text: string) => text.replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

  const body = lines
    .map((line, index) => `<text x="72" y="${210 + index * 96}" font-size="76" font-weight="700" fill="#ffffff">${escape(line)}</text>`)
    .join("\n  ");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_WIDTH}" height="${COVER_HEIGHT}" viewBox="0 0 ${COVER_WIDTH} ${COVER_HEIGHT}">
  <rect width="${COVER_WIDTH}" height="${COVER_HEIGHT}" fill="#12100e"/>
  <rect x="0" y="0" width="12" height="${COVER_HEIGHT}" fill="#e0b060"/>
  <text x="72" y="130" font-size="34" fill="#e0b060" letter-spacing="6">${escape(kicker)}</text>
  ${body}
  <text x="72" y="${COVER_HEIGHT - 56}" font-size="26" fill="#8f8a83">${escape(brand)} · 设计图（非产品截图）</text>
</svg>`;
  return { svg, bytes: new TextEncoder().encode(svg) };
}

/** 封面是“生成的设计图”，来源与使用依据都明确，不需要人工确认。 */
export const GENERATED_COVER_POLICY = { origin: "generated_cover", rights: "public" } as const;
