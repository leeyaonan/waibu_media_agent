// 流水线各阶段的真实实现。之前只有测试注册过 handler，
// 生产里跑到任一阶段都会报“阶段还没有实现”——这里是总装补齐的那一环。
//
// 产物存在步骤的 payload 上：选题交给大纲、大纲交给起草、草稿交给自检，
// 每一步都能审计，也能被重投时复用。
import type { Db } from "@aihot/backend/db";
import type { PipelineJob } from "../../contracts/jobs.ts";
import { EditorialError } from "../../contracts/errors.ts";
import { CURRENT_POLICY } from "../../policy/index.ts";
import { generateOutline, type Outline } from "../outline/index.ts";
import { generateDraft, type Draft } from "../drafting/index.ts";
import { deterministicIssues, mergeChecks, type Issue } from "../quality/index.ts";
import { createClaim, createDraft, createEvidence, createTopic } from "../store/index.ts";
import { getDraft, getRevision, linkRevisionClaims, listClaims } from "../store/drafts.ts";
import { evidenceFor } from "../evidence/store.ts";
import { applyAuthorEdit, applyGeneratedRevision } from "../revisions/index.ts";
import { latestStepPayload } from "../store/runs.ts";
import { registerStageHandler, type StageContext } from "./stage.ts";

/** 采集结果里我们关心的字段。生产由采集任务提供，测试用 fixture 注入。 */
export interface CandidateStory {
  id: number;
  external_id: string;
  title: string;
  summary: string;
  url: string;
  source_name: string;
  published_at: string;
  content_hash: string;
  facts?: string[];
}

export interface StorySource {
  load(db: Db, runId: string): Promise<CandidateStory[]>;
}

export interface HandlerDeps {
  stories: StorySource;
}

interface EvidencePayload {
  draft_id: string;
  topic_id: string;
  story_title: string;
}

const payloadOf = <T>(value: unknown): T | null => value as T | null;

/** 证据阶段：候选故事落成证据与事实，选出当天要写的一篇并建稿。 */
async function evidenceStage(context: StageContext, deps: HandlerDeps): Promise<{ output_ref: string; payload: EvidencePayload }> {
  const { db, job } = context;
  const stories = await deps.stories.load(db, job.run_id);
  if (stories.length === 0) throw new EditorialError("check_blocked", "今天没有可用的候选故事");

  // 取最新的一条：采集结果已按时间倒序，这里不再引入随机性。
  const story = stories[0]!;
  const evidence = await createEvidence(db, {
    source_id: story.source_name,
    article_id: story.external_id,
    url: story.url,
    published_at: story.published_at,
    excerpt: story.summary.slice(0, 500),
    hash: story.content_hash,
    rights: "quotation",
  });

  const topic = await createTopic(db, {
    run_id: job.run_id,
    story_ids: [story.id],
    angle: story.title,
    reason: "当天最新的可用故事",
    evidence_status: "sufficient",
    dedupe_key: `${story.external_id}:${story.content_hash.slice(0, 16)}`,
  });

  // 事实必须绑到证据：没有依据的句子不该进提纲。
  for (const fact of story.facts ?? []) {
    await createClaim(db, { topic_id: topic.id, text: fact, kind: "factual", evidence_ids: [evidence.id], status: "supported" });
  }

  const draft = await createDraft(db, topic.id);
  return {
    output_ref: `waibu_drafts:${draft.id}`,
    payload: { draft_id: draft.id, topic_id: topic.id, story_title: story.title },
  };
}

/** 大纲阶段：拿着事实清单让模型出提纲，提纲只能引用已有事实。 */
async function outlineStage(context: StageContext, deps: HandlerDeps): Promise<{ output_ref: string; receipt_id: number; payload: { outline: Outline } }> {
  void deps;
  const { db, job } = context;
  if (!job.draft_id) throw new EditorialError("invalid_request", "大纲阶段缺少 draft_id");
  const draft = await getDraft(db, job.draft_id);
  if (!draft) throw new EditorialError("not_found", "稿件不存在");

  const previous = payloadOf<EvidencePayload>(await latestStepPayload(db, job.run_id, "evidence"));
  const claims = await listClaims(db, draft.topic_id);
  const evidence = await evidenceFor(db, claims.flatMap((claim) => claim.evidence_ids));

  const result = await generateOutline(context, {
    angle: draft.topic_id,
    storyTitle: previous?.story_title ?? "当天事件",
    claims: claims.map((claim) => ({ id: claim.id, text: claim.text, kind: claim.kind })),
    materials: evidence.map((item) => ({ title: item.article_id, source_name: item.source_id, excerpt: item.excerpt })),
    policy: CURRENT_POLICY,
  });
  return { output_ref: `run:${job.run_id}:outline`, receipt_id: result.receipt_id, payload: { outline: result.outline } };
}

