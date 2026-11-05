# AIHOT 调研与接入依据

调研日期：2026-11-05，Asia/Shanghai。依据已克隆的实际源码；未运行引擎、未测试真实信源或模型效果。

## 1. 基线

- 上游：[KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT)。
- commit：`cd424b0a513c7c8535b6f291b106a3086d6b75bf`，拉取时为 main HEAD。
- 本地参考：产品仓库外的 `../references/AIHOT/`；已克隆 686 个被跟踪文件，工作树干净。
- [package.json](https://github.com/KKKKhazix/AIHOT/blob/cd424b0a513c7c8535b6f291b106a3086d6b75bf/package.json) 声明 Node.js `>=24.22.1`、npm workspaces；使用 TypeScript、React Router、Fastify、PostgreSQL、pg-boss。部署模板使用 PostgreSQL 17。
- [LICENSE](https://github.com/KKKKhazix/AIHOT/blob/cd424b0a513c7c8535b6f291b106a3086d6b75bf/LICENSE) 为 MIT；[NOTICE](https://github.com/KKKKhazix/AIHOT/blob/cd424b0a513c7c8535b6f291b106a3086d6b75bf/NOTICE) 明确品牌名称及 Logo 不在该许可中，字体另有许可。首次引入时保留这些文件。

本文件中源码路径均相对上游仓库；以下为源码观察，架构选择和新增功能另见 [设计](02-design.md)。

## 2. 已有能力与本项目缺口

| 领域 | AIHOT 已有 | 歪布需要增加 |
|---|---|---|
| 信息获取 | RSS、网页列表、JSON、X、公众号、外部推送；调频与去重 | 适合本账号的源名单与关注方向；首版先用公开 RSS/网页 |
| 筛选 | 预筛、两次评分、分级门槛、评测工具 | 公众号选题的读者价值、可写性、证据完整度和历史重复度 |
| 事件 | 聚合相同事件、关联进展、热度、综述 | 选题和文章关联事件版本；识别值得重写的新进展 |
| 写作 | 标题、摘要、推荐理由、翻译、结构化事实 | 有独立主线的长文、标题摘要组合、作者风格、改稿 |
| 日报 | 规则编排日报，周/月报生成部分总述 | 不把日报拼接当成公众号长文；增加文章独立状态与版本 |
| 管理 | 来源、评分、模型、运行、预算与审计 | 私人审核队列、版本对比、批注、批准与发布包 |
| 运行 | worker、pg-boss、定时任务、模型回执、请求预算 | 长文任务阶段、并发保护、补跑、质量与成本追踪 |

上游 [README](https://github.com/KKKKhazix/AIHOT/blob/cd424b0a513c7c8535b6f291b106a3086d6b75bf/README.md) 说明开源版附带示范源，不包含线上运营数据和完整信源名单。X、公众号等接入涉及外部服务配置，克隆仓库不等于已经具备这些数据。

## 3. 已核实的扩展点

| 源码 | 核实结果 | 本项目用法 |
|---|---|---|
| `packages/backend/src/modules.ts` | `ServerModule` 支持 `http/models/schedules/queues/on/alerts/retention` 等 | 单个公众号模块注册后端与 worker 能力 |
| `packages/contracts/src/modules.ts` | 模块声明页面、layout 和 `apiPaths` | 注册编辑工作台；页面声明本身不提供权限 |
| `apps/web/app/modules.ts` | Web 模块支持导航及页面部件 | 复用 Web 技术栈，避免另建前端 |
| `site/modules/{index.ts,server.ts,web.ts}` | 站点安装模块的三份清单 | 按层注册，框架不反向依赖公众号模块 |
| `packages/backend/src/jobs/queue.ts` | `defineQueue` 配合 `enqueueOn`；支持事务传入 | 稿件状态更新与入队原子提交 |
| `apps/worker/src/schedules.ts` | cron 使用 `Asia/Shanghai`；记录运行、可控制错过后的行为 | 每日计划与恢复任务沿用该机制 |
| `packages/backend/src/providers/llm.ts` | `chatJson` 支持 schema、模型、promptVersion、subject 等 | 分阶段结构化输出，保留模型回执 |
| `packages/backend/src/providers/receipts.ts` | 稳定请求身份、保存响应、预算、未知结果处理、`completeReceipt` | 复用成功结果；产物落库后完成回执 |
| `apps/api/src/routes/admin-auth.ts` | `adminHandler` 验证会话与写请求 CSRF | 模块每条私人 API 显式包装 |
| `apps/web/app/lib/admin.server.ts` | `adminGet`、`adminSignedIn` 等后台访问辅助 | 私人页面 loader 显式鉴权 |
| `packages/backend/src/publication/` | 统一公共资料范围、事实条件和撤回逻辑 | 素材适配器复用范围判断；不写入私人稿件 |

接口定义可查看固定版本的 [后端模块源码](https://github.com/KKKKhazix/AIHOT/blob/cd424b0a513c7c8535b6f291b106a3086d6b75bf/packages/backend/src/modules.ts) 和 [架构文档](https://github.com/KKKKhazix/AIHOT/blob/cd424b0a513c7c8535b6f291b106a3086d6b75bf/docs/architecture.md)。

## 4. 接入时必须处理的实际限制

1. **模块接口不自动获得管理员权限。** `apps/api/src/app.ts` 直接注册 `m.http`，原后台通过每条路由的 `adminHandler` 保护。模块页面由 `apps/web/app/routes.ts` 单独拼入，也没有自动嵌入后台 layout。使用模块自己的鉴权 layout；每个 loader 仍检查会话，API 和下载端独立检查。不能仅凭 URL 含 `/admin` 就认为安全。
2. **公开 MCP 不适合放私人稿件。** `agent.abilities` 接入公开 Agent 出口。MVP 不使用它暴露审核、批注或文章；以后如需远程 Agent 编辑，另设计受控鉴权接口。
3. **上游“预算”主要限制请求次数。** `receipts.ts` 从 `budgets` 读取每分钟、小时、天的请求上限，不等于人民币费用硬上限。首版至少配置请求与 token 限额、记录 usage；若要货币熔断，需要另加价格表、预留额度及对账，不能只改显示名称。
4. **回执不保证外部收费请求严格只调用一次。** 上游允许对长时间 unknown 的请求自动放行一次。业务恢复应优先复用已保存响应；正式自动运行前必须评估 unknown 放行与总重试预算，记录可能重复计费。
5. **初始化脚本会开启采集与模型。** 开发环境显式关闭 `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED` 和全部外发开关，再启动服务；不能把 `init-env` 直接运行作为安全默认。
6. **“全文可读”不等于“图片和全文可转载”。** `site_fulltext`、`syndicate_fulltext` 与公开范围需保留；文章只取支持结论的证据摘录，图片另记使用依据。
7. **模块没有已交付的公众号样例。** 当前模块清单为空。模块接入虽有类型和运行插口，长文编辑器、状态机和导出均需实现与验证。

## 5. 推荐的源码管理方式

本次仅克隆参考，不把引擎复制进产品仓库。实施 P0 时采用固定版本源码导入，保留原有 monorepo 布局，歪布功能放模块，产品文档保存在 `docs/project/`。

导入前从指定 commit 导出到临时目录并生成冲突清单。保留本项目 `README.md`、`AGENTS.md`、`.gitignore`、`upstream-lock.json` 和 `docs/project/`；上游 README、AGENTS 等原件另存 `docs/upstream/AIHOT/`，合并忽略规则，保留上游许可。不要覆盖产品 `.git`，不要直接在根目录解压未审查的归档，也不要自动执行上游提供的 Agent 配置；开发规则以本仓库为准。

在本仓库建立单独的引擎导入 commit，记录导入清单、每个原始文件 hash 和保留/改动路径，再开发模块。首次正式源码导入后更新 `upstream-lock.json.integration_status`，不提前标成 integrated。

上游升级：获取旧、新两个固定版本的源码 diff → 核对模块契约及本地改动 → 在升级分支应用 → 跑回归及迁移演练 → 更新基线与变更记录。当前产品仓库与上游没有共同提交历史，不假设可以直接 `git merge upstream/main`。若未来需要长期跟踪完整上游历史，再单独决定迁移到 fork/merge 工作流。

## 6. 方案比较

| 方式 | 优点 | 代价 | 结论 |
|---|---|---|---|
| AIHOT 固定源码 + 模块 | 复用队列、数据库、模型、后台；部署进程不增加 | 需维护上游升级和少量接入改动 | MVP 推荐 |
| 独立写作服务通过 AIHOT API/MCP 取材 | 引擎隔离清晰 | 多一套鉴权、任务、存储；公开出口未必满足证据快照需求 | 未来独立扩展时再评估 |
| 重写采集与筛选 | 可自定义全部流程 | 重复工作，偏离使用 AIHOT 核心引擎的目标 | 不采用 |

以上结论来自当前源码结构与本项目单作者工作流需求，尚无压测或真实运行数据支持性能承诺。
