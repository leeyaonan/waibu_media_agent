// 素材适配器：把 AIHOT 已有的 article / story 读成公众号可用的素材，不复制它的库。
// 一个事件（story）可以有多个来源；撤回或不可公开的条目不进素材；每条都留自身 hash 以便追溯。
//
// 版权口径保守：默认只主张“引用摘录”，只有信源明确允许转载时才记为 public。
import type { Db } from "@aihot/backend/db";
import { inputHash } from "../../contracts/content.ts";

/** 摘录上限：只留支持结论所需的片段，不搬运全文。 */
export const EXCERPT_LIMIT = 800;

export interface MaterialSource {
  article_id: string;
  source_id: string;
  source_name: string;
  story_id: number | null;
  url: string;
  title: string;
  /** 原文发布时间；缺失表示没有可信时间，不能用于对时效敏感的结论。 */
  published_at: string | null;
  excerpt: string;
  /** quotation：只引用摘录；public：来源允许转载。 */
  rights: "quotation" | "public";
  /** 该条素材的快照 hash，内容或来源变化都会变。 */
  hash: string;
}

export interface StoryMaterials {
  story_id: number;
  title: string;
  sources: MaterialSource[];
  /** 全部素材 hash 的汇总，用于阶段键与“素材是否变过”的判断。 */
  digest: string;
}

function truncate(text: string, limit = EXCERPT_LIMIT): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

/** 一条素材的快照 hash：来源、原文、时间、摘录任何一项变化都会换。 */
export function materialHash(parts: { article_id: string; url: string; published_at: string | null; excerpt: string }): string {
  return inputHash({ v: 1, ...parts });
}

interface ArticleRow {
  id: string;
  source_id: string;
  source_name: string;
  url: string;
  title: string;
  published_at: Date | null;
  excerpt: string | null;
  body_text: string | null;
  syndicate: boolean;
  visibility: string;
  story_id: string | number | null;
}

function toSource(row: ArticleRow): MaterialSource {
  const text = (row.excerpt ?? row.body_text ?? "").trim();
  const excerpt = truncate(text);
  const published = row.published_at ? new Date(row.published_at).toISOString() : null;
  return {
    article_id: row.id,
    source_id: row.source_id,
    source_name: row.source_name,
    story_id: row.story_id === null ? null : Number(row.story_id),
    url: row.url,
    title: row.title,
    published_at: published,
    excerpt,
    // 只有来源在 publications 上明确允许转载时才记 public。
    rights: row.syndicate ? "public" : "quotation",
    hash: materialHash({ article_id: row.id, url: row.url, published_at: published, excerpt }),
  };
}

const ARTICLE_COLUMNS = (db: Db) => db`
  a.id, a.source_id, s.name as source_name, a.url, a.title, a.published_at,
  a.excerpt, a.body_text, p.syndicate, p.visibility, p.story_id`;

/**
 * 一个事件的全部可用素材。只取参加内容流水线的 editorial 报道，
 * 排除 withdrawn / summary-only 的条目——撤回的资料不能再拿来写新稿。
 */
export async function loadStoryMaterials(db: Db, storyId: number): Promise<StoryMaterials | null> {
  const rows = await db`
    select ${ARTICLE_COLUMNS(db)}
    from story_signals sig
    join articles a on a.id = sig.article_id
    join sources s on s.id = a.source_id
    join publications p on p.article_id = a.id
    where sig.story_id = ${storyId}
      and sig.kind = 'editorial'
      and p.visibility = 'public'
    order by a.published_at desc nulls last, a.id`;

  const [story] = await db`select id, title from stories where id = ${storyId}`;
  if (!story) return null;
  const sources = (rows as unknown as ArticleRow[]).map(toSource).filter((item) => item.excerpt.length > 0);
  return {
    story_id: Number(story.id),
    title: String(story.title),
    sources,
    digest: inputHash(sources.map((item) => item.hash).sort()),
  };
}

/** 单篇文章的素材；不可公开或已撤回时返回 null。 */
export async function loadArticleMaterial(db: Db, articleId: string): Promise<MaterialSource | null> {
  const [row] = await db`
    select ${ARTICLE_COLUMNS(db)}
    from articles a
    join sources s on s.id = a.source_id
    join publications p on p.article_id = a.id
    where a.id = ${articleId} and p.visibility = 'public'`;
  if (!row) return null;
  const material = toSource(row as unknown as ArticleRow);
  return material.excerpt.length > 0 ? material : null;
}

/** 供后续阶段判断“同一事件是否已经有素材、素材有没有变”。 */
export function materialsDigest(sources: readonly MaterialSource[]): string {
  return inputHash(sources.map((item) => item.hash).sort());
}

export { truncate };
