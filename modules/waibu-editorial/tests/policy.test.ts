// 规则与提示词：版本可追溯、改规则会换阶段键、旧稿保留原版本、运行时不依赖本机技能目录。
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { CURRENT_POLICY, POLICY_V1, currentPolicy, policyHash, policyVersion } from "../policy/index.ts";
import { buildCheckSystem, buildEditorialSystem, COMMON_PROMPT_VERSION } from "../prompts/common/index.ts";
import { stageInputHash } from "../contracts/pipeline.ts";
import { appendRevision, createDraft, createRun, createTopic, getRevision } from "../backend/store/index.ts";

after(closeDb);

test("规则有明确版本，当前规则取自仓库而不是本机目录", () => {
  assert.equal(policyVersion(), POLICY_V1.version);
  assert.equal(currentPolicy(), CURRENT_POLICY);
  assert.match(policyVersion(), /^\d{4}-\d{2}-\d{2}\.\d+$/u, "版本号带日期与序号");
});

test("改一条规则就会换规则指纹，从而换阶段键", () => {
  const changed = { ...CURRENT_POLICY, version: "2099-01-01.1", forbidden_claims: [...CURRENT_POLICY.forbidden_claims, "不许编造读者提问"] };
  assert.notEqual(policyHash(changed), policyHash(CURRENT_POLICY));

  const base = {
    stage: "draft" as const,
    policy_version: CURRENT_POLICY.version,
    prompt_version: COMMON_PROMPT_VERSION,
    model_config_hash: "sha256:" + "a".repeat(64),
    evidence_hashes: [],
    base_revision_id: null,
    feedback_ids: [],
  };
  assert.notEqual(stageInputHash({ ...base, policy_version: changed.version }), stageInputHash(base), "规则版本变化必须换键");
});

test("规则内容真的进了提示词，不是只存在配置里", () => {
  const editorial = buildEditorialSystem(CURRENT_POLICY);
  assert.ok(editorial.includes(CURRENT_POLICY.account.name));
  for (const claim of CURRENT_POLICY.forbidden_claims) assert.ok(editorial.includes(claim), `禁写清单缺少：${claim}`);
  for (const rule of CURRENT_POLICY.voice.rules) assert.ok(editorial.includes(rule), `文字规则缺少：${rule}`);

  const check = buildCheckSystem(CURRENT_POLICY);
  assert.match(check, /没有批准权限/u, "自检不能自己把稿子判成可发布");
  assert.ok(check.includes(CURRENT_POLICY.forbidden_claims[0]!));
});

test("规则与提示词不依赖开发机的技能目录或绝对路径", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ts$/u.test(entry)) {
        const text = readFileSync(full, "utf8");
        if (/~\/\.agents|~\/\.codex|~\/\.claude|\/Users\//u.test(text)) offenders.push(full);
      }
    }
  };
  walk("modules/waibu-editorial/policy");
  walk("modules/waibu-editorial/prompts");
  assert.deepEqual(offenders, [], "生产规则必须自包含，不能指向作者电脑上的路径");
});

test("旧版本保留它当时的规则版本，不随当前规则改变", async () => {
  const run = await createRun(sql, { business_date: "2026-11-05", mode: "manual", pipeline_version: "policy", input_hash: "sha256:" + "9".repeat(64) });
  const topic = await createTopic(sql, { run_id: run.id, story_ids: [1], angle: "角度", reason: "", evidence_status: "sufficient", dedupe_key: `k-policy-${run.id}` });
  const draft = await createDraft(sql, topic.id);

  const { revision } = await sql.begin((tx) =>
    appendRevision(tx, {
      draft_id: draft.id,
      parent_id: null,
      content: { title: "标题", summary: "", body: "正文", cover_asset_hash: null, captions: {}, asset_hashes: [] },
      policy_version: "2026-11-05.0",
      created_by: "model",
      expected_lock_version: draft.lock_version,
      next_state: "checking",
    }),
  );

  const stored = await getRevision(sql, revision.id);
  assert.equal(stored?.policy_version, "2026-11-05.0", "旧稿必须保留生成它时的规则版本");
  assert.notEqual(stored?.policy_version, CURRENT_POLICY.version);
});
