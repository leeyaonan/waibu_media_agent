// 模型调用层：回执复用、失败分类、单稿额度与费用展示。全部走本地 stub，不访问任何外部服务。
import { Reply, stub } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { callModel, classifyModelFailure, retryableFailure } from "../backend/model/client.ts";
import { draftUsage, formatCost } from "../backend/model/budget.ts";
import { executePipelineJob, registerStageHandler } from "../backend/jobs/index.ts";
import { createDraft, createRun, createTopic } from "../backend/store/index.ts";

after(closeDb);

const schema = z.object({ headline: z.string() });

const answer = (content: string) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

async function pointAt(server: { url: string }) {
  process.env.LLM_BASE_URL = `${server.url}/v1`;
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";
}

interface AskOverrides {
  subject?: string;
  /** 回执的逻辑键由请求内容决定，各用例必须给不同的输入。 */
  user?: string;
  draft_id?: string | null;
  timeoutMs?: number;
}

const ask = (overrides: AskOverrides = {}) =>
  callModel(sql, {
    draft_id: overrides.draft_id ?? null,
    purpose: "waibu.test",
    prompt_version: "v1",
    subject: overrides.subject ?? `subject-${Math.random().toString(36).slice(2, 8)}`,
    system: "系统提示",
    user: overrides.user ?? `用户输入-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    schema,
    timeoutMs: overrides.timeoutMs,
  });

test("同样的请求只发一次，第二次复用回执", async (t) => {
  const server = await stub(() => answer(JSON.stringify({ headline: "标题" })));
  t.after(() => server.close());
  await pointAt(server);

  const user = "reuse-case-input";
  const first = await ask({ user });
  const second = await ask({ user });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true, "第二次必须复用已保存的响应");
  assert.equal(second.receipt_id, first.receipt_id);
  assert.equal(server.hits(), 1, "同一个逻辑请求不能真的发两次");
  assert.equal(first.data.headline, "标题");
});

test("供应商返回非法 JSON 归为输出不可用，不重试", async (t) => {
  const server = await stub(() => answer("这不是 JSON"));
  t.after(() => server.close());
  await pointAt(server);

  const error = await ask({ user: `bad-json-${Date.now()}` }).catch((e: unknown) => e);
  assert.equal(classifyModelFailure(error), "output_unusable", `${(error as Error)?.constructor?.name}: ${String(error)}`);
  assert.equal(retryableFailure("output_unusable"), false);
});

test("429 归为供应商临时不可用，可重试", async (t) => {
  const server = await stub(() => new Reply(429, { error: { message: "rate limited" } }));
  t.after(() => server.close());
  await pointAt(server);

  const error = await ask({ user: `rate-limit-${Date.now()}` }).catch((e: unknown) => e);
  const code = classifyModelFailure(error);
  assert.equal(code, "provider_outage");
  assert.equal(retryableFailure(code), true);
});

test("超时归为结果未知，可重试但不会重复计费", async (t) => {
  const server = await stub(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return answer(JSON.stringify({ headline: "迟到的标题" }));
  });
  t.after(() => server.close());
  await pointAt(server);

  const error = await ask({ user: `timeout-${Date.now()}`, timeoutMs: 120 }).catch((e: unknown) => e);
  assert.equal(classifyModelFailure(error), "outcome_unknown");
  assert.equal(retryableFailure("outcome_unknown"), true);
});

test("单稿额度耗尽时不发请求，抛 budget_paused", async (t) => {
  const server = await stub(() => answer(JSON.stringify({ headline: "不该被调用" })));
  t.after(() => server.close());
  await pointAt(server);

  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: "budget", input_hash: "sha256:" + "b".repeat(64) });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-budget-${run.id}` });
  const draft = await createDraft(sql, topic.id);

  const [receipt] = await sql`
    insert into receipts (logical_key, service, model, purpose, status, usage)
    values (${`waibu-budget-${draft.id}`}, 'llm', 'test-model', 'waibu.test', 'completed',
            ${sql.json({ prompt_tokens: 10, completion_tokens: 90_000 } as never)})
    returning id`;
  await sql`
    insert into waibu_steps (run_id, stage, input_hash, attempt, status, draft_id, receipt_id)
    values (${run.id}::uuid, 'draft', ${"sha256:" + "c".repeat(64)}, 1, 'succeeded', ${draft.id}::uuid, ${receipt.id}::bigint)`;

  await assert.rejects(() => ask({ draft_id: draft.id, user: "budget-case" }), /输出 token 上限|调用次数上限/u);
  assert.equal(server.hits(), 0, "额度耗尽时一个请求都不能发");

  const usage = await draftUsage(sql, draft.id);
  assert.ok(usage.output_tokens >= 90_000);
});

