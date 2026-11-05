// 模型配置的指纹与展示名。阶段键要能区分“换了模型”，但不能把密钥或完整地址写进库。
import { inputHash } from "../../contracts/content.ts";

/** 当前默认模型名；没配时返回空串，调用方据此判断能不能发请求。 */
export function modelName(): string {
  return process.env.LLM_MODEL ?? "";
}

/**
 * 模型配置指纹：地址、模型名、额外请求参数。不含密钥，
 * 但换了地址（例如换成另一家供应商）也会换指纹，避免复用旧结果。
 */
export function modelConfigHash(): string {
  return inputHash({
    base_url: process.env.LLM_BASE_URL ?? "",
    model: process.env.LLM_MODEL ?? "",
    extra: process.env.LLM_EXTRA_JSON ?? "",
    vision: process.env.LLM_VISION ?? "",
  });
}

/** 模型没配好时给出可执行的提示，而不是让请求以一个空模型名发出去。 */
export function assertModelConfigured(): void {
  if (!process.env.LLM_BASE_URL || !process.env.LLM_MODEL) {
    throw new Error("还没有配置模型：需要 LLM_BASE_URL 与 LLM_MODEL（测试里指向本地 stub）");
  }
}
