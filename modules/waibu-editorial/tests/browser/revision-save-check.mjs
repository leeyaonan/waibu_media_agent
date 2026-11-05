// 审核页的保存流程：改正文 → 保存为新版本 → 版本历史 +1、状态回自检。
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const COOKIE = process.env.SESSION_TOKEN;
const DRAFT_ID = process.env.DRAFT_ID;
if (!COOKIE || !DRAFT_ID) throw new Error("缺少 SESSION_TOKEN 或 DRAFT_ID");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addCookies([{ name: "aihot_admin", value: COOKIE, domain: "127.0.0.1", path: "/" }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const result = {};

// 两个标签页同时打开同一篇稿子：它们的 expected_lock_version 相同。
const secondPage = await context.newPage();
secondPage.on("pageerror", (error) => errors.push(`第二页：${error.message}`));
await page.goto(`${BASE}/editorial/drafts/${DRAFT_ID}`, { waitUntil: "networkidle" });
await secondPage.goto(`${BASE}/editorial/drafts/${DRAFT_ID}`, { waitUntil: "networkidle" });
result.historyBefore = await page.locator("li").filter({ hasText: /当前版本|首版/ }).count();

// 第一个标签页保存成功
await page.locator("textarea.wb-edit").fill("第一段：背景（标签页 A 改的）。\n\n第二段：价格页包含可疑脚本。");
await page.locator("button[type='submit']").click();
await page.waitForLoadState("networkidle");
await page.waitForTimeout(300);
result.message = await page.locator("[role='status'], .wb-note, .wb-ok").first().innerText().catch(() => "");
result.statusLine = await page.locator("p.wb-sub").first().innerText();
result.bodyNow = await page.locator("textarea.wb-edit").inputValue();

// 第二个标签页带着过期的版本号提交，必须被拒绝
await secondPage.locator("textarea.wb-edit").fill("第一段：背景（标签页 B 改的）。\n\n第二段：价格页包含可疑脚本。");
await secondPage.locator("button[type='submit']").click();
await secondPage.waitForLoadState("networkidle");
await secondPage.waitForTimeout(300);
result.secondMessage = await secondPage.locator("[role='status'], .wb-note, .wb-ok").first().innerText().catch(() => "");

// 回到第一页看历史，确认只多了一个版本
await page.reload({ waitUntil: "networkidle" });
result.historyAfter = await page.locator("li").filter({ hasText: /当前版本|首版/ }).count();
result.bodyStillA = await page.locator("textarea.wb-edit").inputValue();
console.log(JSON.stringify(result));

await browser.close();

const failed = [];
if (!result.message.includes("已保存")) failed.push(`保存没有成功提示：${result.message}`);
if (result.historyAfter <= result.historyBefore) failed.push("版本历史没有增加");
if (!result.statusLine.includes("checking")) failed.push(`状态没有回到自检：${result.statusLine}`);
if (!result.bodyNow.includes("标签页 A")) failed.push("A 的正文没保存");
if (!result.secondMessage.includes("刷新")) failed.push(`B 的提交没有提示冲突：${result.secondMessage}`);
if (result.historyAfter !== result.historyBefore + 1) failed.push(`版本数应为 +1，实际 ${result.historyBefore}→${result.historyAfter}`);
if (!result.bodyStillA.includes("标签页 A")) failed.push("A 的版本被 B 覆盖了");
if (errors.length) failed.push(`页面错误：${errors.join("; ")}`);

if (failed.length) {
  console.error("检查未通过：" + failed.join("；"));
  process.exitCode = 1;
} else {
  console.log("保存流程检查通过");
}
