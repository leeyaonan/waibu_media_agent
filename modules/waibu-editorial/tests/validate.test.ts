// 微信结构验证：合规稿通过、固定宽度违规被拦、校验器故障不当成通过。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOfficialValidation, VALIDATOR_VERSION, SPEC_COMMIT, type ValidationReport } from "../backend/validate/index.ts";
import { assertRevisionValidated, saveValidation } from "../backend/validate/store.ts";
import { sql } from "@aihot/backend/db";
import { randomUUID } from "node:crypto";
import { createDraft, createRun, createTopic } from "../backend/store/index.ts";
import { applyAuthorEdit } from "../backend/revisions/index.ts";

after(async () => {});

// 校验器需要真实 Chromium：没有配置就跳过这些用例，而不是让它们“碰巧通过”。
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROMIUM_PATH;

const compliant = `<section style="text-align:left;margin:0;padding:24px 20px 36px;box-sizing:border-box;"><p style="text-align:left;font-size:16px;line-height:1.95;color:#343e37;margin:0 0 21px;"><span style="text-align:left;">正常的段落文字。</span></p></section>`;

// 官方 width 规则拦的是“会随屏幕变化出问题”的排版：
// 单纯写 width:900px 它判合规，margin-left 过大或表格固定列宽才会触发。
const broken = `<section style="text-align:left;"><p style="margin-left:600px;text-align:left;font-size:16px;line-height:1.95;">这段左边距过大，窄屏会溢出。</p></section>`;

test("合规稿通过官方校验器", { timeout: 120_000, skip: CHROME ? false : "未配置 PUPPETEER_EXECUTABLE_PATH" }, async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "waibu-validate-"));
  const report = await runOfficialValidation(compliant, { workDir });
  assert.equal(report.status, "passed", JSON.stringify(report.violations));
  assert.equal(report.version, VALIDATOR_VERSION);
  assert.equal(report.spec_commit, SPEC_COMMIT);
  assert.equal(report.official.status, "passed");
  assert.equal(report.wechat_backend.status, "unverified", "后台状态必须单独记为未验证");
});

test("违规结构被检出，修复后重跑通过", { timeout: 180_000, skip: CHROME ? false : "未配置 PUPPETEER_EXECUTABLE_PATH" }, async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "waibu-validate-"));
  const failing = await runOfficialValidation(broken, { workDir });
  assert.equal(failing.status, "failed");
  assert.ok(failing.violations.length > 0, "必须给出违规明细");
  assert.ok(failing.violations.some((item) => /width/iu.test(item.rule)), JSON.stringify(failing.violations));

  // 修复：去掉过大的左边距，重跑同一套规则
  const fixed = broken.replace('margin-left:600px;', '');
  const passing = await runOfficialValidation(fixed, { workDir });
  assert.equal(passing.status, "passed", JSON.stringify(passing.violations));
  assert.equal(passing.violations.length, 0);
});

test("校验器起不来时记为 validator_error，不是通过", { timeout: 120_000, skip: CHROME ? false : "未配置 PUPPETEER_EXECUTABLE_PATH" }, async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "waibu-validate-"));
  const previous = process.env.PUPPETEER_EXECUTABLE_PATH;
  process.env.PUPPETEER_EXECUTABLE_PATH = "/nonexistent/chrome";
  try {
    const report = await runOfficialValidation(compliant, { workDir, timeoutMs: 30_000 });
    assert.equal(report.status, "validator_error");
    assert.equal(report.official.status, "error");
  } finally {
    if (previous === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previous;
  }
});


async function seedRevision() {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `vl-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });
  const draft = await createDraft(sql, topic.id);
  const saved = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draft.id,
      expected_lock_version: draft.lock_version,
      base_revision_id: null,
      content: { title: "标题", summary: "", body: "正文。", cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "p1",
    }),
  );
  return saved.revision.id;
}

function reportOf(status: ValidationReport["status"]): ValidationReport {
  return {
    validator: "verify-article-structure",
    version: VALIDATOR_VERSION,
    spec_commit: SPEC_COMMIT,
    status,
    raw: "{}",
    violations: status === "passed" ? [] : [{ rule: "width", detail: "排版会随屏幕变化出问题" }],
    duration_ms: 1,
    checked_at: new Date().toISOString(),
    local: { status: "passed", note: "" },
    official: { status: status === "passed" ? "passed" : "failed", note: "" },
    wechat_backend: { status: "unverified", note: "" },
    exit_code: status === "passed" ? 0 : 1,
  };
}

test("没有校验记录不能导出", async () => {
  const revisionId = await seedRevision();
  await assert.rejects(() => assertRevisionValidated(sql, revisionId), /还没有排版校验记录/u);
});

test("校验失败不能导出，通过后才放行", async () => {
  const revisionId = await seedRevision();
  await saveValidation(sql, { revision_id: revisionId, report: reportOf("failed") });
  await assert.rejects(() => assertRevisionValidated(sql, revisionId), /排版校验未通过/u);

  await saveValidation(sql, { revision_id: revisionId, report: reportOf("passed") });
  const latest = await assertRevisionValidated(sql, revisionId);
  assert.equal(latest.report.status, "passed");
});

test("校验器故障同样阻止导出", async () => {
  const revisionId = await seedRevision();
  await saveValidation(sql, { revision_id: revisionId, report: reportOf("validator_error") });
  await assert.rejects(() => assertRevisionValidated(sql, revisionId), /校验器执行失败/u);
});
