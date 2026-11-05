// 自检：伪造的证据引用、标题与正文矛盾、修不好的问题，都要停下并留下记录；
// 模型说“通过”不算数，循环有上限，也不能自己把稿子标成已批准。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import {
  checkWithRepair,
  checkSchema,
  deterministicIssues,
  mergeChecks,
  type Issue,
  type QualityReport,
} from "../backend/quality/index.ts";
import type { Draft } from "../backend/drafting/index.ts";
import { CURRENT_POLICY } from "../policy/index.ts";
import { evaluateClaims } from "../backend/quality/claims.ts";

after(closeDb);

const draft = (overrides: Partial<Draft> = {}): Draft => ({
  title: "新版定价意味着什么",
  summary: "价格来自官方。",
  body: "订阅价格为每月 20 美元。\n\n版本 v3.2。",
  block_claims: {},
  ...overrides,
});

const context = {
  claims: [
    { id: "c1", text: "订阅价格为每月 20 美元" },
    { id: "c2", text: "当前版本号是 v3.2" },
  ],
  materials: [{ title: "官方发布", excerpt: "订阅价格为每月 20 美元，版本 v3.2。" }],
  has_author_material: false,
  policy: CURRENT_POLICY,
};

const blocking = (message: string): Issue => ({ block_id: "", kind: "fact", severity: "blocking", message });
const pass: QualityReport = { blocking: [], warnings: [], ok: true };

test("模型说没问题，但数字漂移仍阻断", () => {
  const moved = draft({ body: "订阅价格为每月 25 美元。" });
  const deterministic = deterministicIssues(moved, context);
  const merged = mergeChecks({ issues: [], summary: "看起来没问题" }, deterministic);
  assert.equal(merged.ok, false, "确定性检查不能被模型结论覆盖");
  assert.ok(merged.blocking.some((issue) => issue.message.includes("25")));
});

test("伪造的 claim_id 会被判定为悬空引用", () => {
  const report = evaluateClaims({ c1: ["c1"], b2: ["c1", "not-a-claim"] }, context.claims.map((claim) => claim.id));
  assert.equal(report.ok, false);
  assert.deepEqual(report.dangling, ["not-a-claim"]);
});

test("标题与正文矛盾会被标成阻断项", () => {
  const contradictory = draft({ title: "价格翻倍了", body: "订阅价格仍是每月 20 美元。" });
  const report = evaluateClaims({}, context.claims.map((claim) => claim.id));
  assert.equal(report.ok, true, "引用本身没问题");
  const merged = mergeChecks(
    { issues: [{ block_id: "", kind: "conflict", severity: "blocking", message: "标题说价格翻倍，正文说价格未变" }], summary: "" },
    deterministicIssues(contradictory, context),
  );
  assert.equal(merged.ok, false);
});

test("修不好就停：两轮之后转 on_hold，保留剩余问题", async () => {
  let repairs = 0;
  const result = await checkWithRepair({
    draft: draft(),
    context,
    check: async () => ({ blocking: [blocking("价格仍有冲突")], warnings: [], ok: false }),
    repair: async () => {
      repairs += 1;
      return draft({ body: "订阅价格为每月 20 美元，仍然冲突。" });
    },
  });
  assert.equal(result.status, "on_hold");
  assert.equal(repairs, 2, "最多修两轮");
  assert.equal(result.rounds.length, 2);
  assert.equal(result.remaining.length, 1);
  assert.equal(result.report.ok, false);
});

test("修好了就通过，并记录用了几轮", async () => {
  let attempt = 0;
  const result = await checkWithRepair({
    draft: draft(),
    context,
    check: async () => {
      attempt += 1;
      return attempt === 1 ? { blocking: [blocking("缺少版本号")], warnings: [], ok: false } : pass;
    },
    repair: async () => draft({ body: "订阅价格为每月 20 美元。\n\n版本 v3.2。" }),
  });
  assert.equal(result.status, "passed");
  assert.equal(result.rounds.length, 1);
  assert.deepEqual(result.remaining, []);
});

test("一次就通过时不做无谓修复", async () => {
  let repairs = 0;
  const result = await checkWithRepair({
    draft: draft(),
    context,
    check: async () => pass,
    repair: async () => {
      repairs += 1;
      return draft();
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(repairs, 0);
  assert.equal(result.rounds.length, 0);
});

test("改不动时立即停止，不把同样的稿子反复重试", async () => {
  let checks = 0;
  const result = await checkWithRepair({
    draft: draft(),
    context,
    check: async () => {
      checks += 1;
      return { blocking: [blocking("材料不足")], warnings: [], ok: false };
    },
    repair: async () => null,
  });
  assert.equal(result.status, "on_hold");
  assert.equal(checks, 1, "拿不到修订就不再继续检");
  assert.equal(result.rounds.length, 1);
});

test("自检结果里没有“已批准”这种出口", async () => {
  const result = await checkWithRepair({ draft: draft(), context, check: async () => pass, repair: async () => draft() });
  assert.deepEqual(Object.keys(result).sort(), ["draft", "remaining", "report", "rounds", "status"]);
  assert.ok(["passed", "on_hold"].includes(result.status));
});

test("自检输出 schema 会拒绝未知问题类型", () => {
  assert.throws(() => checkSchema.parse({ issues: [{ kind: "vibe", severity: "blocking", message: "感觉不对" }] }));
  assert.doesNotThrow(() => checkSchema.parse({ issues: [{ kind: "fact", severity: "blocking", message: "价格冲突" }] }));
});
