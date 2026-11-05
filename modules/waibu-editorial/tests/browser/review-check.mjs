// 审核页的真实浏览器检查：证据抽屉打开、摘录里的脚本不执行、未保存修改有提示。
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
page.on("dialog", async (dialog) => {
  errors.push(`意外的对话框：${dialog.message()}`);
  await dialog.dismiss();
});

const result = {};
await page.goto(`${BASE}/editorial/drafts/${DRAFT_ID}`, { waitUntil: "networkidle" });

result.title = await page.locator("h2.wb-title").innerText();
result.blocks = await page.locator(".wb-block").count();
result.claimsButtons = await page.locator(".wb-claim-btn").count();

// 打开证据抽屉
await page.locator(".wb-claim-btn").first().click();
await page.waitForTimeout(150);
const excerpt = await page.locator("blockquote[data-excerpt='true']").first().innerText();
result.excerptHasScriptText = excerpt.includes("<script>");
result.excerptHasImgText = excerpt.includes("onerror");
result.xssExecuted = await page.evaluate(() => Boolean(window.__xss));
result.scriptNodesInsideExcerpt = await page.locator("blockquote[data-excerpt='true'] script, blockquote[data-excerpt='true'] img").count();

// 未保存修改的提示
await page.locator("button", { hasText: "在下方编辑" }).first().click();
await page.locator("textarea.wb-edit").fill("改了一句话");
await page.waitForTimeout(100);
result.dirtyNote = await page.locator(".wb-note").count();
result.overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

console.log(JSON.stringify(result));

await browser.close();

const failed = [];
if (!result.title.includes("待审稿")) failed.push("标题没渲染");
if (result.blocks < 2) failed.push("正文分段没渲染");
if (result.claimsButtons < 1) failed.push("没有证据入口");
if (!result.excerptHasScriptText || !result.excerptHasImgText) failed.push("摘录没有按原文显示");
if (result.xssExecuted) failed.push("脚本被执行了");
if (result.scriptNodesInsideExcerpt > 0) failed.push("摘录里出现了真实的 script/img 节点");
if (errors.length) failed.push(`页面错误：${errors.join("; ")}`);
if (result.dirtyNote < 1) failed.push("未保存修改没有提示");
if (result.overflow > 1) failed.push("手机宽度横向溢出");

if (failed.length) {
  console.error("检查未通过：" + failed.join("；"));
  process.exitCode = 1;
} else {
  console.log("审核页检查通过");
}
