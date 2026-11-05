// 公众号选题对信源的要求。引擎负责采集；这里定义“哪些信源和文章能进入选题”，
// 以及后台要看到的失败信息。
//
// 三条硬规则（来自设计文档）：
// 1. 停用的信源不参与选题；
// 2. 没有可信发布时间的内容不进入自动选题；
// 3. 首次导入的旧文不刷“今天”——按原文时间判断新鲜度，不按入库时间。
import type { Db } from "@aihot/backend/db";
import { serverModules } from "@aihot/backend/modules";
import type { SourceUse } from "@aihot/backend/modules";

/** 本模块声明的信源用途；F37 装配时通过 ServerModule.sourceUses 注册。 */
export const EDITORIAL_SOURCE_USE: SourceUse = {
  label: "公众号选题",
  /** 即使信源自己的采集频率更慢，也要保证每天至少看一眼。 */
  minutes: 1440,
};

export const EDITORIAL_USE_KEY = "editorial";

/** 标记一批信源为公众号选题来源；已带的不会重复。 */
export async function markEditorialUse(db: Db, sourceIds: readonly string[]): Promise<number> {
  if (sourceIds.length === 0) return 0;
  const updated = await db`
    update sources set uses = (
      select array_agg(distinct u) from unnest(uses || ${EDITORIAL_USE_KEY}::text) as u
    ), updated_at = now()
    where id = any(${sourceIds}::text[])`;
  return updated.count;
}

/** 一个信源是否可用于选题：启用中，并且要么参加内容流水线，要么被显式标了选题用途。 */
export function isSourceEligible(source: { enabled: boolean; participation_mode: string; uses: readonly string[] }): boolean {
  if (!source.enabled) return false;
  return source.participation_mode === "editorial" || source.uses.includes(EDITORIAL_USE_KEY);
}

export interface EligibleArticle {
  id: string;
  source_id: string;
  url: string;
  title: string;
  published_at: string;
  discovered_at: string;
}

export interface EligibleQuery {
  /** 只看最近多少小时内的原文；默认 48 小时。 */
  windowHours?: number;
  limit?: number;
  /** 便于测试固定“现在”。 */
  now?: Date;
}

/**
 * 可用于选题的文章：来源合格、有可信发布时间、在时间窗内、同一 URL 只取一条。
 * 用 appear 时间（published_at）判断新鲜度，不用入库时间，避免首次导入把旧文当成今天。
 */
export async function eligibleArticles(db: Db, query: EligibleQuery = {}): Promise<EligibleArticle[]> {
  const windowHours = query.windowHours ?? 48;
  const limit = query.limit ?? 50;
  const now = query.now ?? new Date();
  const rows = await db`
    select distinct on (a.url) a.id, a.source_id, a.url, a.title, a.published_at, a.discovered_at
    from articles a
    join sources s on s.id = a.source_id
    where s.enabled
      and (s.participation_mode = 'editorial' or ${EDITORIAL_USE_KEY} = any(s.uses))
      and a.published_at is not null
      and a.published_at >= ${now}::timestamptz - make_interval(hours => ${windowHours})
    order by a.url, a.published_at desc
    limit ${limit}`;
  return rows.map((row) => ({
    id: String(row.id),
    source_id: String(row.source_id),
    url: String(row.url),
    title: String(row.title),
    published_at: new Date(row.published_at as string).toISOString(),
    discovered_at: new Date(row.discovered_at as string).toISOString(),
  }));
}

/** 没有可信发布时间的文章有多少：不进入选题，但要能在后台看见有多少被挡下。 */
export async function undatedArticleCount(db: Db): Promise<number> {
  const [row] = await db`select count(*)::int as n from articles where published_at is null`;
  return Number(row?.n ?? 0);
}

export interface FailingSource {
  id: string;
  name: string;
  health: string;
  fail_count: number;
  last_error: string | null;
  last_fetch_at: string | null;
}

/** 采集失败或正在退化的信源：页面要能直接看到，而不是等人工去翻日志。 */
export async function failingSources(db: Db, limit = 20): Promise<FailingSource[]> {
  const rows = await db`
    select id, name, health, fail_count, last_error, last_fetch_at
    from sources
    where enabled and (health in ('degraded', 'failing') or fail_count > 0)
    order by fail_count desc, last_fetch_at desc nulls last
    limit ${limit}`;
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    health: String(row.health),
    fail_count: Number(row.fail_count),
    last_error: row.last_error === null ? null : String(row.last_error),
    last_fetch_at: row.last_fetch_at ? new Date(row.last_fetch_at as string).toISOString() : null,
  }));
}

/** 本模块声明过的信源用途名，供检查装配是否漏注册。 */
export function declaredUses(): string[] {
  return serverModules().flatMap((module) => Object.keys(module.sourceUses ?? {}));
}
