// 模块的后端插口：把私人接口装进 api 进程。
// 页面、队列、定时任务的注册分别在 module.ts / backend/jobs / schedules，F37 总装时补齐。
import { defineServerModule } from "@aihot/backend/modules";
import { registerEditorialRoutes } from "./backend/http-auth/routes.ts";
import { dailyCron, runDailyOnce } from "./backend/schedule/index.ts";
import { sql } from "@aihot/backend/db";
import { PIPELINE_QUEUE, EXPORT_QUEUE } from "./backend/jobs/queue.ts";
import { loadSettings } from "./backend/settings/index.ts";
import { registerPipelineHandlers, type StorySource } from "./backend/jobs/handlers.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 候选故事来源：优先读 WAIBU_STORY_FIXTURE 指定的 fixture 文件，
 * 生产环境由采集结果提供（F40 接真实来源）。读不到就明确报错，不让流水线空转。
 */
const fixtureStories: StorySource = {
  async load() {
    const file = process.env.WAIBU_STORY_FIXTURE;
    if (!file) throw new Error("没有配置候选故事来源：请设置 WAIBU_STORY_FIXTURE");
    const raw = await readFile(path.resolve(file), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as never) : [];
  },
};

// 装配阶段实现与推进器；顶层 await 在模块加载时完成。
await registerPipelineHandlers({ stories: fixtureStories });

export default defineServerModule({
  name: "waibu-editorial",
  http: (app) => registerEditorialRoutes(app),
  queues: [PIPELINE_QUEUE, EXPORT_QUEUE],
  // 每天按设置里的时间跑一次；错过会补跑一次（missed: "once"），当天重复触发不会多建运行。
  schedules: [
    {
      name: "waibu.daily",
      // 具体钟点由设置决定，这里给默认值；worker 启动时会按设置重新注册。
      cron: dailyCron("08:30"),
      missed: "once",
      run: async () => {
        const settings = await loadSettings(sql);
        await runDailyOnce(sql, { now: new Date() });
        void settings;
      },
    },
  ],
});
