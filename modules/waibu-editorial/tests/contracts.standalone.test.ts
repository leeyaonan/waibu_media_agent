// 契约自检：状态机、内容 hash、schema 与错误码。纯计算，不连数据库，用 standalone 套件跑。
import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTICLE_STATES,
  canApprove,
  canEditContent,
  canTransition,
  holdsApproval,
  stateAfterContentChange,
  taskRetryable,
} from "../contracts/states.ts";
import { contentHash, manifestHash, normalizeEditorialText, canonicalJson } from "../contracts/content.ts";
import { draftRowSchema, hashOfRevisionRow, revisionRowSchema } from "../contracts/entities.ts";
import { approveRequestSchema, createRunRequestSchema, saveRevisionRequestSchema } from "../contracts/api.ts";
import { stageInputHash } from "../contracts/pipeline.ts";
import { EditorialError, ERROR_STATUS } from "../contracts/errors.ts";

const base = {
  title: "标题",
  summary: "摘要",
  body: "正文第一段\n正文第二段",
  cover_asset_hash: null,
  captions: { b2: "第二张图注", b1: "第一张图注" },
  asset_hashes: ["sha256:" + "b".repeat(64), "sha256:" + "a".repeat(64)],
};

test("批准只能由人发起，服务端不能自批", () => {
  assert.equal(canTransition("in_review", "approved", "human"), true);
  assert.equal(canTransition("in_review", "approved", "system"), false);
  assert.equal(canTransition("checking", "approved", "system"), false);
  assert.equal(canApprove("in_review"), true);
  assert.equal(canApprove("checking"), false);
});

test("published 是终态，已发布稿不能再改内容", () => {
  assert.equal(canEditContent("published"), false);
  assert.equal(canEditContent("exported"), true);
  for (const target of ARTICLE_STATES) {
    assert.equal(canTransition("published", target, "human"), false, `published 不应能迁移到 ${target}`);
    assert.equal(canTransition("published", target, "system"), false, `published 不应能迁移到 ${target}`);
  }
});

test("内容变化使批准失效：approved/exported 回到 checking", () => {
  assert.equal(stateAfterContentChange("approved"), "checking");
  assert.equal(stateAfterContentChange("exported"), "checking");
  assert.equal(stateAfterContentChange("in_review"), "checking");
  assert.equal(stateAfterContentChange("drafting"), "drafting");
  assert.equal(stateAfterContentChange("published"), "published", "已发布稿的改动走新流程，本记录不动");
  assert.equal(holdsApproval("approved"), true);
  assert.equal(holdsApproval("checking"), false);
});

test("任务失败可重试，成功和取消不重试", () => {
  assert.equal(taskRetryable("failed"), true);
  assert.equal(taskRetryable("paused_budget"), true);
  assert.equal(taskRetryable("succeeded"), false);
  assert.equal(taskRetryable("cancelled"), false);
});

