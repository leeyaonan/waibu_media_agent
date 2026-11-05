// 规则入口。业务代码只从这里取规则与版本，不直接引用某个版本对象。
export { CURRENT_POLICY, POLICY_V1, currentPolicy, forbiddenClaimList, policyHash, policyVersion, type EditorialPolicy } from "./v1.ts";