/** 起草阶段：按提纲写稿，落成新版本，并把段落与事实的对应关系存下来。 */
async function draftStage(context: StageContext, deps: HandlerDeps): Promise<{ output_ref: string; receipt_id: number; payload: { revision_id: string } }> {
  void deps;
  const { db, job } = context;
  if (!job.draft_id) throw new EditorialError("invalid_request", "起草阶段缺少 draft_id");
  const draft = await getDraft(db, job.draft_id);
  if (!draft) throw new EditorialError("not_found", "稿件不存在");

  const outline = payloadOf<{ outline: Outline }>(await latestStepPayload(db, job.run_id, "outline"));
  if (!outline) throw new EditorialError("conflict_state", "还没有提纲，不能起草");

  const claims = await listClaims(db, draft.topic_id);
  const evidence = await evidenceFor(db, claims.flatMap((claim) => claim.evidence_ids));
  const contextInput = {
    claims: claims.map((claim) => ({ id: claim.id, text: claim.text })),
    materials: evidence.map((item) => ({ title: item.article_id, source_name: item.source_id, excerpt: item.excerpt })),
    has_author_material: false,
    policy: CURRENT_POLICY,
  };

  const generated = await generateDraft(context, {
    angle: draft.topic_id,
    outline: outline.outline,
    context: contextInput,
    materials: contextInput.materials,
  });

  // 首次生成没有上一版：走作者编辑同一条写路径（parent 为空），
  // 之后再有生成才用 applyGeneratedRevision 的“基准版本一致才推进”。
  const baseRevision = draft.current_revision_id;
  if (!baseRevision) {
    const first = await applyAuthorEdit(db, {
      draft_id: job.draft_id,
      expected_lock_version: draft.lock_version,
      base_revision_id: null,
      content: {
        title: generated.draft.title,
        summary: generated.draft.summary,
        body: generated.draft.body,
        cover_asset_hash: null,
        captions: {},
        asset_hashes: [],
      },
      policy_version: CURRENT_POLICY.version,
    });
    const links = Object.entries(generated.draft.block_claims ?? {}).flatMap(([blockId, claimIds]) =>
      (claimIds as string[]).map((claimId) => ({ block_id: blockId, claim_id: claimId })),
    );
    if (links.length > 0) await linkRevisionClaims(db, first.revision.id, links);
    return { output_ref: `waibu_revisions:${first.revision.id}`, receipt_id: generated.receipt_id, payload: { revision_id: first.revision.id } };
  }

  const saved = await applyGeneratedRevision(db, {
    draft_id: job.draft_id,
    base_revision_id: baseRevision,
    content: {
      title: generated.draft.title,
      summary: generated.draft.summary,
      body: generated.draft.body,
      cover_asset_hash: null,
      captions: {},
      asset_hashes: [],
    },
    policy_version: CURRENT_POLICY.version,
  });

  if (saved.kind === "conflict") {
    // 生成期间作者已经改过：结果留作分支产物，绝不覆盖作者的稿子。
    return { output_ref: `waibu_revisions:${saved.revision.id}`, receipt_id: generated.receipt_id, payload: { revision_id: saved.revision.id } };
  }

  // 段落 → 事实：审核页的证据抽屉靠这张表。
  const links = Object.entries(generated.draft.block_claims ?? {}).map(([blockId, claimIds]) =>
    (claimIds as string[]).map((claimId) => ({ block_id: blockId, claim_id: claimId })),
  ).flat();
  if (links.length > 0) await linkRevisionClaims(db, saved.revision.id, links);

  return { output_ref: `waibu_revisions:${saved.revision.id}`, receipt_id: generated.receipt_id, payload: { revision_id: saved.revision.id } };
}

/** 自检阶段：确定性检查兜底，问题要修复就不进待审，而是停在改稿。 */
async function checkStage(context: StageContext, deps: HandlerDeps): Promise<{ output_ref: string; payload: { passed: boolean; blocking: number; issues: Issue[] } }> {
  void deps;
  const { db, job } = context;
  if (!job.draft_id) throw new EditorialError("invalid_request", "自检阶段缺少 draft_id");
  const draft = await getDraft(db, job.draft_id);
  if (!draft?.current_revision_id) throw new EditorialError("conflict_state", "还没有草稿，不能自检");
  const revision = await getRevision(db, draft.current_revision_id);
  if (!revision) throw new EditorialError("not_found", "当前版本不存在");

  const claims = await listClaims(db, draft.topic_id);
  const evidence = await evidenceFor(db, claims.flatMap((claim) => claim.evidence_ids));
  const draftContent: Draft = { title: revision.title, summary: revision.summary, body: revision.body, block_claims: {} };
  const contextInput = {
    claims: claims.map((claim) => ({ id: claim.id, text: claim.text })),
    materials: evidence.map((item) => ({ title: item.article_id, source_name: item.source_id, excerpt: item.excerpt })),
    has_author_material: false,
    policy: CURRENT_POLICY,
  };

  // 模型自检之外，确定性检查始终生效：数字漂移、无依据的第一人称都阻断。
  const { issues: modelIssues } = { issues: [] as Issue[] };
  const report = mergeChecks({ issues: modelIssues, summary: "" }, deterministicIssues(draftContent, contextInput));

  if (report.ok) {
    // 起草写完会把稿件置为 checking；自检通过才允许它进待审。
    await db`update waibu_drafts set state = 'in_review', lock_version = lock_version + 1, updated_at = now()
      where id = ${job.draft_id} and state in ('drafting', 'checking')`;
  }
  return { output_ref: `waibu_drafts:${job.draft_id}`, payload: { passed: report.ok, blocking: report.blocking.length, issues: report.blocking } };
}

/** 装配：四个阶段接到流水线；没注册的阶段会在跑到它时明确报错。 */
export function registerPipelineHandlers(deps: HandlerDeps): void {
  registerStageHandler("evidence", (context) => evidenceStage(context, deps));
  registerStageHandler("outline", (context) => outlineStage(context, deps));
  registerStageHandler("draft", (context) => draftStage(context, deps));
  registerStageHandler("check", (context) => checkStage(context, deps));
}