test("内容 hash 与字段顺序、图注顺序、素材顺序、换行形式无关", () => {
  const h1 = contentHash(base);
  const h2 = contentHash({
    ...base,
    captions: { b1: "第一张图注", b2: "第二张图注" },
    asset_hashes: ["sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64)],
    body: "正文第一段\r\n正文第二段",
  });
  assert.equal(h1, h2);
  assert.match(h1, /^sha256:[0-9a-f]{64}$/u);
});

test("标题、正文、封面、图注、素材任一变化都换 hash", () => {
  const h = contentHash(base);
  assert.notEqual(contentHash({ ...base, title: "另一个标题" }), h);
  assert.notEqual(contentHash({ ...base, body: "正文第一段" }), h);
  assert.notEqual(contentHash({ ...base, summary: "别的摘要" }), h);
  assert.notEqual(contentHash({ ...base, cover_asset_hash: "sha256:" + "c".repeat(64) }), h);
  assert.notEqual(contentHash({ ...base, captions: { ...base.captions, b1: "改了图注" } }), h);
  assert.notEqual(contentHash({ ...base, asset_hashes: [...base.asset_hashes, "sha256:" + "d".repeat(64)] }), h);
});

test("规范化只改换行与 Unicode 形式，不改文字内容", () => {
  assert.equal(normalizeEditorialText("a\r\nb\rc"), "a\nb\nc");
  assert.equal(normalizeEditorialText("e\u0301"), "\u00e9");
});

test("canonicalJson 对键排序，数组保持顺序", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test("发布包 manifest hash 与文件顺序无关、与内容有关", () => {
  const files = [
    { path: "正文.md", sha256: "1".repeat(64) },
    { path: "排版/正文.html", sha256: "2".repeat(64) },
  ];
  assert.equal(manifestHash(files), manifestHash([...files].reverse()));
  assert.notEqual(manifestHash(files), manifestHash([files[0]!, { ...files[1]!, sha256: "3".repeat(64) }]));
});

test("revision 行的 hash 必须与内容一致（批准绑定的自检）", () => {
  const row = {
    id: "0b8f0a3e-1d2c-4c5b-9a6f-2f4b7c8d9e01",
    draft_id: "0b8f0a3e-1d2c-4c5b-9a6f-2f4b7c8d9e02",
    parent_id: null,
    title: base.title,
    summary: base.summary,
    body: base.body,
    cover_asset_hash: null,
    captions: base.captions,
    asset_hashes: [...base.asset_hashes].reverse(),
    content_hash: contentHash(base),
    content_hash_version: 1,
    policy_version: "2026-11-05",
    created_by: "model" as const,
    created_at: "2026-11-05T08:30:00+08:00",
  };
  assert.equal(hashOfRevisionRow(row), row.content_hash);
  assert.doesNotThrow(() => revisionRowSchema.parse(row));
  assert.throws(() => revisionRowSchema.parse({ ...row, content_hash: "sha256:短" }));
});

test("API 契约：批准必须带内容和版本，恢复必须指定稿子", () => {
  const approval = {
    expected_revision_id: "0b8f0a3e-1d2c-4c5b-9a6f-2f4b7c8d9e03",
    expected_content_hash: "sha256:" + "e".repeat(64),
    expected_lock_version: 3,
  };
  assert.doesNotThrow(() => approveRequestSchema.parse(approval));
  const { expected_content_hash: _drop, ...withoutHash } = approval;
  assert.throws(() => approveRequestSchema.parse(withoutHash), "缺 content_hash 不能批准");
  assert.throws(() => createRunRequestSchema.parse({ kind: "recover" }), "恢复必须指定 draft_id");
  assert.doesNotThrow(() => createRunRequestSchema.parse({ kind: "rerun" }));
  assert.throws(
    () => saveRevisionRequestSchema.parse({ title: "t", summary: "", body: "b", expected_revision_id: "x", expected_lock_version: 1 }),
    "expected_revision_id 必须是 UUID",
  );
});

test("阶段键对证据顺序不敏感，对策略版本敏感", () => {
  const parts = {
    stage: "draft" as const,
    policy_version: "p1",
    prompt_version: "v1",
    model_config_hash: "sha256:" + "f".repeat(64),
    evidence_hashes: ["sha256:" + "1".repeat(64), "sha256:" + "2".repeat(64)],
    base_revision_id: null,
    feedback_ids: [] as string[],
  };
  assert.equal(stageInputHash(parts), stageInputHash({ ...parts, evidence_hashes: [...parts.evidence_hashes].reverse() }));
  assert.notEqual(stageInputHash(parts), stageInputHash({ ...parts, policy_version: "p2" }));
  assert.notEqual(stageInputHash(parts), stageInputHash({ ...parts, prompt_version: "v2" }));
});

test("错误码带固定的 HTTP 状态，页面按 code 判断", () => {
  const conflict = new EditorialError("conflict_version", "版本不一致");
  assert.equal(conflict.status, 409);
  assert.equal(ERROR_STATUS.check_blocked, 422);
  assert.equal(ERROR_STATUS.budget_paused, 429);
  assert.equal(ERROR_STATUS.unauthorized, 401);
});

test("未知状态与枚举外的值一律拒绝", () => {
  const draft = {
    id: "0b8f0a3e-1d2c-4c5b-9a6f-2f4b7c8d9e04",
    topic_id: "0b8f0a3e-1d2c-4c5b-9a6f-2f4b7c8d9e05",
    state: "publishedd",
    current_revision_id: null,
    approved_revision_id: null,
    lock_version: 1,
    reject_reason: null,
    created_at: "2026-11-05T08:30:00+08:00",
    updated_at: "2026-11-05T08:30:00+08:00",
  };
  // 拼错的状态不能绕过状态机
  assert.throws(() => draftRowSchema.parse(draft));
  assert.doesNotThrow(() => draftRowSchema.parse({ ...draft, state: "in_review" }));
  assert.throws(() => createRunRequestSchema.parse({ kind: "restart" }), "未知的运行命令类型");
});

test("超长正文与超长标题被拒绝", () => {
  const ok = {
    title: "标题",
    summary: "",
    body: "正文",
    expected_revision_id: "0b8f0a3e-1d2c-4c5b-9a6f-2f4b7c8d9e06",
    expected_lock_version: 1,
  };
  assert.doesNotThrow(() => saveRevisionRequestSchema.parse(ok));
  assert.throws(() => saveRevisionRequestSchema.parse({ ...ok, body: "字".repeat(200_001) }), "正文超长必须拦下");
  assert.throws(() => saveRevisionRequestSchema.parse({ ...ok, title: "标".repeat(201) }), "标题超长必须拦下");
});
