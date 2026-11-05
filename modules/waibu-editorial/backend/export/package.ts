// 正式发布包：只对“当前有效批准 + 排版校验通过”的版本生成。
//
// 包里放的是作者复制粘贴与核对要用的全部材料：正文片段、纯文字、标题摘要、
// 封面、素材清单、校验报告、发布说明与清单文件。清单里的 hash 让作者能确认
// 自己拿到的包和当时批准的版本一致。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssetRow, ExportRow, RevisionRow } from "../../contracts/entities.ts";
import { createHash } from "node:crypto";
import { EditorialError } from "../../contracts/errors.ts";
import { renderWechat } from "../render/index.ts";
import { VALIDATOR_ID, type ValidationReport } from "../validate/index.ts";
import { createZip, fileManifest, type ZipEntry } from "./zip.ts";

export interface PackageInput {
  revision: RevisionRow;
  exportRow: ExportRow;
  validation: ValidationReport;
  assets: readonly AssetRow[];
  /** 数据目录：素材原文件在这里。 */
  dataDir: string;
  /** 生成时间，注入以便测试可复现。 */
  now?: Date;
}

export interface PackageResult {
  zipPath: string;
  manifestHash: string;
  manifest: { path: string; bytes: number; sha256: string }[];
  files: string[];
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** 素材清单：来源、授权、尺寸、hash 全写清楚，作者上传图片时照着核对。 */
export function renderAssetList(assets: readonly AssetRow[]): string {
  if (assets.length === 0) return "# 素材清单\n\n本文没有配图。\n";
  const lines = ["# 素材清单", "", "图片需要在公众号素材库手动上传；包内 `images/` 下是原始文件。", ""];
  for (const asset of assets) {
    lines.push(`## ${asset.hash.slice(0, 15)}`);
    lines.push("");
    lines.push(`- 文件：images/${asset.hash.replace(/^sha256:/u, "")}.bin`);
    lines.push(`- 尺寸：${asset.width}×${asset.height}`);
    lines.push(`- 类型：${asset.mime}`);
    lines.push(`- 来源：${asset.origin}`);
    lines.push(`- 使用依据：${asset.rights}`);
    lines.push(`- 完整 hash：${asset.hash}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** 发布说明：把“需要人工做的事”和“没被验证的事”写在最前面。 */
export function renderPublishNotes(input: { revision: RevisionRow; approvedAt: string; validator: string }): string {
  return [
    "# 发布说明",
    "",
    `- 版本：${input.revision.id}`,
    `- 内容 hash：${input.revision.content_hash}`,
    `- 批准时间：${input.approvedAt}`,
    `- 排版校验：${input.validator}`,
    "",
    "## 必须人工完成",
    "",
    "1. 把 `正文.html` 的内容粘贴进公众号编辑器（或按 `正文.md` 重新排版）。",
    "2. 手动上传 `images/` 里的全部图片，并按 `素材清单.md` 核对授权。",
    "3. 标题与摘要按 `标题摘要.json` 填写；它们不在复制正文里。",
    "",
    "## 没有验证的事",
    "",
    "- 公众号后台的最终渲染效果**没有**被自动验证，需要你粘贴后目视确认。",
    "- 发布状态不会被本系统自动改变；发布后请在发布登记里记录实际链接与时间。",
    "",
    "## 如果内容有误",
    "",
    "请不要直接改已发布的文章后重新导出。改稿会产生新版本、撤销当前批准并需要重新校验，",
    "新包与旧包是两次独立导出；已发布内容的更正以勘误形式记录。",
    "",
  ].join("\n");
}

/** 生成发布包并落盘。任何一步失败都抛错，调用方不写 succeeded。 */
export async function buildExportPackage(input: PackageInput): Promise<PackageResult> {
  const { revision } = input;
  const assetsByHash = new Map(input.assets.map((asset) => [asset.hash, asset]));

  const rendered = renderWechat({
    markdown: revision.body,
    title: revision.title,
    resolveImage: (hash) => {
      const asset = assetsByHash.get(hash);
      return asset ? { mime: asset.mime, width: asset.width, height: asset.height } : null;
    },
    imageSrc: (image) => {
      const asset = assetsByHash.get(image.hash);
      return asset ? `images/${asset.hash.replace(/^sha256:/u, "")}.bin` : "";
    },
  });

  const entries: ZipEntry[] = [];
  entries.push({ name: "正文.html", bytes: text(rendered.html) });
  entries.push({ name: "正文.md", bytes: text(revision.body) });
  entries.push({ name: "纯文字.txt", bytes: text(rendered.plainText) });
  entries.push({
    name: "标题摘要.json",
    bytes: text(JSON.stringify({ title: revision.title, summary: revision.summary, content_hash: revision.content_hash }, null, 2)),
  });
  entries.push({ name: "素材清单.md", bytes: text(renderAssetList(input.assets)) });
  entries.push({
    name: "校验报告.json",
    bytes: text(JSON.stringify({ ...input.validation, validator: VALIDATOR_ID }, null, 2)),
  });
  entries.push({
    name: "发布说明.md",
    // 用版本自己的时间：同一版本重复打包必须得到同一份内容。
    bytes: text(renderPublishNotes({ revision, approvedAt: revision.created_at, validator: VALIDATOR_ID })),
  });

  // 图片原文件：读不到就失败，绝不产出缺图的包。
  for (const asset of input.assets) {
    const file = path.join(input.dataDir, asset.path);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(file));
    } catch {
      throw new EditorialError("export_failed", `素材文件缺失，无法打包：${asset.hash.slice(0, 15)}`);
    }
    entries.push({ name: `images/${asset.hash.replace(/^sha256:/u, "")}.bin`, bytes });
  }

  const manifest = { files: fileManifest(entries) };
  entries.push({ name: "manifest.json", bytes: text(JSON.stringify(manifest, null, 2)) });
  // 清单 hash 覆盖每个文件的路径、字节数与内容 hash：包被改过就对不上。
  const manifestHash = `sha256:${createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex")}`;

  const zip = createZip(entries);
  const dir = path.join(input.dataDir, "exports");
  await mkdir(dir, { recursive: true });
  const name = `${revision.id}-${manifestHash.slice(7, 19)}.zip`;
  const zipPath = path.join("exports", name);
  await writeFile(path.join(input.dataDir, zipPath), zip);

  return {
    zipPath,
    manifestHash,
    manifest: manifest.files,
    files: entries.map((entry) => entry.name),
  };
}
