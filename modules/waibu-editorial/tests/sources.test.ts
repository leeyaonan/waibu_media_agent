// 信源准入：停用源、无发布时间、首次导入的旧文、重复 URL、失败源，都按设计文档的规则处理。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { applyFirstBatch, FIRST_BATCH_SOURCE_IDS } from "../backend/sources/first-batch.ts";
import { eligibleArticles, failingSources, isSourceEligible, markEditorialUse, undatedArticleCount } from "../backend/sources/eligibility.ts";

after(closeDb);

const NOW = new Date("2026-11-05T09:00:00+08:00");
let seq = 0;

beforeEach(async () => {
  seq += 1;
  await sql`delete from articles where source_id like ${`src-test-${seq}%`}`;
  await sql`delete from sources where id like ${`src-test-${seq}%`}`;
});

async function source(id: string, overrides: { enabled?: boolean; mode?: string; uses?: string[]; health?: string; fail_count?: number } = {}) {
  await sql`
    insert into sources (id, name, kind, participation_mode, enabled, uses, health, fail_count)
    values (${id}, ${id}, 'rss', ${overrides.mode ?? "editorial"}, ${overrides.enabled ?? true},
            ${sql.array(overrides.uses ?? [])}, ${overrides.health ?? "ok"}, ${overrides.fail_count ?? 0})`;
}

async function article(id: string, sourceId: string, publishedAt: string | null, url = `https://example.com/${id}`) {
  await sql`
    insert into articles (id, source_id, identity_key, url, title, published_at, discovered_at, timeline_at)
    values (${id}, ${sourceId}, ${`ik-${id}`}, ${url}, ${`标题-${id}`}, ${publishedAt}, ${NOW.toISOString()}, ${publishedAt ?? NOW.toISOString()})`;
}

test("停用的信源不参与选题", async () => {
  await source(`src-test-${seq}-off`, { enabled: false });
  await article(`a-off-${seq}`, `src-test-${seq}-off`, "2026-11-05T08:00:00+08:00");
  const rows = await eligibleArticles(sql, { now: NOW });
  assert.ok(!rows.some((row) => row.source_id === `src-test-${seq}-off`));
  assert.equal(isSourceEligible({ enabled: false, participation_mode: "editorial", uses: [] }), false);
});

test("没有可信发布时间的内容不进入自动选题", async () => {
  await source(`src-test-${seq}-nodate`);
  await article(`a-nodate-${seq}`, `src-test-${seq}-nodate`, null);
  const rows = await eligibleArticles(sql, { now: NOW });
  assert.ok(!rows.some((row) => row.id === `a-nodate-${seq}`), "无发布时间不能进选题");
  assert.ok((await undatedArticleCount(sql)) >= 1, "被挡下的数量要能看见");
});

test("首次导入的旧文不刷今天", async () => {
  await source(`src-test-${seq}-old`);
  await article(`a-old-${seq}`, `src-test-${seq}-old`, "2026-11-01T08:00:00+08:00");
  await article(`a-new-${seq}`, `src-test-${seq}-old`, "2026-11-05T07:00:00+08:00");

  const rows = await eligibleArticles(sql, { now: NOW, windowHours: 48 });
  assert.ok(!rows.some((row) => row.id === `a-old-${seq}`), "三天前的原文不能进今天的选题");
  assert.ok(rows.some((row) => row.id === `a-new-${seq}`), "窗口内的原文要能进");
});

test("同一 URL 只返回一条", async () => {
  await source(`src-test-${seq}-dup`);
  const url = "https://example.com/same-post";
  await article(`a-dup1-${seq}`, `src-test-${seq}-dup`, "2026-11-05T07:30:00+08:00", url);
  await article(`a-dup2-${seq}`, `src-test-${seq}-dup`, "2026-11-05T07:31:00+08:00", url);

  const rows = (await eligibleArticles(sql, { now: NOW })).filter((row) => row.url === url);
  assert.equal(rows.length, 1);
});

test("只有标了选题用途或参加内容流水线的信源才算数", async () => {
  assert.equal(isSourceEligible({ enabled: true, participation_mode: "editorial", uses: [] }), true);
  assert.equal(isSourceEligible({ enabled: true, participation_mode: "hot_signal", uses: ["editorial"] }), true);
  assert.equal(isSourceEligible({ enabled: true, participation_mode: "hot_signal", uses: [] }), false);
});

test("标记选题用途是幂等的", async () => {
  await source(`src-test-${seq}-use`, { mode: "hot_signal", uses: [] });
  await markEditorialUse(sql, [`src-test-${seq}-use`]);
  await markEditorialUse(sql, [`src-test-${seq}-use`]);
  const [row] = await sql`select uses from sources where id = ${`src-test-${seq}-use`}`;
  assert.deepEqual(row!.uses, ["editorial"]);
});

test("失败的信源可见，并且带上失败原因", async () => {
  await source(`src-test-${seq}-bad`, { health: "failing", fail_count: 5 });
  await sql`update sources set last_error = 'HTTP 503' where id = ${`src-test-${seq}-bad`}`;
  const failing = await failingSources(sql);
  const found = failing.find((row) => row.id === `src-test-${seq}-bad`);
  assert.ok(found, "失败信源必须出现在列表里");
  assert.equal(found!.last_error, "HTTP 503");
  assert.equal(found!.fail_count, 5);
});

test("首批信源标记只处理库里存在的，缺的返回名单", async () => {
  for (const id of FIRST_BATCH_SOURCE_IDS.slice(0, 2)) {
    await sql`insert into sources (id, name, kind, participation_mode) values (${id}, ${id}, 'rss', 'hot_signal')
              on conflict (id) do update set uses = '{}'`;
  }
  const result = await applyFirstBatch(sql, [...FIRST_BATCH_SOURCE_IDS.slice(0, 2), "src-does-not-exist"]);
  assert.equal(result.marked, 2);
  assert.deepEqual(result.missing, ["src-does-not-exist"]);
});
