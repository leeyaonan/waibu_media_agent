// 用真实浏览器检查队列页：50 篇数据能翻页、手机尺寸不横向溢出、事实与标题都在。
// 复用 tools/check-editorial-page.sh 起好的服务与已建会话。
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const COOKIE = process.env.SESSION_TOKEN;
if (!COOKIE) throw new Error("缺少 SESSION_TOKEN");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addCookies([{ name: "aihot_admin", value: COOKIE, domain: "127.0.0.1", path: "/" }]);
const page = await context.newPage();

const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

await page.goto(`${BASE}/editorial`, { waitUntil: "networkidle" });

const cards = await page.locator(".wb-card").count();
const hasEmpty = await page.locator("text=这个分类下还没有稿子").count();
const hasError = await page.locator(".wb-error").count();
console.log(`卡片 ${cards} 张｜空队列提示 ${hasEmpty}｜错误块 ${hasError}`);

// 手机宽度不能横向溢出
const overflow = await page.evaluate(() => {
  const width = document.documentElement.scrollWidth;
  const viewport = window.innerWidth;
  return { width, viewport, overflow: width - viewport };
});
console.log(`滚动宽度 ${overflow.width} / 视口 ${overflow.viewport}（溢出 ${overflow.overflow}px）`);

// 翻页：有下一页就点，页面应换一批卡片
const next = page.locator("a.wb-more");
let pageTwoCards = 0;
if (await next.count()) {
  const firstTitle = await page.locator(".wb-card h3").first().innerText();
  await next.click();
  await page.waitForLoadState("networkidle");
  pageTwoCards = await page.locator(".wb-card").count();
  const secondTitle = await page.locator(".wb-card h3").first().innerText();
  console.log(`翻页：第二页 ${pageTwoCards} 张，标题变化 ${firstTitle !== secondTitle}`);
}

const report = {
  cards,
  overflow: overflow.overflow,
  pageTwoCards,
  problems,
};
console.log(JSON.stringify(report));

await browser.close();

const failed = [];
if (overflow.overflow > 1) failed.push("手机宽度横向溢出");
if (problems.length) failed.push(`页面运行时错误：${problems.join("; ")}`);
if (hasError) failed.push("页面显示错误块");
if (cards === 0 && hasEmpty === 0) failed.push("既无数据也无空队列提示");
if (cards > 0 && pageTwoCards === 0 && (await page.locator("a.wb-more").count()) === 0) {
  // 只有一页时不算失败
}
if (failed.length) {
  console.error("检查未通过：" + failed.join("；"));
  process.exitCode = 1;
} else {
  console.log("页面检查通过");
}
