// 每日调度：到点才跑、一天一次、积压暂停、错过当天补跑。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql } from "@aihot/backend/db";
import { dailyCron, isDue, runDailyOnce } from "../backend/schedule/index.ts";
import { saveSettings, loadSettings, DEFAULT_SETTINGS } from "../backend/settings/index.ts";

after(async () => {});

async function resetSettings(): Promise<void> {
  await sql`delete from waibu_settings`;
  const current = await loadSettings(sql);
  await sql.begin((tx) => saveSettings(tx, { settings: { ...DEFAULT_SETTINGS, daily_time: "08:30" }, actor: "test", expected_version: current.version }));
}

test("时间换成 cron", () => {
  assert.equal(dailyCron("08:30"), "30 8 * * *");
  assert.equal(dailyCron("00:05"), "5 0 * * *");
  assert.equal(dailyCron("23:59"), "59 23 * * *");
  assert.throws(() => dailyCron("8:30"), /HH:MM/u);
  assert.throws(() => dailyCron("25:00"), /HH:MM/u);
});

test("到点判断按北京时间", () => {
  assert.equal(isDue(new Date("2026-11-05T00:29:00.000Z"), "08:30"), false, "北京 08:29 还不到");
  assert.equal(isDue(new Date("2026-11-05T00:30:00.000Z"), "08:30"), true);
  assert.equal(isDue(new Date("2026-11-04T23:59:00.000Z"), "08:30"), false, "北京 07:59 还没到");
});

test("没到点不建运行", async () => {
  await resetSettings();
  const outcome = await runDailyOnce(sql, { now: new Date("2026-11-05T00:10:00.000Z"), enqueue: false }); // 北京 08:10
  assert.equal(outcome.started, false);
  assert.equal(outcome.reason, "not_due");
});

test("到点建当天唯一一次运行", async () => {
  await resetSettings();
  const first = await runDailyOnce(sql, { now: new Date("2026-11-05T02:00:00.000Z"), enqueue: false }); // 北京 10:00
  assert.equal(first.started, true, first.detail);
  assert.equal(first.business_date, "2026-11-05");

  const second = await runDailyOnce(sql, { now: new Date("2026-11-05T03:00:00.000Z"), enqueue: false });
  assert.equal(second.started, false);
  assert.equal(second.reason, "already_started");
  assert.equal(second.run_id, first.run_id, "重复触发复用的是同一个运行");

  const rows = await sql`select count(*)::int as n from waibu_runs where mode = 'scheduled' and business_date = '2026-11-05'`;
  assert.equal(rows[0]!.n, 1);
});

test("待审积压到上限时当天不出稿", async () => {
  await resetSettings();
  // 先把库里遗留的待审稿挪开，让计数只反映本用例造的数据
  await sql`update waibu_drafts set state = 'rejected' where state in ('in_review', 'revising', 'checking')`;
  // 造出超过上限的待审稿
  const [run] = await sql`insert into waibu_runs (business_date, mode, pipeline_version, input_hash)
    values ('2026-11-06', 'manual', 'seed', ${"sha256:" + "b".repeat(64)}) returning id`;
  // 一篇稿子一个选题：drafts.topic_id 是唯一的，不能往同一个选题上塞多篇
  for (let i = 0; i < DEFAULT_SETTINGS.max_pending_reviews; i += 1) {
    const [topic] = await sql`insert into waibu_topics (run_id, story_ids, angle, reason, evidence_status, dedupe_key)
      values (${run.id}, '{1}'::bigint[], ${"角度" + i}, '', 'sufficient', ${"d" + Date.now() + i}) returning id`;
    await sql`insert into waibu_drafts (topic_id, state) values (${topic.id}, 'in_review')`;
  }
  const outcome = await runDailyOnce(sql, { now: new Date("2026-11-06T02:00:00.000Z"), enqueue: false });
  assert.equal(outcome.started, false);
  assert.equal(outcome.reason, "pending_reviews");
  assert.match(outcome.detail, /积压/u);
});

test("错过点当天补跑一次，跨天不补昨天", async () => {
  await resetSettings();
  // 上一个用例故意堆了待审稿；这里先清空积压，否则会被“积压暂停”挡住
  await sql`update waibu_drafts set state = 'rejected' where state in ('in_review', 'revising', 'checking')`;
  await sql`delete from waibu_runs where mode = 'scheduled' and business_date in ('2026-11-07','2026-11-08')`;
  // 11-07 的 08:30 没跑（进程不在），到 11-07 晚上 23:00 才起来
  const late = await runDailyOnce(sql, { now: new Date("2026-11-07T15:00:00.000Z"), enqueue: false });
  assert.equal(late.started, true, "当天补跑一次");
  assert.equal(late.business_date, "2026-11-07");

  // 第二天 09:00 正常触发，是新的业务日
  const next = await runDailyOnce(sql, { now: new Date("2026-11-08T01:00:00.000Z"), enqueue: false });
  assert.equal(next.started, true);
  assert.equal(next.business_date, "2026-11-08");
  assert.notEqual(next.run_id, late.run_id);

  const yesterday = await sql`select count(*)::int as n from waibu_runs where mode='scheduled' and business_date='2026-11-07'`;
  assert.equal(yesterday[0]!.n, 1, "昨天只补了一次");
});
