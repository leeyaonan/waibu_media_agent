// 导出执行：读批准版本 → 取最近一次通过的校验 → 打包 → 成功才写 succeeded。
//
// 失败不留下“可下载但没校验”的包：export 记录状态写 failed，稿件状态不动。
import type { Db } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { getRevision } from "../store/drafts.ts";
import { finishExport, getExport, listAssets } from "../store/delivery.ts";
import { assertRevisionValidated } from "../validate/store.ts";
import { EditorialError } from "../../contracts/errors.ts";
import { buildExportPackage } from "./package.ts";

export interface RunExportResult {
  exportId: string;
  status: "succeeded" | "failed";
  zipPath: string | null;
  manifestHash: string | null;
  error: string | null;
}

/** 打包并落状态。抛错前先把失败状态写库，避免记录永远停在 queued。 */
export async function runExport(db: Db, exportId: string): Promise<RunExportResult> {
  const exportRow = await getExport(db, exportId);
  if (!exportRow) throw new EditorialError("not_found", "导出记录不存在");

  try {
    const revision = await getRevision(db, exportRow.revision_id);
    if (!revision) throw new EditorialError("not_found", "版本不存在");
    // 打包前再确认一次：校验可能在这期间被新结果覆盖。
    const validation = await assertRevisionValidated(db, revision.id);

    const referenced = [...(revision.asset_hashes ?? []), ...(revision.cover_asset_hash ? [revision.cover_asset_hash] : [])];
    const assets = await listAssets(db, referenced);

    const built = await buildExportPackage({
      revision,
      exportRow,
      validation: validation.report,
      assets,
      dataDir: config.dataDir,
    });

    await sql.begin((tx) => finishExport(tx, exportId, { status: "succeeded", manifest_hash: built.manifestHash, path: built.zipPath }));
    return { exportId, status: "succeeded", zipPath: built.zipPath, manifestHash: built.manifestHash, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql.begin((tx) => finishExport(tx, exportId, { status: "failed" }));
    return { exportId, status: "failed", zipPath: null, manifestHash: null, error: message };
  }
}
