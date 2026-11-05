import { chromium } from "playwright";
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const COOKIE = process.env.SESSION_TOKEN;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addCookies([{ name: "aihot_admin", value: COOKIE, domain: "127.0.0.1", path: "/" }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const result = {};
await page.goto(`${BASE}/editorial/runs`, { waitUntil: "networkidle" });
result.hasPanel = await page.locator("text=运行详情").count();
result.runLinks = await page.locator(".wb-run a").count();
result.overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
if (result.runLinks > 0) {
  await page.locator(".wb-run a").first().click();
  // 客户端导航不会触发整页加载，等面板里真的出现表格。
  await page.waitForSelector(".wb-panel table", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(200);
  result.detailTable = await page.locator(".wb-panel table tr").count();
  result.panelText = await page.locator(".wb-panel").innerText();
}
console.log(JSON.stringify(result));
await browser.close();
const failed = [];
if (result.hasPanel < 1) failed.push("没有运行面板");
if (result.overflow > 1) failed.push("手机宽度溢出");
if (errors.length) failed.push(`页面错误：${errors.join("; ")}`);
if (result.runLinks > 0 && result.detailTable < 2) failed.push("详情表没有内容");
if (failed.length) { console.error("检查未通过：" + failed.join("；")); process.exitCode = 1; } else { console.log("运行面板检查通过"); }
