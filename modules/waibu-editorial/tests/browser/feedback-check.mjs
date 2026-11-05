// 提意见的页面流程：提交后意见出现在列表里，稿件进入改稿中。
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

await page.goto(`${BASE}/editorial/drafts/${DRAFT_ID}`, { waitUntil: "networkidle" });
result.feedbackBefore = await page.locator("aside li").count();

const text = `意见 ${Date.now()}`;
await page.locator("textarea#wb-feedback").fill(text);
await page.locator("button", { hasText: "提交意见并请求改稿" }).click();
await page.waitForLoadState("networkidle");
await page.waitForTimeout(400);

result.message = await page.locator("[role='status'], .wb-note, .wb-ok").first().innerText().catch(() => "");
result.feedbackAfter = await page.locator("aside li").count();
result.newFeedbackVisible = await page.locator(`aside li:has-text("${text}")`).count();
result.statusLine = await page.locator("p.wb-sub").first().innerText();
console.log(JSON.stringify(result));

await browser.close();

const failed = [];
if (!result.message.includes("意见已提交")) failed.push(`没有提交成功提示：${result.message}`);
if (result.newFeedbackVisible < 1) failed.push("新意见没有出现在列表里");
if (!result.statusLine.includes("revising")) failed.push(`稿件状态没有进入改稿中：${result.statusLine}`);
if (errors.length) failed.push(`页面错误：${errors.join("; ")}`);

if (failed.length) {
  console.error("检查未通过：" + failed.join("；"));
  process.exitCode = 1;
} else {
  console.log("意见提交检查通过");
}
