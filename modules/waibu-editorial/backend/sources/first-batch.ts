// 首批信源：在引擎示范信源里挑出与「AI 编程 / 工具变化 / 真实实践」直接相关的官方与媒体来源，
// 由 seed 导入后统一打上公众号选题用途。不加入付费 X / 公众号抓取源，首版只用公开 RSS 与网页。
//
// 新增信源请同时在 industry/sources.json 里补条目（引擎按那个文件建源），这里只决定哪些参与选题。
import type { Db } from "@aihot/backend/db";
import { markEditorialUse } from "./eligibility.ts";

/** 官方发布优先：一手材料能支撑版本、价格与限制类结论。 */
export const FIRST_BATCH_SOURCE_IDS: readonly string[] = [
  "rss-openai-news",
  "rss-google-deepmind",
  "rss-hugging-face",
  "rss-github-ai",
  "rss-mistral",
  "rss-simon-willison",
  "rss-latent-space",
  "rss-the-verge-ai",
];

/** 把首批信源标成选题来源；库里不存在的 id 直接跳过（不影响首次部署）。 */
export async function applyFirstBatch(db: Db, ids: readonly string[] = FIRST_BATCH_SOURCE_IDS): Promise<{ marked: number; missing: string[] }> {
  const found = await db`select id from sources where id = any(${ids as unknown as string}::text[])`;
  const present = found.map((row) => String(row.id));
  const missing = ids.filter((id) => !present.includes(id));
  const marked = await markEditorialUse(db, present);
  return { marked, missing };
}
