// 素材适配器：同事件多来源合并、撤回条目排除、快照 hash 可追溯、版权口径保守。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@aihot/backend/db";
import { loadArticleMaterial, loadStoryMaterials, materialHash, materialsDigest, truncate } from "../backend/materials/adapter.ts";

after(closeDb);

const NOW = new Date("2026-11-05T09:00:00+08:00");

async function source(id: string) {
  await sql`insert into sources (id, name, kind, participation_mode) values (${id}, ${`来源-${id}`}, 'rss', 'editorial')
            on conflict (id) do nothing`;
}

async function article(id: string, sourceId: string, body: string, publishedAt: string | null = "2026-11-05T07:00:00+08:00") {
  await sql`
    insert into articles (id, source_id, identity_key, url, title, published_at, discovered_at, timeline_at, excerpt, body_text)
    values (${id}, ${sourceId}, ${`ik-${id}`}, ${`https://example.com/${id}`}, ${`标题-${id}`}, ${publishedAt}, ${NOW.toISOString()},
            ${publishedAt ?? NOW.toISOString()}, ${body.slice(0, 200)}, ${body})`;
}

async function publication(id: string, sourceId: string, visibility: "public" | "summary-only" | "withdrawn", storyId: number | null, syndicate = false) {
  await sql`
    insert into publications (article_id, title, source_id, channel, timeline_at, discovered_at, sort_at, url, visibility, syndicate, story_id, selected, eligible)
    values (${id}, ${`标题-${id}`}, ${sourceId}, 'news', ${NOW.toISOString()}, ${NOW.toISOString()}, ${NOW.toISOString()},
            ${`https://example.com/${id}`}, ${visibility}, ${syndicate}, ${storyId}, true, true)`;
}

async function story(id: number) {
  // 显式指定 id 便于用例断言；public_id 是必填 uuid。
  await sql`insert into stories (id, public_id, title) values (${id}, ${randomUUID()}, ${`事件-${id}`})
            on conflict (id) do nothing`;
}

async function signal(storyId: number, articleId: string, sourceId: string) {
  await sql`
    insert into story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
    values (${storyId}, ${articleId}, ${`p-${articleId}`}, ${sourceId}, 'editorial', ${NOW.toISOString()})`;
}

test("同一事件的多家来源合成一个素材集合", async () => {
  const suffix = randomUUID().slice(0, 8);
  const storyId = 900000 + Math.floor(Math.random() * 99999);
  await story(storyId);
  for (const [index, who] of ["a", "b"].entries()) {
    const src = `mat-src-${suffix}-${who}`;
    const art = `mat-art-${suffix}-${who}`;
    await source(src);
    await article(art, src, `来自${who}的正文，第${index + 1}家报道。`);
    await publication(art, src, "public", storyId);
    await signal(storyId, art, src);
  }

  const materials = await loadStoryMaterials(sql, storyId);
  assert.ok(materials);
  assert.equal(materials!.sources.length, 2, "两家来源都要读到");
  assert.equal(new Set(materials!.sources.map((item) => item.source_id)).size, 2);
  assert.equal(materials!.digest, materialsDigest(materials!.sources));
  assert.ok(materials!.sources.every((item) => /^sha256:[0-9a-f]{64}$/u.test(item.hash)), "每条都要有可追溯的 hash");
});

test("撤回条目不作为新素材", async () => {
  const suffix = randomUUID().slice(0, 8);
  const storyId = 910000 + Math.floor(Math.random() * 9999);
  await story(storyId);
  for (const [who, visibility] of [["a", "public"], ["b", "withdrawn"]] as const) {
    const src = `mat-wd-${suffix}-${who}`;
    const art = `mat-wdart-${suffix}-${who}`;
    await source(src);
    await article(art, src, "正文");
    await publication(art, src, visibility, storyId);
    await signal(storyId, art, src);
  }

  const materials = await loadStoryMaterials(sql, storyId);
  assert.equal(materials!.sources.length, 1, "被撤回的那条不能进素材");
  assert.ok(!materials!.sources.some((item) => item.article_id.endsWith("-b")));
});

test("单篇素材读取同样排除撤回与空正文", async () => {
  const suffix = randomUUID().slice(0, 8);
  const src = `mat-single-${suffix}`;
  const ok = `mat-ok-${suffix}`;
  const gone = `mat-gone-${suffix}`;
  await source(src);
  await article(ok, src, "可引用的正文");
  await publication(ok, src, "public", null);
  await article(gone, src, "会被撤回的正文");
  await publication(gone, src, "withdrawn", null);

  assert.ok(await loadArticleMaterial(sql, ok));
  assert.equal(await loadArticleMaterial(sql, gone), null);
});

test("版权口径保守：默认只主张引用，明确允许转载才记 public", async () => {
  const suffix = randomUUID().slice(0, 8);
  const src = `mat-rights-${suffix}`;
  const quoted = `mat-quoted-${suffix}`;
  const syndicated = `mat-syndicated-${suffix}`;
  await source(src);
  await article(quoted, src, "正文");
  await publication(quoted, src, "public", null, false);
  await article(syndicated, src, "正文");
  await publication(syndicated, src, "public", null, true);

  assert.equal((await loadArticleMaterial(sql, quoted))!.rights, "quotation");
  assert.equal((await loadArticleMaterial(sql, syndicated))!.rights, "public");
});

test("来源变化会换 hash，旧快照不受影响", async () => {
  const before = materialHash({ article_id: "a1", url: "https://example.com/a", published_at: "2026-11-05T07:00:00.000Z", excerpt: "摘录" });
  const after = materialHash({ article_id: "a1", url: "https://example.com/a", published_at: "2026-11-05T07:00:00.000Z", excerpt: "摘录（更新）" });
  assert.notEqual(before, after);
  assert.match(before, /^sha256:[0-9a-f]{64}$/u);
});

test("摘录有长度上限，不搬运全文", () => {
  const long = "字".repeat(2000);
  const text = truncate(long, 100);
  assert.equal(text.length, 100);
  assert.ok(text.endsWith("…"));
});
