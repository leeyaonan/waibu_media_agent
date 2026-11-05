// 稿件状态与任务状态的唯一真源。业务代码、数据库约束和页面都从这里取枚举，不在别处重复字面量。
//
// 两套状态分开：文章状态记录稿子走到哪一步，任务状态记录一次运行的结果。网络故障、模型超时是任务失败，
// 不能把稿子改成“被驳回”。

export const ARTICLE_STATES = [
  "drafting", // 起草中：worker 正在生成结构化初稿
  "checking", // 自检中：确定性检查 + 模型核查
  "in_review", // 待作者审核：唯一可以批准的状态
  "revising", // 按意见改稿中
  "approved", // 作者已批准某个 revision
  "exported", // 已为当前批准版本生成发布包
  "published", // 作者登记了发布事实；终态，后续修改走新流程
  "on_hold", // 暂停：缺作者材料、关键事实待核实或来源失效
  "rejected", // 作者放弃，可带原因
] as const;

export type ArticleState = (typeof ARTICLE_STATES)[number];

export const TASK_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "paused_budget", // 预算或次数上限，等人工放行
  "waiting_input", // 缺作者材料，等补充
  "cancelled",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** 谁能发起状态迁移：system 是 worker/服务端，human 是作者在私人界面上的操作。 */
export type Actor = "system" | "human";

interface Transition {
  to: ArticleState;
  by: Actor;
  why: string;
}

/**
 * 状态迁移表。没有列出的迁移一律非法：
 * - 批准只能 human 发起，服务端不能自己把稿子变成 approved（见 AGENTS.md 不可变条件）；
 * - published 是终态，已发布文章的修改必须开新的修订流程，不能覆盖历史发布版本；
 * - approved/exported 之后内容变化必须先回到 checking，并清除当前批准指针。
 */
const TRANSITIONS: Record<ArticleState, readonly Transition[]> = {
  drafting: [{ to: "checking", by: "system", why: "初稿结构已落库" }],
  checking: [
    { to: "in_review", by: "system", why: "自检无阻断项" },
    { to: "on_hold", by: "system", why: "有限修复后仍有阻断项，转人工处理" },
  ],
  in_review: [
    { to: "revising", by: "human", why: "作者提交批注并请求改稿" },
    { to: "checking", by: "human", why: "作者直接编辑产生新版本，重新自检" },
    { to: "approved", by: "human", why: "作者批准当前 revision" },
    { to: "rejected", by: "human", why: "作者放弃该稿" },
    { to: "on_hold", by: "human", why: "作者认为材料不足，暂时搁置" },
  ],
  revising: [
    { to: "checking", by: "system", why: "改稿产生新 revision" },
    { to: "on_hold", by: "system", why: "改稿所需材料不可用" },
  ],
  approved: [
    { to: "exported", by: "system", why: "发布包生成并校验通过" },
    { to: "checking", by: "human", why: "批准后又编辑，旧批准作废" },
    { to: "on_hold", by: "human", why: "来源撤回或事实失效，撤销批准" },
    { to: "rejected", by: "human", why: "作者撤回批准并放弃" },
  ],
  exported: [
    { to: "published", by: "human", why: "作者登记发布事实" },
    { to: "checking", by: "human", why: "导出后编辑，旧包不再是当前有效包" },
    { to: "on_hold", by: "human", why: "来源撤回或事实失效" },
  ],
  published: [],
  on_hold: [
    { to: "drafting", by: "human", why: "材料补齐后重跑起草" },
    { to: "checking", by: "human", why: "补齐材料后在现有版本上重新自检" },
    { to: "in_review", by: "human", why: "补齐材料后直接回到审核" },
    { to: "rejected", by: "human", why: "作者放弃" },
  ],
  rejected: [{ to: "drafting", by: "human", why: "改用新角度重新开始，旧稿保留作审计" }],
};

export function transitionsFrom(state: ArticleState): readonly Transition[] {
  return TRANSITIONS[state];
}

export function canTransition(from: ArticleState, to: ArticleState, by: Actor): boolean {
  return TRANSITIONS[from].some((t) => t.to === to && t.by === by);
}

/** 只有待审核状态可以产生批准记录。 */
export function canApprove(state: ArticleState): boolean {
  return state === "in_review";
}

/** 页面是否允许作者编辑正文：已发布稿不再编辑。 */
export function canEditContent(state: ArticleState): boolean {
  return state !== "published";
}

/** 该状态下是否存在“当前有效批准”。 */
export function holdsApproval(state: ArticleState): boolean {
  return state === "approved" || state === "exported" || state === "published";
}

/**
 * 内容变化（正文、标题、摘要、封面、图注、素材）之后的状态：
 * 有批准的发回 checking 并清除批准指针，没有批准的留在原流程。
 */
export function stateAfterContentChange(state: ArticleState): ArticleState {
  if (state === "published") return "published"; // 已发布稿的修改走新流程，本记录不动
  if (state === "approved" || state === "exported") return "checking";
  if (state === "in_review") return "checking";
  return state;
}

/** 任务是否还可以被恢复执行：失败、排队与运行中都可以重试，成功和取消不重试。 */
export function taskRetryable(state: TaskState): boolean {
  return state === "queued" || state === "running" || state === "failed" || state === "paused_budget" || state === "waiting_input";
}
