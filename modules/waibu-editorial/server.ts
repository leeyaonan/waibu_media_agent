// 模块的后端插口：把私人接口装进 api 进程。
// 页面、队列、定时任务的注册分别在 module.ts / backend/jobs / schedules，F37 总装时补齐。
import { defineServerModule } from "@aihot/backend/modules";
import { registerEditorialRoutes } from "./backend/http-auth/routes.ts";
import { dailyCron, runDailyOnce } from "./backend/schedule/index.ts";
import { sql } from "@aihot/backend/db";
import { loadSettings } from "./backend/settings/index.ts";

export default defineServerModule({
  name: "waibu-editorial",
  http: (app) => registerEditorialRoutes(app),
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
