// 私人接口权限：没登录一律 401，写请求缺 CSRF 一律 403，响应都 no-store，
// 业务错误按自己的错误码返回，不把内部异常直接甩给页面。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { endSession, passwordLogin, SESSION_COOKIE } from "@aihot/backend/admin/auth";
import { EditorialError } from "../contracts/errors.ts";
import { editorialHandler } from "../backend/http-auth/index.ts";
import { registerEditorialRoutes } from "../backend/http-auth/routes.ts";
import { API_PREFIX } from "../contracts/api.ts";

after(closeDb);

const PASSWORD = `editorial-test-password-${Date.now()}`;
let app: ReturnType<typeof Fastify>;
let token = "";
let csrf = "";

before(async () => {
  config.adminPassword = PASSWORD;
  app = Fastify({ logger: false });
  registerEditorialRoutes(app);
  // 只为验证写请求的 CSRF 与错误码映射，不暴露真实业务接口。
  app.post(`${API_PREFIX}/echo`, editorialHandler(async (req) => ({ ok: true, body: req.body })));
  app.post(`${API_PREFIX}/conflict`, editorialHandler(async () => {
    throw new EditorialError("conflict_version", "版本不一致", { expected: 1, current: 2 });
  }));
  await app.ready();

  const login = await passwordLogin(PASSWORD, "/admin", "editorial-test");
  token = login.token;
  const [session] = await sql`select csrf_token from admin_sessions order by created_at desc limit 1`;
  csrf = String(session!.csrf_token);
});

const cookie = (value = token) => ({ cookie: `${SESSION_COOKIE}=${value}` });
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });

test("未登录访问私人接口返回 401，并且不缓存", async () => {
  const response = await get(`${API_PREFIX}/health`);
  assert.equal(response.statusCode, 401);
  const body = JSON.parse(response.body);
  assert.equal(body.code, "unauthorized");
  assert.equal(body.status, 401);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.ok(body.requestId, "错误响应要能对上日志");
});

test("带有效会话可以访问", async () => {
  const response = await get(`${API_PREFIX}/health`, cookie());
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.match(body.policy_version, /^\d{4}-\d{2}-\d{2}\.\d+$/u);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("伪造的会话不能被当成登录", async () => {
  const response = await get(`${API_PREFIX}/health`, cookie("forged-token"));
  assert.equal(response.statusCode, 401);
});

test("写请求缺少 CSRF 令牌返回 403", async () => {
  const response = await app.inject({ method: "POST", url: `${API_PREFIX}/echo`, headers: cookie(), payload: { hello: "world" } });
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).code, "forbidden");
});

test("写请求带正确 CSRF 令牌通过", async () => {
  const response = await app.inject({
    method: "POST",
    url: `${API_PREFIX}/echo`,
    headers: { ...cookie(), "x-csrf-token": csrf },
    payload: { hello: "world" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, body: { hello: "world" } });
});

test("业务错误按错误码返回，带可用的 details", async () => {
  const response = await app.inject({ method: "POST", url: `${API_PREFIX}/conflict`, headers: { ...cookie(), "x-csrf-token": csrf }, payload: {} });
  assert.equal(response.statusCode, 409);
  const body = JSON.parse(response.body);
  assert.equal(body.code, "conflict_version");
  assert.deepEqual(body.details, { expected: 1, current: 2 });
});

test("模块只注册私人前缀，不碰公开出口", () => {
  const routes = app.printRoutes({ commonPrefix: false });
  assert.match(routes, /api\/admin\/editorial\/health/u);
  for (const open of ["/api/v1", "/api/mcp", "/feed", "/sitemap", "/llms.txt"]) {
    // 按路径段匹配：/feedback 不能被误判成 /feed
    const segment = new RegExp(`(^|[\\s/])${open.replace(/[/.]/gu, "\\$&")}([/\\s]|$)`, "u");
    assert.ok(!segment.test(routes), `模块不应注册公开出口：${open}`);
  }
});

test("退出登录后会话立即失效", async () => {
  const login = await passwordLogin(PASSWORD, "/admin", "editorial-test-2");
  const ok = await get(`${API_PREFIX}/health`, cookie(login.token));
  assert.equal(ok.statusCode, 200);
  await endSession(`${SESSION_COOKIE}=${login.token}`);
  const denied = await get(`${API_PREFIX}/health`, cookie(login.token));
  assert.equal(denied.statusCode, 401);
});
