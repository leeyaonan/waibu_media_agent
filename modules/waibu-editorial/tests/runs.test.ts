// 运行与费用面板：预算暂停有原因、usage 缺失不显示 0 元、不暴露密钥与整段 prompt、
// 恢复只补未成功阶段。
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
import { createRun, finishStep, startStep } from "../backend/store/runs.ts";
import { listRuns, resumableStages, runDetail, EXPOSED_STEP_FIELDS } from "../backend/runs/index.ts";

after(closeDb);

const PASSWORD = `runs-test-password-${Date.now()}`;
let app: ReturnType<typeof Fastify>;
let token = "";

before(async () => {
  config.adminPassword = PASSWORD;
  app = Fastify({ logger: false });
  registerEditorialRoutes(app);
  await app.ready();
  token = (await passwordLogin(PASSWORD, "/admin", "runs-test")).token;
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: `${SESSION_COOKIE}=${token}` } });

async function seedRun() {
  const tag = randomUUID().replace(/-/gu, "");
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: `runs-${tag.slice(0, 8)}`, input_hash: `sha256:${tag.padEnd(64, "0")}` });
  const evidence = await startStep(sql, { run_id: run.id, stage: "evidence", input_hash: `sha256:${"1".repeat(64)}` });
  await finishStep(sql, evidence.id, "succeeded", { output_ref: "waibu_evidence:1" });
  const outline = await startStep(sql, { run_id: run.id, stage: "outline", input_hash: `sha256:${"2".repeat(64)}` });
  await finishStep(sql, outline.id, "paused_budget", { error_code: "budget_paused" });
  return run.id;
}

test("预算暂停会给出可读原因，并指出停在哪个阶段", async () => {
  const runId = await seedRun();
  const detail = (await runDetail(sql, runId))!;
  assert.match(detail.paused_reason ?? "", /预算|次数/u);
  assert.match(detail.paused_reason ?? "", /outline/u);
});

test("恢复只补未成功的阶段", async () => {
  const runId = await seedRun();
  const detail = (await runDetail(sql, runId))!;
  assert.equal(detail.steps.length, 2);
  assert.deepEqual(resumableStages(detail.steps), ["outline", "draft", "check", "revise"], "evidence 已成功，不再重跑");
});

test("usage 缺失或价格未知时费用为 unknown，不显示 0", async () => {
  const runId = await seedRun();
  const detail = (await runDetail(sql, runId))!;
  assert.equal(detail.cost, null, "没有价格信息时合计必须是 null");
  assert.ok(detail.steps.every((step) => step.cost === null));
  assert.equal(detail.total_tokens, 0, "没有 usage 就是 0 token，不是编造的数字");
});

test("有价格时才给出合计", async () => {
  const runId = await seedRun();
  const [receipt] = await sql`
    insert into receipts (logical_key, service, model, purpose, status, usage, cost, currency, cost_basis)
    values (${`runs-${runId}`}, 'llm', 'test-model', 'waibu.draft', 'completed',
            ${sql.json({ prompt_tokens: 100, completion_tokens: 200 } as never)}, 0.25, 'CNY', 'actual')
    returning id`;
  const step = await startStep(sql, { run_id: runId, stage: "draft", input_hash: `sha256:${"3".repeat(64)}` });
  await sql`update waibu_steps set receipt_id = ${receipt.id}, status = 'succeeded' where id = ${step.id}`;

  const detail = (await runDetail(sql, runId))!;
  assert.deepEqual(detail.cost, { amount: 0.25, currency: "CNY" });
  assert.equal(detail.total_tokens, 300);
});

test("面板不暴露密钥与整段提示词", async () => {
  const runId = await seedRun();
  const response = await get(`${API_PREFIX}/runs/${runId}`);
  assert.equal(response.statusCode, 200);
  const body = response.body;
  assert.ok(!/sk-|api_key|Bearer /iu.test(body), "响应里不能出现密钥痕迹");
  const parsed = JSON.parse(body);
  for (const step of parsed.steps) {
    for (const key of Object.keys(step)) {
      assert.ok(EXPOSED_STEP_FIELDS.includes(key as never), `面板多暴露了字段：${key}`);
    }
  }
  assert.ok(!("request" in parsed.steps[0]), "请求体（含整段 prompt）不进面板");
});

test("运行列表按时间倒序并带阶段完成数", async () => {
  const runId = await seedRun();
  const items = await listRuns(sql, 10);
  assert.ok(items.length >= 1);
  const found = items.find((item) => item.run.id === runId);
  assert.ok(found);
  assert.equal(found!.stages_done, 1, "只有 evidence 成功");
});

test("未登录读运行面板返回 401", async () => {
  const response = await app.inject({ method: "GET", url: `${API_PREFIX}/runs` });
  assert.equal(response.statusCode, 401);
});
