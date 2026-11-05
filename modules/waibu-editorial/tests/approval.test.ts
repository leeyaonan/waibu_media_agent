// 批准：只有人工会话能批；有未解缺口不能批；批准后改摘要，旧批准立刻作废且不能用于导出；
// 驳回是作者动作，与任务失败是两回事。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { passwordLogin, SESSION_COOKIE } from "@aihot/backend/admin/auth";
import { registerEditorialRoutes } from "../backend/http-auth/routes.ts";
import { API_PREFIX } from "../contracts/api.ts";
import { applyAuthorEdit } from "../backend/revisions/index.ts";
import { createClaim, createDraft, createEvidence, createRun, createTopic, getDraft, listApprovals } from "../backend/store/index.ts";
import { approvalGuards } from "../backend/review/guards.ts";

after(closeDb);

const PASSWORD = `approve-test-password-${Date.now()}`;
let app: ReturnType<typeof Fastify>;
let token = "";
let csrf = "";

before(async () => {
  config.adminPassword = PASSWORD;
  app = Fastify({ logger: false });
  registerEditorialRoutes(app);
  await app.ready();
  token = (await passwordLogin(PASSWORD, "/admin", "approve-test")).token;
  const [session] = await sql`select csrf_token from admin_sessions order by created_at desc limit 1`;
  csrf = String(session!.csrf_token);
});

const headers = () => ({ cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf });
const post = (url: string, payload: unknown, withHeaders = true) => app.inject({ method: "POST", url, headers: withHeaders ? headers() : {}, payload });

