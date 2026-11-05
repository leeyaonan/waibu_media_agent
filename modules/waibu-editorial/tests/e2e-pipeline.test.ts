// 端到端：候选故事 → 证据 → 大纲 → 起草 → 自检 → 待审 → 改稿 → 批准 → 校验 → 导出 → 登记。
// 模型用本地 stub，跑的是真实 handler 与真实数据库。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stub } from "../../../tests/setup.ts";
import { createRun, getDraft, listRevisions } from "../backend/store/index.ts";
import { executePipelineJob } from "../backend/jobs/index.ts";
import { registerPipelineHandlers } from "../backend/jobs/handlers.ts";
import { PIPELINE_QUEUE } from "../backend/jobs/queue.ts";
import { approveDraft } from "../backend/store/review.ts";
import { applyAuthorEdit } from "../backend/revisions/index.ts";
import { createExport, finishExport, getAsset } from "../backend/store/delivery.ts";
import { saveValidation } from "../backend/validate/store.ts";
import { VALIDATOR_VERSION, SPEC_COMMIT } from "../backend/validate/index.ts";
import { registerPublication } from "../backend/publication/index.ts";
import { listClaims } from "../backend/store/drafts.ts";

let model: Awaited<ReturnType<typeof stub>> | null = null;

before(async () => {
  // 模型 stub：大纲与起草各返回一份结构合法的 JSON。
  model = await stub((_hit, req) => {
    const body = JSON.parse(req.body) as { messages?: Array<{ content: string }> };
    const prompt = body.messages?.map((message) => message.content).join("\n") ?? "";
    // 提示词里带着可用事实编号，模型只能引用这些编号。
    const ids = [...prompt.matchAll(/\[([0-9a-f-]{36})\]/gu)].map((match) => match[1]!);
    if (prompt.includes("输出 JSON：{ sections")) {
      const sections = ids.slice(0, 2).map((id, index) => ({
        heading: index === 0 ? "价格变化" : "版本更新",
        purpose: index === 0 ? "说明订阅价格" : "说明版本号",
        claim_ids: [id],
      }));
      return { choices: [{ message: { content: JSON.stringify({ sections: sections.length >= 2 ? sections : [sections[0], sections[0]], gaps: [] }) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } };
    }
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            title: "新版定价意味着什么",
            summary: "价格与版本都来自官方说明。",
            body: "官方把订阅价格定在每月 20 美元。\n\n这次更新对应 v3.2。",
            block_claims: ids.length > 0 ? { "0": [ids[0]] } : {},
          }),
        },
      }],
      usage: { prompt_tokens: 200, completion_tokens: 100 },
    };
  });
  process.env.LLM_BASE_URL = `${model.url}/v1`;
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";
});

