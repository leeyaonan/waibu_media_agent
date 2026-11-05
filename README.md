# waibu_media_agent

为「AI歪布抠腚」建设的公众号文章 Agent：每天自动发现信息、选择值得写的题材、整理证据并起草文章；作者审核、提出修改意见，审核通过后导出发布包，由作者手动发布到公众号。

**当前状态：开发中。** 引擎（AIHOT `cd424b0`）已导入并通过本机基线检查，共享契约 v1 已冻结；
`modules/waibu-editorial/` 只有契约，还没有采集、选题、起草、审核与导出功能。进度以
[功能实施计划 Excel](outputs/2026-11-05-plan/waibu_media_agent_功能实施计划.xlsx) 的任务表为准。

## 方案选择

以 [AIHOT](https://github.com/KKKKhazix/AIHOT) 为采集、筛选、事件聚合及任务运行引擎，后续引入固定版本源码，在 `modules/waibu-editorial/` 中增加公众号长文生产、审核、改稿和导出功能。保留上游的 TypeScript、PostgreSQL、pg-boss 和 Web/API/worker 结构。

AIHOT 的日报和摘要是写作素材，公众号文章另有自己的证据、版本和审核记录。首版提供私人编辑工作台，不建设公开资讯门户。

## 实施计划

[下载功能实施计划 Excel](outputs/2026-11-05-plan/waibu_media_agent_功能实施计划.xlsx)：44 个功能点，包含依赖、并行文件范围、互斥锁、验收场景和 Agent 迭代协议。40 项覆盖首版与试运行，4 项后续扩展。Excel 是任务计划与进度的主记录，由协调 Agent 单写，执行 Agent 在独立分支交付结果。

## 阅读顺序

1. [Agent 开发规范](AGENTS.md)
2. [上游调研与接入依据](docs/project/01-aihot-research.md)
3. [产品与技术设计](docs/project/02-design.md)
4. [分阶段实施与验收](docs/project/03-implementation.md)
5. [公众号编辑规范](docs/project/04-editorial-policy.md)
6. [交给 OpenCode / DSH 的任务说明](docs/project/05-agent-handoff.md)
7. [共享契约 v1](docs/project/06-contracts-v1.md)
8. [本机开发与自测](docs/project/dev-setup.md)

## 本地工作区

```text
waibu_media_agent_workspace/
├── AGENTS.md                  # 工作区导航
├── references/AIHOT/          # 独立上游仓库，已拉取，仅供参考
└── waibu_media_agent/         # 本仓库
    ├── AGENTS.md
    ├── README.md
    ├── upstream-lock.json     # 调研基线；不表示已集成运行
    ├── docs/project/
    └── outputs/2026-11-05-plan/ # 功能实施计划 Excel
```

上游参考固定于 `cd424b0a513c7c8535b6f291b106a3086d6b75bf`，详见 [基线记录](upstream-lock.json)。其他机器可从上游拉取该 commit，不依赖这个工作区的绝对路径。

首版建议每天北京时间 08:30 生成最多 1 篇待审稿，并展示最多 5 个候选选题；没有合格证据时允许当天不出稿。这些是可调整的设计默认值，尚未创建任何实际自动任务。