test("额度耗尽时阶段标成暂停，而不是失败重试", async () => {
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: "paused", input_hash: "sha256:" + "d".repeat(64) });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [2], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-paused-${run.id}` });
  const draft = await createDraft(sql, topic.id);

  registerStageHandler("outline", async () => {
    const { EditorialError } = await import("../contracts/errors.ts");
    throw new EditorialError("budget_paused", "额度用完了");
  });

  const outcome = await executePipelineJob({
    run_id: run.id,
    stage: "outline",
    draft_id: draft.id,
    base_revision_id: null,
    input_hash: "sha256:" + "e".repeat(64),
    attempt: 1,
  });
  assert.equal(outcome, "paused");
  const [step] = await sql`select status, error_code from waibu_steps where run_id = ${run.id} and stage = 'outline'`;
  assert.equal(step!.status, "paused_budget");
  assert.equal(step!.error_code, "budget_paused");
});

test("费用不知道就显示 unknown，不填 0", async () => {
  assert.equal(formatCost(null), "unknown");
  assert.equal(formatCost({ amount: 1.5, currency: "CNY" }), "CNY 1.50");

  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: "cost", input_hash: "sha256:" + "f".repeat(64) });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [3], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-cost-${run.id}` });
  const draft = await createDraft(sql, topic.id);

  const [known] = await sql`
    insert into receipts (logical_key, service, model, purpose, status, usage, cost, currency, cost_basis)
    values (${`waibu-cost-known-${draft.id}`}, 'llm', 'm', 'waibu.test', 'completed',
            ${sql.json({ prompt_tokens: 1, completion_tokens: 2 } as never)}, 0.5, 'CNY', 'actual')
    returning id`;
  const [unknownReceipt] = await sql`
    insert into receipts (logical_key, service, model, purpose, status, usage)
    values (${`waibu-cost-unknown-${draft.id}`}, 'llm', 'm', 'waibu.test', 'completed',
            ${sql.json({ prompt_tokens: 1, completion_tokens: 2 } as never)})
    returning id`;
  await sql`
    insert into waibu_steps (run_id, stage, input_hash, attempt, status, draft_id, receipt_id)
    values (${run.id}::uuid, 'draft', ${"sha256:" + "1".repeat(64)}, 1, 'succeeded', ${draft.id}::uuid, ${known.id}::bigint),
           (${run.id}::uuid, 'check', ${"sha256:" + "2".repeat(64)}, 1, 'succeeded', ${draft.id}::uuid, ${unknownReceipt.id}::bigint)`;

  const usage = await draftUsage(sql, draft.id);
  assert.equal(usage.calls, 2);
  assert.equal(usage.unknown_cost_calls, 1);
  assert.equal(usage.cost, null, "有未知价格时合计没有意义");
  assert.equal(formatCost(usage.cost), "unknown");
});

test("页面不调用模型：web 侧没有任何模型调用入口", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/u.test(entry)) {
        const text = readFileSync(full, "utf8");
        if (/providers\/llm|backend\/model|chatJson/u.test(text)) offenders.push(full);
      }
    }
  };
  walk("apps/web/app");
  assert.deepEqual(offenders, [], "页面只能读数据库里已有的结果，模型只在 worker 里调用");
});
