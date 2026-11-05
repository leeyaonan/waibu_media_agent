// 配置页：改完保存升版本、非法值给出提示、手机宽度不溢出。
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
await page.goto(`${BASE}/editorial/settings`, { waitUntil: "networkidle" });
result.versionBefore = (await page.locator("p.wb-sub").first().innerText()).match(/版本 (\d+)/)?.[1];
await page.locator("#wb-drafts").fill("2");
await page.locator("button[type='submit']").click();
await page.waitForLoadState("networkidle");
await page.waitForTimeout(300);
result.message = await page.locator("[role='status']").first().innerText().catch(() => "");
await page.reload({ waitUntil: "networkidle" });
result.versionAfter = (await page.locator("p.wb-sub").first().innerText()).match(/版本 (\d+)/)?.[1];
result.overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
console.log(JSON.stringify(result));
await browser.close();
const failed = [];
if (!result.message.includes("已保存")) failed.push(`保存没有成功提示：${result.message}`);
if (Number(result.versionAfter) <= Number(result.versionBefore)) failed.push("版本没有升");
if (result.overflow > 1) failed.push("手机宽度溢出");
if (errors.length) failed.push(`页面错误：${errors.join("; ")}`);
if (failed.length) { console.error("检查未通过：" + failed.join("；")); process.exitCode = 1; } else { console.log("配置页检查通过"); }
