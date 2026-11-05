// 每日调度：北京时间到点后建当天唯一一次运行，并把流水线任务入队。
//
// 三条硬规则：
// 1. 一个业务日只建一次（重复触发、进程重启、补跑都一样）；
// 2. 待审积压到上限时当天不出稿，把原因记下来，而不是硬跑；
// 3. 错过点（进程没在跑）在同一天内补跑一次；跨天不补昨天的。
import type { Db } from "@aihot/backend/db";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { PIPELINE_VERSION } from "../../contracts/pipeline.ts";
import { ensureDailyRun, planStages } from "../workflow/index.ts";
import { loadSettings } from "../settings/index.ts";
import { pendingReviewCount } from "../board/index.ts";
import { enqueuePipeline } from "../jobs/queue.ts";

export type DailySkipReason = "not_due" | "already_started" | "pending_reviews";

export interface DailyOutcome {
  started: boolean;
  reason: DailySkipReason | "started";
  business_date: string;
  run_id: string | null;
  pending_reviews: number;
  detail: string;
}

/** 把 "08:30" 换成 cron。pg-boss 的时区在 worker 注册时统一指定为 Asia/Shanghai。 */
export function dailyCron(dailyTime: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(dailyTime);
  if (!match) throw new Error(`时间格式必须是 HH:MM：${dailyTime}`);
  return `${Number(match[2])} ${Number(match[1])} * * *`;
}

/** 今天这次是否已经到点：把两个时间都取到分钟再比，避免 "8:30" 与 "08:30" 的写法差异。 */
export function isDue(now: Date, dailyTime: string): boolean {
  return beijingTime(now).slice(0, 5) >= dailyTime;
}

export interface RunDailyInput {
  now?: Date;
  /** 测试注入：跳过真实入队。 */
  enqueue?: boolean;
}

/** 到点就跑一次；返回为什么跑、为什么没跑，方便面板与日志排查。 */
export async function runDailyOnce(db: Db, input: RunDailyInput = {}): Promise<DailyOutcome> {
  const now = input.now ?? new Date();
  const businessDate = beijingDate(now);
  const settings = await loadSettings(db);
  const pending = await pendingReviewCount(db);

  if (!isDue(now, settings.config.daily_time)) {
    return {
      started: false,
      reason: "not_due",
      business_date: businessDate,
      run_id: null,
      pending_reviews: pending,
      detail: `还没到 ${settings.config.daily_time}（北京时间 ${beijingTime(now)}）`,
    };
  }

  const [existing] = await db`
    select id from waibu_runs
    where mode = 'scheduled' and business_date = ${businessDate} and pipeline_version = ${PIPELINE_VERSION}
    limit 1`;
  if (existing) {
    return {
      started: false,
      reason: "already_started",
      business_date: businessDate,
      run_id: String(existing.id),
      pending_reviews: pending,
      detail: "今天已经跑过，不重复建运行",
    };
  }

  if (pending >= settings.config.max_pending_reviews) {
    return {
      started: false,
      reason: "pending_reviews",
      business_date: businessDate,
      run_id: null,
      pending_reviews: pending,
      detail: `待审已积压 ${pending} 篇（上限 ${settings.config.max_pending_reviews}），今天不出新稿`,
    };
  }

  const created = await ensureDailyRun(db, {
    business_date: businessDate,
    mode: "scheduled",
    input_hash: `sha256:${"0".repeat(64)}`,
    config_version: settings.version,
  });

  if (!created.run) throw new Error("创建定时运行失败：没有返回运行记录");
  if (input.enqueue !== false) {
    const stages = planStages({
      policy_version: "v1",
      prompt_version: "common",
      model_config_hash: "default",
      evidence_hashes: [],
      base_revision_id: null,
      feedback_ids: [],
    });
    // 只入队第一个阶段：后续阶段由上一个阶段成功后自动推进，避免全部并发抢同一份状态。
    const first = stages[0]!;
    await enqueuePipeline(db, {
      run_id: created.run.id,
      stage: first.stage,
      draft_id: null,
      base_revision_id: null,
      input_hash: first.input_hash,
      attempt: 1,
    });
  }

  return {
    started: true,
    reason: "started",
    business_date: businessDate,
    run_id: created.run.id,
    pending_reviews: pending,
    detail: `已创建 ${businessDate} 的定时运行`,
  };
}