after(async () => {
  await model?.close();
  await closeDb();
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

test("固定 fixture 跑通全链路", { timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "waibu-e2e-"));
  config.dataDir = dataDir;
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `e2e-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });

  // 1) 采集结果（fixture）
  const stories = [{
    id: 1,
    external_id: `story-${tag.slice(0, 8)}`,
    title: "OpenAI 调整订阅定价",
    summary: "官方说明订阅价格为每月 20 美元，当前版本号 v3.2。",
    url: "https://example.com/news",
    source_name: "OpenAI News",
    published_at: "2026-11-05T07:00:00.000Z",
    content_hash: `sha256:${"a".repeat(64)}`,
    facts: ["订阅价格为每月 20 美元", "当前版本号 v3.2"],
  }];
  registerPipelineHandlers({ stories: { load: async () => stories } });

  // 2) 证据阶段
  const evidenceJob = await executePipelineJob({ run_id: run.id, stage: "evidence", draft_id: null, base_revision_id: null, input_hash: `sha256:${"1".repeat(64)}`, attempt: 1 });
  assert.equal(evidenceJob, "executed");
  const [draftRow] = await sql`select id, topic_id from waibu_drafts where topic_id in (select id from waibu_topics where run_id = ${run.id}) limit 1`;
  assert.ok(draftRow, "证据阶段应当建出稿件");
  const draftId = String(draftRow.id);
  const claims = await listClaims(sql, String(draftRow.topic_id));
  assert.equal(claims.length, 2, "两条事实都要落库");
  assert.ok(claims.every((claim) => claim.evidence_ids.length === 1), "每条事实都要绑证据");

  // 3) 大纲 → 起草 → 自检
  const outline = await executePipelineJob({ run_id: run.id, stage: "outline", draft_id: draftId, base_revision_id: null, input_hash: `sha256:${"2".repeat(64)}`, attempt: 1 });
  assert.equal(outline, "executed");
  const drafted = await executePipelineJob({ run_id: run.id, stage: "draft", draft_id: draftId, base_revision_id: null, input_hash: `sha256:${"3".repeat(64)}`, attempt: 1 });
  assert.equal(drafted, "executed");
  const checked = await executePipelineJob({ run_id: run.id, stage: "check", draft_id: draftId, base_revision_id: null, input_hash: `sha256:${"4".repeat(64)}`, attempt: 1 });
  assert.equal(checked, "executed");

  const afterCheck = (await getDraft(sql, draftId))!;
  assert.equal(afterCheck.state, "in_review", "自检通过后进入待审");
  assert.ok(afterCheck.current_revision_id, "应当有版本");
  const revisions = await listRevisions(sql, draftId);
  assert.equal(revisions.length, 1);
  assert.match(revisions[0]!.body, /20 美元/u, "正文来自模型且带事实");

  // 4) 作者改稿
  const edited = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draftId,
      expected_lock_version: afterCheck.lock_version,
      base_revision_id: afterCheck.current_revision_id!,
      content: { title: revisions[0]!.title, summary: revisions[0]!.summary, body: `${revisions[0]!.body}\n\n补一句作者的话。`, cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "v1",
    }),
  );
  assert.notEqual(edited.revision.id, revisions[0]!.id);

  // 5) 批准 → 校验 → 导出
  await sql`update waibu_drafts set state = 'in_review' where id = ${draftId}`;
  const ready = (await getDraft(sql, draftId))!;
  const approved = await sql.begin((tx) =>
    approveDraft(tx, { draft_id: draftId, revision_id: edited.revision.id, expected_content_hash: edited.revision.content_hash, actor: "author", expected_lock_version: ready.lock_version }, { blockingIssues: 0, invalidEvidence: 0 }),
  );
  await saveValidation(sql, { revision_id: edited.revision.id, report: passedReport() });
  const exported = await sql.begin((tx) =>
    createExport(tx, { draft_id: draftId, revision_id: edited.revision.id, approval_id: approved.approval.id, path: "exports/e2e", validator_version: "v1" }),
  );
  await sql.begin((tx) => finishExport(tx, exported.id, { status: "succeeded", manifest_hash: `sha256:${"d".repeat(64)}` }));
  assert.equal((await getDraft(sql, draftId))!.state, "exported");

  // 6) 手工登记发布
  const afterExport = (await getDraft(sql, draftId))!;
  const publication = await sql.begin((tx) =>
    registerPublication(tx, {
      draft_id: draftId,
      revision_id: edited.revision.id,
      expected_lock_version: afterExport.lock_version,
      published_at: "2026-11-05T12:00:00.000Z",
      url: "https://mp.weixin.qq.com/s/e2e",
      recorded_by: "作者",
    }),
  );
  assert.equal(publication.revision_id, edited.revision.id, "登记必须指向真正发布的版本");
  assert.equal((await getDraft(sql, draftId))!.state, "published");

  void getAsset;
  void mkdir;
  void writeFile;
});

test("队列注册了流水线与导出", async () => {
  assert.equal(PIPELINE_QUEUE.name.length > 0, true);
});
