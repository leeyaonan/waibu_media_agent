// 账号规则 v1。规则随仓库走，不在运行时读作者电脑上的技能目录：
// 服务器上没有作者电脑上的技能目录，任何“本机路径”依赖都会在部署后失效。
//
// 改规则要升 version，因为 policy_version 会写进每个 revision 和阶段键：
// 旧稿保留它当时用的版本，新稿用新版本，两者的出处不会混。
import { inputHash } from "../contracts/content.ts";

export interface EditorialPolicy {
  version: string;
  account: {
    name: string;
    /** 读者是谁，决定解释深度和例子选择。 */
    audience: string;
    /** 账号的主线方向。 */
    focus: string[];
  };
  scope: {
    /** 值得写的题材。 */
    preferred: string[];
    /** 明确不写的内容。 */
    excluded: string[];
  };
  length: { min: number; max: number };
  evidence: {
    /** 版本、价格、限制、发布状态必须用当次一手材料。 */
    fresh_sources_required: string[];
    /** 只有标题或摘要的源不能支撑全文细节。 */
    headline_only_insufficient: true;
    /** 互相转载不算多方独立验证。 */
    syndication_not_independent: true;
    /** 冲突的事实标 disputed，不猜。 */
    conflicting_facts: "disputed";
  };
  /** 不得出现的表述：没有作者材料时不能编经历、实测或态度。 */
  forbidden_claims: string[];
  voice: {
    rules: string[];
    /** 中文与相邻英文/数字之间的排版约定。 */
    spacing: string;
  };
  assets: { cover: { width: number; height: number } };
  export: { external_links_in_body: false; sources_in_separate_list: true };
}

export const POLICY_V1: EditorialPolicy = {
  version: "2026-11-05.1",
  account: {
    name: "AI歪布抠腚",
    audience: "想用 AI 动手做东西的开发者、产品人和创作者",
    focus: ["AI 编程", "产品与工具变化", "真实实践", "人与 AI 协作"],
  },
  scope: {
    preferred: [
      "能落到一个读者问题的工具更新与产品变化",
      "有官方说明或源码可核对的版本、价格、限制变化",
      "可复现的工作流与配置方法",
    ],
    excluded: ["纯融资与人事消息", "没有一手材料的产品传闻", "需要作者亲历但作者没给材料的内容"],
  },
  length: { min: 1500, max: 3000 },
  evidence: {
    fresh_sources_required: ["版本号", "价格", "使用限制", "发布与下线状态", "“首次”“最高”等强结论"],
    headline_only_insufficient: true,
    syndication_not_independent: true,
    conflicting_facts: "disputed",
  },
  forbidden_claims: [
    "我实测过（没有作者材料时）",
    "我花了几小时（没有作者材料时）",
    "一次就成功（没有作者材料时）",
    "把计划写成已经完成的体验",
    "替作者表达喜好、推荐或长期立场",
  ],
  voice: {
    rules: [
      "直接交代发生了什么、谁做的、影响是什么",
      "少用无对象的“别误会”“我不是在吹”",
      "保留有依据的比较，减少“不是 A 而是 B”与三连排比",
      "用动作和具体结果替代空泛形容词",
      "段落一般 1～3 句，小标题服务结构，不套同一模板",
    ],
    spacing: "面向读者的中文与相邻英文/数字之间不加排版空格；英文词组、代码和网址内部保留必要空格",
  },
  assets: { cover: { width: 1175, height: 500 } },
  export: { external_links_in_body: false, sources_in_separate_list: true },
};

/** 当前生效的规则。要改规则就新增版本对象并在这里切换，不要就地修改历史版本。 */
export const CURRENT_POLICY: EditorialPolicy = POLICY_V1;

export function currentPolicy(): EditorialPolicy {
  return CURRENT_POLICY;
}

export function policyVersion(): string {
  return CURRENT_POLICY.version;
}

/** 规则指纹：写进阶段键，规则一变，同样的输入也算新工作。 */
export function policyHash(policy: EditorialPolicy = CURRENT_POLICY): string {
  return inputHash(policy);
}

/** 从冻结的规则里取该账号的“不能写什么”，提示词与自检共用同一份清单。 */
export function forbiddenClaimList(policy: EditorialPolicy = CURRENT_POLICY): readonly string[] {
  return policy.forbidden_claims;
}
