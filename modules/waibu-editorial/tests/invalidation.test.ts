// 来源撤回：未发布稿转 on_hold 且旧批准失效，已发布稿只留勘误提醒，发布事实不被抹掉。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@aihot/backend/db";
import { invalidateSource, validateEvidenceForExport } from "../backend/invalidation/index.ts";
import { approveDraft } from "../backend/store/review.ts";
import { applyAuthorEdit } from "../backend/revisions/index.ts";
import { createClaim, createDraft, createEvidence, createRun, createTopic, getDraft, listApprovals } from "../backend/store/index.ts";

after(closeDb);

interface Seeded {
  draftId: string;
  revisionId: string;
  revisionHash: string;
  lockVersion: number;
  sourceId: string;
}

/** 造一篇"证据有效、事实已核实、处于 in_review"的稿子。 */
async function seed(state: "in_review" = "in_review"): Promise<Seeded> {
  const tag = randomUUID().replace(/-/gu, "");
  const sourceId = `src-inv-${tag.slice(0, 8)}`;
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `iv-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-${tag}` });
  const evidence = await createEvidence(sql, {
    source_id: sourceId,
    article_id: `art-${tag.slice(0, 8)}`,
    url: "https://example.com/a",
    published_at: "2026-11-05T07:00:00.000Z",
    excerpt: "订阅价格为每月 20 美元。",
    hash: `sha256:${"a".repeat(64)}`,
    rights: "quotation",
  });
  await createClaim(sql, { topic_id: topic.id, text: "订阅价格为每月 20 美元", kind: "factual", evidence_ids: [evidence.id], status: "supported" });
  const draft = await createDraft(sql, topic.id);
  const edited = await sql.begin((tx) =>
    applyAuthorEdit(tx, {
      draft_id: draft.id,
      expected_lock_version: draft.lock_version,
      base_revision_id: null,
      content: { title: "标题", summary: "", body: "正文", cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "p1",
    }),
  );
  await sql`update waibu_drafts set state = ${state} where id = ${draft.id}`;
  const fresh = (await getDraft(sql, draft.id))!;
  return { draftId: draft.id, revisionId: edited.revision.id, revisionHash: edited.revision.content_hash, lockVersion: fresh.lock_version, sourceId };
}

async function approve(seeded: Seeded) {
  return sql.begin((tx) =>
    approveDraft(
      tx,
      { draft_id: seeded.draftId, revision_id: seeded.revisionId, expected_content_hash: seeded.revisionHash, actor: "author", expected_lock_version: seeded.lockVersion },
      { blockingIssues: 0, invalidEvidence: 0 },
    ),
  );
}

test("批准后来源撤回：批准失效、稿件转 on_hold、结论降级", async () => {
  const seeded = await seed();
  await approve(seeded);
  assert.equal((await getDraft(sql, seeded.draftId))!.state, "approved");

  const result = await sql.begin((tx) => invalidateSource(tx, seeded.sourceId));

  assert.equal(result.evidence_withdrawn, 1);
  assert.equal(result.claims_downgraded, 1);
  assert.deepEqual(result.drafts_held, [seeded.draftId]);
  assert.equal(result.approvals_revoked, 1);

  const draft = (await getDraft(sql, seeded.draftId))!;
  assert.equal(draft.state, "on_hold");
  assert.equal(draft.approved_revision_id, null, "旧批准指针必须清空");
  assert.ok((await listApprovals(sql, seeded.draftId)).every((item) => item.revoked_at !== null));

  const [claim] = await sql`select status from waibu_claims where topic_id = (select topic_id from waibu_drafts where id = ${seeded.draftId})`;
  assert.equal(claim!.status, "unsupported");
});

test("撤回后导出前检查不通过", async () => {
  const seeded = await seed();
  await approve(seeded);
  await sql.begin((tx) => invalidateSource(tx, seeded.sourceId));
  const check = await sql.begin((tx) => validateEvidenceForExport(tx, seeded.draftId));
  assert.equal(check.ok, false);
  assert.equal(check.invalid, 1);
});

test("已发布稿不被改写，只产出勘误提醒", async () => {
  const seeded = await seed("in_review");
  await approve(seeded);
  await sql`update waibu_drafts set state = 'published' where id = ${seeded.draftId}`;

  const result = await sql.begin((tx) => invalidateSource(tx, seeded.sourceId));
  assert.equal(result.drafts_held.length, 0, "已发布稿不能转 on_hold");
  assert.equal(result.errata.length, 1);
  assert.equal(result.errata[0]!.draft_id, seeded.draftId);

  const draft = (await getDraft(sql, seeded.draftId))!;
  assert.equal(draft.state, "published", "发布事实保留");
});

test("不相关的稿件不受影响", async () => {
  const mine = await seed();
  const other = await seed();
  await approve(other);
  const result = await sql.begin((tx) => invalidateSource(tx, mine.sourceId));
  assert.deepEqual(result.drafts_held, [mine.draftId]);
  assert.equal((await getDraft(sql, other.draftId))!.state, "approved", "别人的批准不能被牵连");
});

test("重复撤回是幂等的", async () => {
  const seeded = await seed();
  await approve(seeded);
  await sql.begin((tx) => invalidateSource(tx, seeded.sourceId));
  const again = await sql.begin((tx) => invalidateSource(tx, seeded.sourceId));
  assert.equal(again.evidence_withdrawn, 0, "已经撤回的不再重复计数");
  assert.equal(again.approvals_revoked, 0);
});
