// 微信结构验证：用官方校验器跑真实浏览器检测，报告分三块记录。
//
// 锁定的版本：
// - npm 包 verify-article-structure@0.2.28
// - 规范仓 wechatjs/verify-article-structure-spec@6bc3ea1ac079cccd88824715c879eb637f1ab076
// 校验器本身出错（浏览器起不来、依赖缺失）不能当成“通过”——那是 validator_error，导出照样被拦。
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditorialError } from "../../contracts/errors.ts";

export const VALIDATOR_NAME = "verify-article-structure";
export const VALIDATOR_VERSION = "0.2.28";
export const SPEC_COMMIT = "6bc3ea1ac079cccd88824715c879eb637f1ab076";
export const VALIDATOR_ID = `${VALIDATOR_NAME}@${VALIDATOR_VERSION}+${SPEC_COMMIT.slice(0, 8)}`;

/** 单次检测上限：官方 CLI 冷启动 + 浏览器测量通常 5–13 秒。 */
export const VALIDATE_TIMEOUT_MS = 90_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const CLI_PATH = path.join(REPO_ROOT, "node_modules", VALIDATOR_NAME, "dist", "src", "cli.js");

export type ValidationStatus = "passed" | "failed" | "validator_error";

export interface Violation {
  rule: string;
  detail: string;
}

export interface ValidationReport {
  validator: string;
  version: string;
  spec_commit: string;
  status: ValidationStatus;
  /** 官方 CLI 的原始输出，原样保存，便于复核与申诉。 */
  raw: string;
  violations: Violation[];
  duration_ms: number;
  checked_at: string;
  /** 三块状态分开记：本地工具、官方工具、公众号后台。 */
  local: { status: string; note: string };
  official: { status: string; note: string };
  wechat_backend: { status: string; note: string };
  exit_code: number | null;
  error?: string;
}

function chromiumPath(): string | undefined {
  return process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROMIUM_PATH;
}

function parseViolations(payload: unknown): Violation[] {
  const source = (payload as { violations?: unknown }).violations;
  if (!Array.isArray(source)) return [];
  return source.map((item) => {
    if (typeof item === "string") return { rule: "unknown", detail: item };
    const record = item as Record<string, unknown>;
    return {
      rule: String(record.rule ?? record.key ?? record.type ?? "unknown"),
      detail: String(record.detail ?? record.message ?? record.desc ?? JSON.stringify(record)),
    };
  });
}

/** 跑官方校验器。任何异常都收敛成 validator_error，绝不返回 passed。 */
export async function runOfficialValidation(html: string, options: { workDir: string; timeoutMs?: number }): Promise<ValidationReport> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  const dir = path.join(options.workDir, "validation");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `article-${Date.now()}.html`);
  await writeFile(file, html, "utf8");

  const base = {
    validator: VALIDATOR_NAME,
    version: VALIDATOR_VERSION,
    spec_commit: SPEC_COMMIT,
    checked_at: checkedAt,
    local: { status: "passed", note: "结构自检：无脚本、无固定像素宽、图片带原始宽高" },
    wechat_backend: { status: "unverified", note: "公众号后台无法自动验证，需作者粘贴后目视确认" },
  } as const;

  const executable = chromiumPath();
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, "check", file, "--json"], {
      env: { ...process.env, ...(executable ? { PUPPETEER_EXECUTABLE_PATH: executable } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? VALIDATE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${String(error)}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

  const duration = Date.now() - started;
  // CLI 会把 puppeteer 的告警混进 stderr；JSON 只从 stdout 里取。
  const jsonText = result.stdout.slice(result.stdout.indexOf("{"));
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = null;
  }

  if (result.timedOut || parsed === null) {
    return {
      ...base,
      status: "validator_error",
      raw: `${result.stdout}\n${result.stderr}`.trim(),
      violations: [],
      duration_ms: duration,
      official: { status: "error", note: result.timedOut ? "校验超时" : "校验器没有返回可解析的 JSON" },
      exit_code: result.code,
      error: result.timedOut ? "timeout" : "unparsable_output",
    };
  }

  const isValid = (parsed as { isValid?: unknown }).isValid === true;
  const violations = parseViolations(parsed);
  const status: ValidationStatus = result.code === 0 && isValid ? "passed" : "failed";
  return {
    ...base,
    status,
    raw: jsonText.trim(),
    violations: status === "passed" ? [] : violations.length > 0 ? violations : [{ rule: "unknown", detail: "校验器判定不合规但未给出明细" }],
    duration_ms: duration,
    official: { status: status === "passed" ? "passed" : "failed", note: status === "passed" ? "官方校验器通过" : `官方校验器报告 ${violations.length} 项问题` },
    exit_code: result.code,
  };
}

/** 只有 passed 才允许进入正式发布包。 */
export function assertValidationPassed(report: Pick<ValidationReport, "status" | "violations">): void {
  if (report.status === "passed") return;
  if (report.status === "validator_error") {
    throw new EditorialError("validation_error", "校验器执行失败，无法确认排版合规；导出已阻止，请稍后重试");
  }
  throw new EditorialError("validation_failed", `排版校验未通过，不能导出：${report.violations.map((item) => item.rule).join("、")}`);
}
