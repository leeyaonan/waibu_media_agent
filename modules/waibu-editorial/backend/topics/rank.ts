// 候选选题：先过证据与可写性门槛，再排序。热度只是输入之一，不能代替证据。
// 判定全部是确定性的，模型只负责后续写角度与提纲，避免“模型说好就写好”。
import { inputHash } from "../../contracts/content.ts";
import type { EditorialPolicy } from "../../policy/index.ts";
import type { MaterialSource, StoryMaterials } from "../materials/adapter.ts";
import { hasFullText, independentCount } from "../evidence/support.ts";

export interface ScoreWeights {
  /** 独立来源数量在总分里的权重。 */
  evidence: number;
  /** 与账号方向的贴合度。 */
  relevance: number;
  /** 不依赖作者亲历也能写出来的程度。 */
  writability: number;
  /** 新鲜度（发布时间距现在）。 */
  freshness: number;
}

/** 初始权重，尚未用真实样本校准；打算在试运行后用结果调整。 */
export const DEFAULT_WEIGHTS: ScoreWeights = { evidence: 0.4, relevance: 0.25, writability: 0.2, freshness: 0.15 };

export interface Thresholds {
  /** 独立证据少于这个数就不进自动起草。 */
  min_independent_sources: number;
  /** 总分低于这个数不出稿。 */
  min_total_score: number;
  /** 没有正文级素材时是否允许出“资料分析稿”。 */
  allow_summary_only: boolean;
}

export const DEFAULT_THRESHOLDS: Thresholds = { min_independent_sources: 1, min_total_score: 0.45, allow_summary_only: true };

export interface Candidate {
  story_id: number;
  title: string;
  /** 选题角度：这里先用最直接的一手事实做占位，模型在提纲阶段细化。 */
  angle: string;
  reason: string;
  dedupe_key: string;
  score: number;
  evidence_status: "sufficient" | "insufficient" | "disputed";
  scores: { evidence: number; relevance: number; writability: number; freshness: number };
  /** 被排除时写明原因，页面要显示“为什么没选它”。 */
  excluded_because: string | null;
}

/** 与账号方向的贴合度：按 policy 里的 focus 关键词命中比例算，0～1。 */
export function relevanceScore(materials: StoryMaterials, policy: EditorialPolicy): number {
  const text = `${materials.title} ${materials.sources.map((item) => `${item.title} ${item.excerpt}`).join(" ")}`.toLowerCase();
  const keywords = policy.account.focus.flatMap((focus) => focus.toLowerCase().split(/[\s/]+/u)).filter((word) => word.length >= 2);
  if (keywords.length === 0) return 0.5;
  const hits = keywords.filter((word) => text.includes(word)).length;
  return Math.min(1, hits / Math.max(3, Math.ceil(keywords.length / 3)));
}

/** 可写性：有正文级素材、来源不止一家时更容易写成有细节的稿子；只有摘要时打折。 */
export function writabilityScore(sources: readonly MaterialSource[]): number {
  if (sources.length === 0) return 0;
  const fullText = sources.filter(hasFullText).length;
  const independent = independentCount(sources);
  const base = Math.min(1, independent / 3);
  return Math.min(1, base * 0.6 + (fullText / sources.length) * 0.4);
}

/** 新鲜度：一天内满分，一周线性衰减到 0。 */
export function freshnessScore(publishedAt: string | null, now: Date): number {
  if (!publishedAt) return 0;
  const ageHours = (now.getTime() - new Date(publishedAt).getTime()) / 3_600_000;
  if (ageHours <= 24) return 1;
  return Math.max(0, 1 - (ageHours - 24) / (7 * 24 - 24));
}

/** 同事件同角度去重键：新进展会换角度，从而产生新键，不会被旧事件一刀切排除。 */
export function dedupeKey(storyId: number, angle: string): string {
  return inputHash({ story_id: storyId, angle: angle.trim().toLowerCase() }).slice(7, 39);
}

export interface RankOptions {
  policy: EditorialPolicy;
  weights?: ScoreWeights;
  thresholds?: Thresholds;
  now?: Date;
}

/**
 * 给一个事件打分成候选。证据不足的仍然返回，但带上排除原因，
 * 这样“今天为什么没写这条”在页面上可解释，而不是静默丢弃。
 */
export function rankCandidate(materials: StoryMaterials, options: RankOptions): Candidate {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const now = options.now ?? new Date();

  const independent = independentCount(materials.sources);
  const hasBody = materials.sources.some(hasFullText);
  const latest = materials.sources
    .map((item) => item.published_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;

  const scores = {
    evidence: Math.min(1, independent / 2),
    relevance: relevanceScore(materials, options.policy),
    writability: writabilityScore(materials.sources),
    freshness: freshnessScore(latest, now),
  };
  const score = Number(
    (scores.evidence * weights.evidence + scores.relevance * weights.relevance + scores.writability * weights.writability + scores.freshness * weights.freshness).toFixed(3),
  );

  let excluded: string | null = null;
  if (materials.sources.length === 0) excluded = "没有可用素材";
  else if (independent < thresholds.min_independent_sources) excluded = `独立来源不足 ${thresholds.min_independent_sources} 条`;
  else if (!hasBody && !thresholds.allow_summary_only) excluded = "只有标题或摘要，不能支撑细节";
  else if (score < thresholds.min_total_score) excluded = `总分 ${score} 低于门槛 ${thresholds.min_total_score}`;

  const evidenceStatus = independent >= thresholds.min_independent_sources ? (hasBody ? "sufficient" : "disputed") : "insufficient";
  const angle = materials.title;
  return {
    story_id: materials.story_id,
    title: materials.title,
    angle,
    reason: excluded ?? `独立来源 ${independent} 条，可写性 ${scores.writability.toFixed(2)}，新鲜度 ${scores.freshness.toFixed(2)}`,
    dedupe_key: dedupeKey(materials.story_id, angle),
    score,
    evidence_status: evidenceStatus,
    scores,
    excluded_because: excluded,
  };
}

/** 排序并截断到当日候选上限；被排除的放在后面，供页面展示“为什么没选”。 */
export function selectCandidates(candidates: readonly Candidate[], limit: number): Candidate[] {
  return [...candidates]
    .sort((a, b) => {
      const aBlocked = a.excluded_because ? 1 : 0;
      const bBlocked = b.excluded_because ? 1 : 0;
      if (aBlocked !== bBlocked) return aBlocked - bBlocked;
      return b.score - a.score || a.story_id - b.story_id;
    })
    .slice(0, limit);
}

export interface NoCandidateResult {
  skipped: true;
  reason: string;
  considered: number;
}

/** 没有合格候选时的明确结果：页面显示原因，而不是空白。 */
export function noCandidates(candidates: readonly Candidate[]): NoCandidateResult {
  return {
    skipped: true,
    reason: candidates.length === 0 ? "今天没有可用的公开资料" : `共有 ${candidates.length} 个事件，都不满足门槛`,
    considered: candidates.length,
  };
}
