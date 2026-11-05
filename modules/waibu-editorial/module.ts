// 模块的地址声明：私人工作台页面与它占用的 API 前缀。
// 页面放在统一的私人 layout 下，layout 自己校会话；这里声明路径不等于给了权限。
import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "waibu-editorial",
  pages: [
    {
      layout: "web/layout.tsx",
      id: "waibu-editorial-layout",
      pages: [
        { path: "editorial", file: "web/board.tsx", id: "waibu-editorial-board" },
        { path: "editorial/drafts/:draftId", file: "web/review.tsx", id: "waibu-editorial-review" },
        { path: "editorial/runs", file: "web/runs.tsx", id: "waibu-editorial-runs" },
      ],
    },
  ],
  // 这些路径由 api 进程回答，web 只转发。
  apiPaths: [/^\/api\/admin\/editorial\//],
});
