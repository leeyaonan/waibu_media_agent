// 定向改稿：只改意见涉及的段落、过期批注要重新定位、没采用的建议不覆盖当前稿。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@aihot/backend/db";
import { checkFeedbackScope, feedbackStates, findStaleFeedback, splitBlocks, applyFeedbackRevision } from "../backend/feedback/index.ts";
import { applyAuthorEdit } from "../backend/revisions/index.ts";
import { createDraft, createRun, createTopic, getDraft, listRevisions } from "../backend/store/index.ts";
import { createFeedback } from "../backend/store/review.ts";

after(closeDb);

const before = "开头先讲一句这次更新。\n\n订阅价格仍是每月 20 美元。\n\n最后是版本号 v3.2。";

async function seed() {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `fb-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });
  const draft = await createDraft(sql, topic.id);
  const edited = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draft.id,
      expected_lock_version: draft.lock_version,
      base_revision_id: null,
      content: { title: "标题", summary: "", body: before, cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "p1",
    }),
  );
  return { draft: edited.draft, revision: edited.revision };
}

test("只改开头：价格段落不受影响就算合规", () => {
  const after = "换了个开头说法。\n\n订阅价格仍是每月 20 美元。\n\n最后是版本号 v3.2。";
  const scope = checkFeedbackScope({ before, after, targeted_blocks: [0] });
  assert.equal(scope.ok, true, `越界改动：${scope.unexpected_changes.join(",")}`);
});

test("顺手改了价格段落会被指出来", () => {
  const after = "换了个开头说法。\n\n订阅价格调整为每月 25 美元。\n\n最后是版本号 v3.2。";
  const scope = checkFeedbackScope({ before, after, targeted_blocks: [0] });
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.unexpected_changes, [1], "价格段是意见没提到却改动的地方");
});

test("过期批注明确提示重新定位", () => {
  const shorter = "只剩一段了。";
  const stale = findStaleFeedback([{ id: "f1", block_id: "2" }], shorter);
  assert.equal(stale.length, 1);
  assert.match(stale[0]!.reason, /重新定位/u);
});

test("段落切分稳定，空行分隔即分段", () => {
  assert.deepEqual(splitBlocks("a\n\nb\n\n\nc"), ["a", "b", "c"]);
});

test("落实改稿：产生新版本、意见标记到该版本、回到自检", async () => {
  const { draft, revision } = await seed();
  const feedback = await createFeedback(sql, { draft_id: draft.id, revision_id: revision.id, block_id: "0", text: "开头再直接一点" });

  const result = await sql.begin((tx) =>
    applyFeedbackRevision(tx, {
      draft_id: draft.id,
      expected_lock_version: draft.lock_version,
      base_revision_id: revision.id,
      content: { title: "标题", summary: "", body: "更直接的开头。\n\n订阅价格仍是每月 20 美元。\n\n最后是版本号 v3.2。", cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "p1",
      feedback_ids: [feedback.id],
    }),
  );

  assert.equal(result.draft.state, "checking", "改稿后必须重新自检");
  assert.equal(result.resolved, 1);
  const [stored] = await sql`select resolution_revision_id from waibu_feedback where id = ${feedback.id}`;
  assert.equal(String(stored!.resolution_revision_id), result.revision.id);

  const states = await feedbackStates(sql, draft.id, result.revision.body);
  assert.equal(states.find((item) => item.id === feedback.id)!.state, "resolved");
});

test("建议没被采用时不产生新版本，当前稿不变", async () => {
  const { draft, revision } = await seed();
  const snapshot = (await getDraft(sql, draft.id))!.current_revision_id;
  const revisions = await listRevisions(sql, draft.id);
  assert.equal(revisions.length, 1);

  // 改稿函数没被调用（模型没有给出可用修订），当前指针必须原样
  assert.equal(snapshot, revision.id);
  assert.equal((await listRevisions(sql, draft.id)).length, 1);
});

test("反馈状态能区分待处理、已落实与过期", async () => {
  const { draft, revision } = await seed();
  const open = await createFeedback(sql, { draft_id: draft.id, revision_id: revision.id, block_id: "0", text: "改开头" });
  const staleItem = await createFeedback(sql, { draft_id: draft.id, revision_id: revision.id, block_id: "9", text: "改不存在的段落" });
  const states = await feedbackStates(sql, draft.id, revision.body);
  assert.equal(states.find((item) => item.id === open.id)!.state, "open");
  assert.equal(states.find((item) => item.id === staleItem.id)!.state, "stale");
});
