// 预览与复制（AC-032）：两条复制路径产出的 HTML 必须一致；390 与 1440 都不横向溢出。
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const COOKIE = process.env.SESSION_TOKEN;
const DRAFT_ID = process.env.DRAFT_ID;
if (!COOKIE || !DRAFT_ID) throw new Error("缺少 SESSION_TOKEN 或 DRAFT_ID");

const browser = await chromium.launch();
const result = {};
const failures = [];

for (const width of [390, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await context.addCookies([{ name: "aihot_admin", value: COOKIE, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${BASE}/editorial/drafts/${DRAFT_ID}/preview`, { waitUntil: "networkidle" });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const images = await page.locator("#wechat-article img").count();
  const text = await page.locator("#wechat-article").innerText();

  // 路径一：按钮写入剪贴板
  await page.locator("button", { hasText: "复制公众号正文" }).click();
  await page.waitForTimeout(300);
  const status = await page.locator("[role='status']").first().innerText().catch(() => "");
  const richFromButton = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes("text/html")) return await (await item.getType("text/html")).text();
    }
    return "";
  });

  // 路径二：选中正文后原生复制
  const richFromSelection = await page.evaluate(async () => {
    const node = document.querySelector("#wechat-article");
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("copy");
    selection.removeAllRanges();
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes("text/html")) return await (await item.getType("text/html")).text();
    }
    return "";
  });

  // 两条路径的 HTML 由不同机制序列化（按钮写 innerHTML，原生复制由浏览器重排），
  // 字节不可能相同；这里比较真正重要的东西：正文文字、图片、有没有链接。
  const summarize = async (html) =>
    page.evaluate((raw) => {
      const doc = new DOMParser().parseFromString(raw, "text/html");
      const body = doc.body;
      return {
        text: (body.textContent ?? "").replace(/\s+/gu, " ").trim(),
        images: [...body.querySelectorAll("img")].map((img) => ({ src: img.getAttribute("src") ?? "", width: img.getAttribute("data-w"), ratio: img.getAttribute("data-ratio") })),
        links: body.querySelectorAll("a").length,
      };
    }, html);

  const buttonSummary = await summarize(richFromButton);
  const selectionSummary = await summarize(richFromSelection);
  const plain = await page.evaluate(async () => navigator.clipboard.readText());

  result[width] = {
    overflow,
    images,
    hasBody: text.includes("上下文窗口扩大到"),
    hasSource: text.includes("来源：OpenAI 官方博客"),
    hasTitleInside: text.includes("公众号排版预览样本"),
    status,
    buttonLen: richFromButton.length,
    selectionLen: richFromSelection.length,
    sameText: buttonSummary.text === selectionSummary.text && buttonSummary.text.length > 0,
    buttonImages: buttonSummary.images.length,
    selectionImages: selectionSummary.images.length,
    sameImageSrc: buttonSummary.images[0]?.src === selectionSummary.images[0]?.src,
    buttonLinks: buttonSummary.links,
    selectionLinks: selectionSummary.links,
    buttonText: buttonSummary.text.slice(0, 60),
    imageWidths: await page.evaluate(() => [...document.querySelectorAll("#wechat-article img")].map((img) => Math.round(img.getBoundingClientRect().width))),
    plainHasBody: plain.includes("上下文窗口扩大到"),
  };
  if (errors.length) failures.push(`${width}px 页面错误：${errors.join("; ")}`);
  await context.close();
}

console.log(JSON.stringify(result));

await browser.close();

for (const width of [390, 1440]) {
  const item = result[width];
  if (item.overflow > 1) failures.push(`${width}px 横向溢出 ${item.overflow}px`);
  if (item.images !== 1) failures.push(`${width}px 图片数应为 1，实际 ${item.images}`);
  if (!item.hasBody) failures.push(`${width}px 正文缺失`);
  if (!item.hasSource) failures.push(`${width}px 来源文字缺失`);
  if (item.hasTitleInside) failures.push(`${width}px 标题混进了正文`);
  if (!item.sameText) failures.push(`${width}px 两条复制路径正文不一致`);
  if (item.buttonImages !== 1 || item.selectionImages !== 1) failures.push(`${width}px 两条路径图片数不一致：${item.buttonImages}/${item.selectionImages}`);
  if (!item.sameImageSrc) failures.push(`${width}px 两条路径图片地址不一致`);
  if (item.buttonLinks !== 0 || item.selectionLinks !== 0) failures.push(`${width}px 复制内容里出现了链接`);
  if (item.imageWidths.some((w) => w > width)) failures.push(`${width}px 图片宽度超出视口：${item.imageWidths}`);
}
if (!result[390].plainHasBody) failures.push("纯文字剪贴板里没有正文");
if (result[390].buttonText !== result[1440].buttonText) failures.push("两个视口复制的正文开头不同");

if (failures.length) {
  console.error("检查未通过：" + failures.join("；"));
  process.exitCode = 1;
} else {
  console.log("预览与复制检查通过");
}
