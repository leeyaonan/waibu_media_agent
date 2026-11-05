// 模块的后端插口：把私人接口装进 api 进程。
// 页面、队列、定时任务的注册分别在 module.ts / backend/jobs / schedules，F37 总装时补齐。
import { defineServerModule } from "@aihot/backend/modules";
import { registerEditorialRoutes } from "./backend/http-auth/routes.ts";

export default defineServerModule({
  name: "waibu-editorial",
  http: (app) => registerEditorialRoutes(app),
});
