// 配置：改只影响新任务、旧运行保留旧版本、非法值拒绝、版本冲突明确。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { passwordLogin, SESSION_COOKIE } from "@aihot/backend/admin/auth";
import { registerEditorialRoutes } from "../backend/http-auth/routes.ts";
import { API_PREFIX } from "../contracts/api.ts";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, settingsSchema } from "../backend/settings/index.ts";
import { createRun } from "../backend/store/runs.ts";

after(closeDb);

const PASSWORD = `settings-test-password-${Date.now()}`;
let app: ReturnType<typeof Fastify>;
let token = "";
let csrf = "";

before(async () => {
  config.adminPassword = PASSWORD;
  app = Fastify({ logger: false });
  registerEditorialRoutes(app);
  await app.ready();
  token = (await passwordLogin(PASSWORD, "/admin", "settings-test")).token;
  const [session] = await sql`select csrf_token from admin_sessions order by created_at desc limit 1`;
  csrf = String(session!.csrf_token);
  await sql`delete from waibu_settings`;
});

const headers = () => ({ cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf });
const get = () => app.inject({ method: "GET", url: `${API_PREFIX}/settings`, headers: headers() });
const put = (body: unknown) => app.inject({ method: "PUT", url: `${API_PREFIX}/settings`, headers: { ...headers(), "content-type": "application/json" }, payload: JSON.stringify(body) });

test("没保存过时返回默认配置与版本 1", async () => {
  const response = await get();
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.version, 1);
  assert.deepEqual(body.config, DEFAULT_SETTINGS);
});

test("保存配置升一版，并记下改的人", async () => {
  const saved = await put({ settings: { ...DEFAULT_SETTINGS, max_drafts_per_day: 2 }, expected_version: 1 });
  assert.equal(saved.statusCode, 200, saved.body);
  const body = JSON.parse(saved.body);
  assert.equal(body.version, 2);
  assert.equal(body.config.max_drafts_per_day, 2);
  assert.ok(body.updated_by);
});

test("改配置只影响新任务，旧运行保留它当时的版本", async () => {
  const before = await loadSettings(sql);
  const tag = randomUUID().replace(/-/gu, "");
  const oldRun = await createRun(sql, {
    business_date: "2026-11-05",
    mode: "scheduled",
    pipeline_version: `cfg-${tag.slice(0, 8)}`,
    input_hash: `sha256:${tag.padEnd(64, "0")}`,
    config_version: before.version,
  });

  await sql.begin((tx) => saveSettings(tx, { settings: { ...before.config, max_drafts_per_day: 3 }, actor: "author", expected_version: before.version }));
  const after = await loadSettings(sql);
  assert.equal(after.version, before.version + 1);

  const newRun = await createRun(sql, {
    business_date: "2026-11-06",
    mode: "scheduled",
    pipeline_version: `cfg-${tag.slice(0, 8)}`,
    input_hash: `sha256:${"a".repeat(60)}${tag.slice(0, 4)}`,
    config_version: after.version,
  });

  const [oldRow] = await sql`select config_version from waibu_runs where id = ${oldRun.id}`;
  const [newRow] = await sql`select config_version from waibu_runs where id = ${newRun.id}`;
  assert.equal(Number(oldRow!.config_version), before.version, "旧运行指向它当时的配置版本");
  assert.equal(Number(newRow!.config_version), after.version, "新运行用新版本");
});

test("非法值被拒绝，库里不变", async () => {
  const before = await loadSettings(sql);
  for (const bad of [
    { ...before.config, max_drafts_per_day: 0 },
    { ...before.config, max_candidates_per_day: 99 },
    { ...before.config, daily_time: "25:00" },
    { ...before.config, daily_time: "8:30" },
    { ...before.config, max_repair_rounds: 9 },
  ]) {
    const response = await put({ settings: bad, expected_version: before.version });
    assert.equal(response.statusCode, 400, `应拒绝：${JSON.stringify(bad)}`);
    assert.equal(JSON.parse(response.body).code, "invalid_request");
  }
  const after = await loadSettings(sql);
  assert.equal(after.version, before.version, "被拒绝的保存不能改版本");
  assert.deepEqual(after.config, before.config);
});

test("版本冲突时拒绝保存，提示刷新", async () => {
  const current = await loadSettings(sql);
  const response = await put({ settings: { ...current.config, max_drafts_per_day: 4 }, expected_version: current.version - 1 });
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).code, "conflict_version");
});

test("schema 覆盖范围边界", () => {
  assert.ok(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, max_drafts_per_day: 1 }).success);
  assert.ok(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, max_drafts_per_day: 5 }).success);
  assert.ok(!settingsSchema.safeParse({ ...DEFAULT_SETTINGS, max_drafts_per_day: 6 }).success);
  assert.ok(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, daily_time: "00:00" }).success);
  assert.ok(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, daily_time: "23:59" }).success);
});
