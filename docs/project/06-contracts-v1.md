# 共享契约 v1（F02 冻结）

版本：`waibu-editorial/v1`，2026-11-05。代码在 `modules/waibu-editorial/contracts/`，自检在
`modules/waibu-editorial/tests/contracts.standalone.test.ts`。后续任务只使用这里的枚举与 schema；
改契约必须先出兼容变更并同步所有消费者，不能各自猜字段。

## 1. 两套状态

文章状态与任务状态分开：网络故障是任务失败，不能把稿子写成"被驳回"。

```text
drafting → checking → in_review ─┬→ revising → checking → in_review
                                 ├→ approved → exported → published（终态）
                                 ├→ on_hold（材料不足/来源失效）
                                 └→ rejected
```

硬规则（由 `states.ts` 的迁移表保证，测试覆盖）：

| 规则 | 实现 |
|---|---|
| 批准只能人发起 | `in_review → approved` 仅 `by: "human"`，服务端迁移不合法 |
| 已发布是终态 | `published` 无出边，改稿走新修订流程 |
| 内容变化使批准失效 | `approved`/`exported`/`in_review` 变更内容后回 `checking`，清空 `approved_revision_id` |
| 任务可重试范围 | `queued`/`running`/`failed`/`paused_budget`/`waiting_input`；成功与取消不重试 |

## 2. 内容 hash

批准绑定 `revision_id + content_hash`，所以算法一旦发布不能改；新增字段只能追加并升版本号。

- 覆盖：标题、摘要、正文、封面素材 hash、每段图注、正文引用素材 hash 集合；
- 规范化：正文统一 `\n`、文本 NFC；图注按键排序、素材去重后排序、对象键排序；
- 输出：`sha256:<64 位小写十六进制>`；
- 写入前用 `hashOfRevisionRow()` 复算，库里 hash 与内容不一致视为数据损坏；
- 发布包 manifest 用 `manifestHash()`，对文件顺序不敏感。

## 3. 数据实体

13 张表，统一 `waibu_` 前缀，物理建表由 F04 负责，本契约定义逻辑形状（字段名与 SQL 列一致）：

`waibu_runs`、`waibu_steps`、`waibu_topics`、`waibu_evidence`、`waibu_claims`、`waibu_drafts`、
`waibu_revisions`、`waibu_revision_claims`、`waibu_feedback`、`waibu_approvals`、`waibu_assets`、
`waibu_exports`、`waibu_publications`。

关键不变量：

- `waibu_revisions` 内容不可变，改动产生新行；`parent_id` 串成链；
- `waibu_drafts.current_revision_id` 与 `approved_revision_id` 分离，`lock_version` 做乐观并发；
- `waibu_approvals.content_hash` 必须等于对应 revision 的 `content_hash`；
- `waibu_revision_claims` 把正文段落映射到证据，复制正文里不出现内部 ID。

## 4. API

前缀 `/api/admin/editorial`，全部要求管理员会话；写请求另要 CSRF。写命令带
`expected_revision_id` / `expected_lock_version`，重复提交带 `Idempotency-Key`。API 只落库入队，
返回 `202 + job_id`，不同步等模型。

| 方法 | 路径 | 请求 schema |
|---|---|---|
| GET | `/topics`、`/drafts`、`/runs/:id` | `listQuerySchema` |
| POST | `/runs` | `createRunRequestSchema`（`rerun` / `recover` 两种命令） |
| GET | `/drafts/:id`、`/drafts/:id/revisions` | — |
| POST | `/drafts/:id/revisions` | `saveRevisionRequestSchema` |
| POST | `/drafts/:id/feedback` | `feedbackRequestSchema` |
| POST | `/drafts/:id/approvals` | `approveRequestSchema` |
| POST | `/drafts/:id/reject` | `rejectRequestSchema` |
| POST | `/drafts/:id/exports` | `exportRequestSchema` |
| POST | `/drafts/:id/publications` | `publicationRequestSchema` |
| GET | `/exports/:id/download`、`/assets/:id` | —（`no-store`，鉴权） |

错误码（`errors.ts`，与上游 `sendProblem` 输出同形）：

| code | HTTP | 何时 |
|---|---|---|
| `unauthorized` | 401 | 没有管理员会话 |
| `forbidden` | 403 | CSRF 缺失或过期 |
| `invalid_request` | 400 | zod 校验失败 |
| `conflict_version` | 409 | 版本不一致，页面应刷新而不是重试 |
| `conflict_state` | 409 | 状态机不允许的迁移 |
| `approval_required` / `approval_stale` | 409 | 无有效批准 / 批准已被撤销 |
| `check_blocked` | 422 | 自检阻断项未解决，不能批准或导出 |
| `evidence_invalid` | 409 | 关键来源撤回或失效 |
| `budget_paused` | 429 | 次数或 token 上限 |
| `idempotency_conflict` | 409 | 同一个 Idempotency-Key 配了不同请求体 |

## 5. 队列与阶段键

两个模块队列：`waibu.pipeline`（阶段执行）与 `waibu.export`（发布包生成）。

阶段键 `stageInputHash()` 覆盖：管线版本、阶段、策略版本、提示词版本、模型配置 hash、证据 hash 集合、
基准版本、改稿意见集合。任何一项变化都产生新键；证据与意见集合对顺序不敏感。

预算默认值（`pipeline.ts`，均为可调配置）：每日 1 篇待审稿、每日 5 个候选、待审积压 3 篇暂停、
自检修复最多 2 轮、单阶段最多 3 次尝试、单稿 60k 输出 token、单次运行 45 分钟、每日 08:30（Asia/Shanghai）。

**货币预算硬熔断不在本版**（F44，LATER）。本版只有次数与 token 限额，不能对外声称控住了费用。

## 6. 有意留给后续的

- 提示词内容与策略版本号：F07；
- 表结构与索引：F04；本文件只定字段形状；
- 队列注册与重试策略：F05；
- 页面路由与鉴权装配：F22、F37；
- 公众号 HTML 校验器版本：F33 查证后锁定。
