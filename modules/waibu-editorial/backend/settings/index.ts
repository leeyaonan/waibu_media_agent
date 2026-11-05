// 编辑策略配置：每天出几篇、几个候选、什么时候跑。
//
// 规则：配置带版本，每次修改升一版；运行记录自己用的版本，
// 所以改配置只影响之后的运行，旧稿与旧运行保留它们当时的策略。
import { z } from "zod";
import type { Db, Tx } from "@aihot/backend/db";
import { BUDGET_DEFAULTS } from "../../contracts/pipeline.ts";
import { EditorialError } from "../../contracts/errors.ts";
import { jsonValue } from "../store/rows.ts";

/** 每天的定时时间：HH:MM（北京时间）。 */
const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/u;

export const settingsSchema = z.object({
  max_drafts_per_day: z.number().int().min(1).max(5),
  max_candidates_per_day: z.number().int().min(1).max(10),
  max_pending_reviews: z.number().int().min(1).max(10),
  /** 定时运行的本地时间，例如 "08:30"。 */
  daily_time: z.string().regex(timePattern, "时间必须是 HH:MM"),
  max_repair_rounds: z.number().int().min(0).max(3),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  max_drafts_per_day: BUDGET_DEFAULTS.max_drafts_per_day,
  max_candidates_per_day: BUDGET_DEFAULTS.max_candidates_per_day,
  max_pending_reviews: BUDGET_DEFAULTS.max_pending_reviews,
  daily_time: "08:30",
  max_repair_rounds: BUDGET_DEFAULTS.max_repair_rounds,
};

export interface SettingsRecord {
  config: Settings;
  version: number;
  updated_by: string | null;
  updated_at: string | null;
}

/** 读当前配置；还没保存过时返回默认值与版本 1（不写库）。 */
export async function loadSettings(db: Db): Promise<SettingsRecord> {
  const [row] = await db`select config, version, updated_by, updated_at from waibu_settings where id = 1`;
  if (!row) return { config: DEFAULT_SETTINGS, version: 1, updated_by: null, updated_at: null };
  const parsed = settingsSchema.safeParse(jsonValue<unknown>(row.config));
  return {
    // 库里存了被手工改坏的配置时退回默认值，不让页面直接崩。
    config: parsed.success ? parsed.data : DEFAULT_SETTINGS,
    version: Number(row.version),
    updated_by: row.updated_by ? String(row.updated_by) : null,
    updated_at: row.updated_at ? new Date(row.updated_at as string).toISOString() : null,
  };
}

export interface SaveSettingsInput {
  settings: unknown;
  actor: string;
  /** 页面带来的当前版本；不一致说明别处已经改过。 */
  expected_version: number;
}

/** 保存配置：校验 → 版本 +1 → 返回新版本。非法值直接拒绝，不写库。 */
export async function saveSettings(tx: Tx, input: SaveSettingsInput): Promise<SettingsRecord> {
  const parsed = settingsSchema.safeParse(input.settings);
  if (!parsed.success) {
    throw new EditorialError("invalid_request", parsed.error.issues.map((issue) => `${issue.path.join(".") || "配置"}: ${issue.message}`).join("; "));
  }

  const current = await loadSettings(tx);
  if (current.version !== input.expected_version) {
    throw new EditorialError("conflict_version", "配置已经被改过，请刷新后再保存", { expected: input.expected_version, current: current.version });
  }

  const [saved] = await tx`
    insert into waibu_settings (id, config, version, updated_by, updated_at)
    values (1, ${JSON.stringify(parsed.data)}::jsonb, ${current.version + 1}, ${input.actor}, now())
    on conflict (id) do update set
      config = excluded.config,
      version = waibu_settings.version + 1,
      updated_by = excluded.updated_by,
      updated_at = now()
    returning config, version, updated_by, updated_at`;

  return {
    config: settingsSchema.parse(jsonValue<unknown>(saved!.config)),
    version: Number(saved!.version),
    updated_by: saved!.updated_by ? String(saved!.updated_by) : null,
    updated_at: new Date(saved!.updated_at as string).toISOString(),
  };
}

/** 新建运行时记录它用的配置版本；配置之后怎么改都不影响这条记录。 */
export async function settingsVersionForRun(db: Db): Promise<number> {
  const record = await loadSettings(db);
  return record.version;
}

/** 页面与测试共用的“为什么拒绝”说明。 */
export function explainRange(): string {
  return "每天稿数 1–5、候选 1–10、积压上限 1–10、修复轮数 0–3、时间必须 HH:MM";
}