/** 造一篇待审稿：事实全 supported，可以批准。 */
async function seedReviewable() {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `ap-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });
  const evidence = await createEvidence(sql, {
    source_id: "src-approve",
    article_id: `art-${tag.slice(0, 8)}`,
    url: "https://example.com/a",
    published_at: "2026-11-05T07:00:00.000Z",
    excerpt: "订阅价格为每月 20 美元。",
    hash: `sha256:${"a".repeat(64)}`,
    rights: "quotation",
  });
  await createClaim(sql, { topic_id: topic.id, text: "订阅价格为每月 20 美元", kind: "factual", evidence_ids: [evidence.id], status: "supported" });
  const draft = await createDraft(sql, topic.id);
  const { revision } = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draft.id,
      expected_lock_version: draft.lock_version,
      base_revision_id: null,
      content: { title: "标题", summary: "摘要", body: "正文", cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "p1",
    }),
  );
  const fresh = await sql.begin(async (tx) => {
    await tx`update waibu_drafts set state = 'in_review' where id = ${draft.id}`;
    return (await tx`select * from waibu_drafts where id = ${draft.id}`)[0]!;
  });
  return { draftId: draft.id, revision, lockVersion: Number(fresh.lock_version) };
}

/** 导出前必须有通过的排版校验；测试里直接补一条，规则本身在 validate.test.ts 覆盖。 */
async function seedPassedValidation(revisionId: string): Promise<void> {
  const { saveValidation } = await import("../backend/validate/store.ts");
  const { VALIDATOR_VERSION, SPEC_COMMIT } = await import("../backend/validate/index.ts");
  await saveValidation(sql, {
    revision_id: revisionId,
    report: {
      validator: "verify-article-structure",
      version: VALIDATOR_VERSION,
      spec_commit: SPEC_COMMIT,
      status: "passed",
      raw: "{}",
      violations: [],
      duration_ms: 1,
      checked_at: new Date().toISOString(),
      local: { status: "passed", note: "" },
      official: { status: "passed", note: "" },
      wechat_backend: { status: "unverified", note: "" },
      exit_code: 0,
    },
  });
}

test("没有会话不能批准", async () => {
  const { draftId, revision, lockVersion } = await seedReviewable();
  const response = await post(`${API_PREFIX}/drafts/${draftId}/approvals`, { expected_revision_id: revision.id, expected_content_hash: revision.content_hash, expected_lock_version: lockVersion }, false);
  assert.equal(response.statusCode, 401);
  assert.equal((await getDraft(sql, draftId))!.state, "in_review");
});

test("有未解缺口时批准被拒绝（422）", async () => {
  const { draftId, revision, lockVersion } = await seedReviewable();
  const [draft] = await sql`select topic_id from waibu_drafts where id = ${draftId}`;
  await createClaim(sql, { topic_id: String(draft!.topic_id), text: "还没核实的一条", kind: "factual", evidence_ids: [], status: "unchecked" });

  const guards = await approvalGuards(sql, draftId);
  assert.equal(guards.blockingIssues, 1);

  const response = await post(`${API_PREFIX}/drafts/${draftId}/approvals`, { expected_revision_id: revision.id, expected_content_hash: revision.content_hash, expected_lock_version: lockVersion });
  assert.equal(response.statusCode, 422);
  assert.equal(JSON.parse(response.body).code, "check_blocked");
  assert.equal((await getDraft(sql, draftId))!.state, "in_review");
});

test("人工批准成功，记录批准人与内容 hash", async () => {
  const { draftId, revision, lockVersion } = await seedReviewable();
  const response = await post(`${API_PREFIX}/drafts/${draftId}/approvals`, { expected_revision_id: revision.id, expected_content_hash: revision.content_hash, expected_lock_version: lockVersion });
  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.approval.content_hash, revision.content_hash);
  assert.ok(body.approval.actor.length > 0, "要记下是谁批的");
  assert.equal(body.draft.state, "approved");
});

test("批准后改摘要：旧批准作废，旧批准不能用于导出", async () => {
  const { draftId, revision, lockVersion } = await seedReviewable();
  const approved = await post(`${API_PREFIX}/drafts/${draftId}/approvals`, { expected_revision_id: revision.id, expected_content_hash: revision.content_hash, expected_lock_version: lockVersion });
  const approval = JSON.parse(approved.body).approval;

  const current = (await getDraft(sql, draftId))!;
  const edited = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draftId,
      expected_lock_version: current.lock_version,
      base_revision_id: revision.id,
      content: { title: "标题", summary: "换了摘要", body: "正文", cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "p1",
    }),
  );
  assert.equal(edited.draft.state, "checking");
  assert.equal(edited.draft.approved_revision_id, null);
  const approvals = await listApprovals(sql, draftId);
  assert.ok(approvals.every((item) => item.revoked_at !== null), "所有批准都要被撤销");

  const exported = await post(`${API_PREFIX}/drafts/${draftId}/exports`, { expected_revision_id: revision.id, expected_approval_id: approval.id });
  assert.equal(exported.statusCode, 409);
  assert.equal(JSON.parse(exported.body).code, "approval_required", "旧批准不能继续导出");
});

test("驳回是作者动作：记原因，任务记录不受影响", async () => {
  const { draftId, lockVersion } = await seedReviewable();
  const response = await post(`${API_PREFIX}/drafts/${draftId}/reject`, { reason: "角度不对，换一个", expected_revision_id: (await getDraft(sql, draftId))!.current_revision_id, expected_lock_version: lockVersion });
  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.draft.state, "rejected");
  assert.equal(body.draft.reject_reason, "角度不对，换一个");
  assert.equal((await getDraft(sql, draftId))!.state, "rejected");
});

test("版本号过期时批准被拒，不会写两条批准", async () => {
  const { draftId, revision, lockVersion } = await seedReviewable();
  await post(`${API_PREFIX}/drafts/${draftId}/approvals`, { expected_revision_id: revision.id, expected_content_hash: revision.content_hash, expected_lock_version: lockVersion });
  const again = await post(`${API_PREFIX}/drafts/${draftId}/approvals`, { expected_revision_id: revision.id, expected_content_hash: revision.content_hash, expected_lock_version: lockVersion });
  assert.equal(again.statusCode, 409, "第二次必须失败");
  assert.equal((await listApprovals(sql, draftId)).length, 1);
});
