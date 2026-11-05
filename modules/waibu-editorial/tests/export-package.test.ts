// 发布包：内容与批准版本绑定、清单 hash 可复核、缺图直接失败、重试产出同一份内容。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { getRevision } from "../backend/store/drafts.ts";
import { createDraft, createRun, createTopic, getDraft } from "../backend/store/index.ts";
import { applyAuthorEdit } from "../backend/revisions/index.ts";
import { approveDraft } from "../backend/store/review.ts";
import { createExport, getExport, upsertAsset } from "../backend/store/delivery.ts";
import { saveValidation } from "../backend/validate/store.ts";
import { VALIDATOR_VERSION, SPEC_COMMIT } from "../backend/validate/index.ts";
import { buildExportPackage } from "../backend/export/package.ts";
import { createZip, crc32 } from "../backend/export/zip.ts";
import { runExport } from "../backend/export/run.ts";

after(async () => {});

test("ZIP 结构与 CRC 正确", () => {
  const zip = createZip([
    { name: "a.txt", bytes: new TextEncoder().encode("hello") },
    { name: "b/中文.txt", bytes: new TextEncoder().encode("世界") },
  ]);
  const buffer = Buffer.from(zip);
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, "应以本地文件头开头");
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50, "应以中央目录结束标记收尾");
  assert.equal(crc32(new TextEncoder().encode("hello")).toString(16), "3610a686", "CRC32 应对得上标准值");
});

test("同名条目不重复", () => {
  const zip = createZip([
    { name: "a.txt", bytes: new TextEncoder().encode("1") },
    { name: "a.txt", bytes: new TextEncoder().encode("2") },
  ]);
  const buffer = Buffer.from(zip);
  const eocd = buffer.length - 22;
  assert.equal(buffer.readUInt16LE(eocd + 10), 1, "中央目录里只能有一条");
});

function passedReport() {
  return {
    validator: "verify-article-structure",
    version: VALIDATOR_VERSION,
    spec_commit: SPEC_COMMIT,
    status: "passed" as const,
    raw: "{}",
    violations: [],
    duration_ms: 1,
    checked_at: new Date().toISOString(),
    local: { status: "passed", note: "" },
    official: { status: "passed", note: "" },
    wechat_backend: { status: "unverified", note: "" },
    exit_code: 0,
  };
}

async function seedApprovedWithCover(dataDir: string) {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `ex-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });
  const draft = await createDraft(sql, topic.id);

  const gif = Buffer.from("R0lGODlhAgADAIAAAP///wAAACH5BAEAAAAALAAAAAACAAIAAAICDAoAOw==", "base64");
  const hash = `sha256:${createHash("sha256").update(gif).digest("hex")}`;
  const rel = path.posix.join("assets", hash.slice(7, 9), `${hash.slice(7)}.bin`);
  await mkdir(path.dirname(path.join(dataDir, rel)), { recursive: true });
  await writeFile(path.join(dataDir, rel), gif);
  const cover = await upsertAsset(sql, { hash, path: rel, mime: "image/gif", width: 2, height: 3, origin: "author_upload", rights: "public" });

  const body = `# 标题\n\n第一段正文。\n\n![示意图](${hash})\n\n*图注：示意图。*`;
  const saved = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draft.id,
      expected_lock_version: draft.lock_version,
      base_revision_id: null,
      content: { title: "导出样本", summary: "摘要", body, cover_asset_hash: cover.hash, captions: {}, asset_hashes: [hash] },
      policy_version: "p1",
    }),
  );
  await sql`update waibu_drafts set state = 'in_review' where id = ${draft.id}`;
  const inReview = (await getDraft(sql, draft.id))!;
  const approved = await sql.begin((tx) =>
    approveDraft(tx, { draft_id: draft.id, revision_id: saved.revision.id, expected_content_hash: saved.revision.content_hash, actor: "author", expected_lock_version: inReview.lock_version }, { blockingIssues: 0, invalidEvidence: 0 }),
  );
  await saveValidation(sql, { revision_id: saved.revision.id, report: passedReport() });
  return { draftId: draft.id, revisionId: saved.revision.id, approvalId: approved.approval.id, hash };
}

test("发布包包含正文、标题摘要、素材清单、校验报告与图片", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "waibu-export-"));
  // runExport 从全局配置的数据目录读素材，测试里指向临时目录。
  config.dataDir = dataDir;
  const seeded = await seedApprovedWithCover(dataDir);
  const created = await sql.begin((tx) =>
    createExport(tx, { draft_id: seeded.draftId, revision_id: seeded.revisionId, approval_id: seeded.approvalId, path: "exports/x", validator_version: "v1" }),
  );

  const result = await runExport(sql, created.id);
  assert.equal(result.status, "succeeded", result.error ?? "");
  assert.ok(result.manifestHash?.startsWith("sha256:"));

  const row = (await getExport(sql, created.id))!;
  assert.equal(row.status, "succeeded");
  assert.equal(row.manifest_hash, result.manifestHash, "库里记的 hash 与本次产出一致");
  assert.equal((await getDraft(sql, seeded.draftId))!.state, "exported", "成功后才进入 exported");

  const revision = (await getRevision(sql, seeded.revisionId))!;
  const assets = await import("../backend/store/delivery.ts").then((mod) => mod.listAssets(sql, revision.asset_hashes));
  const built = await buildExportPackage({ revision, exportRow: row, validation: passedReport(), assets, dataDir });

  for (const name of ["正文.html", "正文.md", "纯文字.txt", "标题摘要.json", "素材清单.md", "校验报告.json", "发布说明.md", "manifest.json"]) {
    assert.ok(built.files.includes(name), `包内缺少 ${name}`);
  }
  assert.ok(built.files.some((name) => name.startsWith("images/")), "包内必须有图片原文件");
  assert.ok(built.manifest.length >= 8);
  assert.ok(built.manifestHash.startsWith("sha256:"));
});

test("素材文件缺失时导出失败，不写 succeeded", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "waibu-export-"));
  config.dataDir = dataDir;
  const seeded = await seedApprovedWithCover(dataDir);
  const created = await sql.begin((tx) =>
    createExport(tx, { draft_id: seeded.draftId, revision_id: seeded.revisionId, approval_id: seeded.approvalId, path: "exports/x", validator_version: "v1" }),
  );
  // 把图片文件删掉，模拟素材丢失
  const { rm } = await import("node:fs/promises");
  await rm(path.join(dataDir, `assets/${seeded.hash.slice(7, 9)}/${seeded.hash.slice(7)}.bin`));

  const result = await runExport(sql, created.id);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /素材文件缺失/u);
  const row = (await getExport(sql, created.id))!;
  assert.equal(row.status, "failed");
  assert.equal((await getDraft(sql, seeded.draftId))!.state, "approved", "失败不改变稿件状态");
});

test("同一个导出断点重试得到相同的清单 hash", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "waibu-export-"));
  config.dataDir = dataDir;
  const seeded = await seedApprovedWithCover(dataDir);
  const created = await sql.begin((tx) =>
    createExport(tx, { draft_id: seeded.draftId, revision_id: seeded.revisionId, approval_id: seeded.approvalId, path: "exports/x", validator_version: "v1" }),
  );

  const first = await runExport(sql, created.id);
  const second = await runExport(sql, created.id);
  assert.equal(first.status, "succeeded", first.error ?? "");
  assert.equal(second.status, "succeeded", second.error ?? "");
  assert.equal(first.manifestHash, second.manifestHash, "重试必须复用相同的输出内容");
  assert.equal(first.zipPath, second.zipPath, "文件名也按内容确定");
});

