// 批准与导出的页面流程：未批准没有导出入口、批准后能生成发布包、绕过按钮直接请求仍被拒。
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

// 页面上的导出入口：未批准时不应出现
result.exportButtonsBefore = await page.locator("button", { hasText: "生成发布包" }).count();
result.approveButtons = await page.locator("button", { hasText: "批准这一版" }).count();

// 绕过按钮直接请求导出：带上页面里的 CSRF（模拟"按钮被禁用但手工发请求"），
// 此时必须仍然因为"没有有效批准"而失败，而不是被 CSRF 顺手挡掉。
const csrf = await page.locator("input[name='csrf']").first().inputValue();
result.directExport = await page.evaluate(async (token) => {
  const response = await fetch(`/api/admin/editorial/drafts/${location.pathname.split("/").pop()}/exports`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": token },
    body: JSON.stringify({ expected_revision_id: "00000000-0000-4000-8000-000000000000", expected_approval_id: "00000000-0000-4000-8000-000000000001" }),
  });
  return { status: response.status, body: await response.text() };
}, csrf);

// 通过按钮批准
if (result.approveButtons > 0) {
  await page.locator("button", { hasText: "批准这一版" }).click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  result.afterApproveMessage = await page.locator("[role='status'], .wb-note, .wb-ok").first().innerText().catch(() => "");
  result.exportButtonsAfter = await page.locator("button", { hasText: "生成发布包" }).count();
  result.approvedText = await page.locator("text=/已于.*批准/").count();
}

// 批准后再改正文：批准应当被取消，导出入口消失
if (result.exportButtonsAfter > 0) {
  await page.locator("textarea.wb-edit").fill("批准之后又改了一句。\n\n第二段。");
  await page.locator("button[type='submit']", { hasText: "保存为新版本" }).click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  result.approvalAfterEdit = await page.locator("text=尚未批准").count();
  result.exportButtonsAfterEdit = await page.locator("button", { hasText: "生成发布包" }).count();
}

console.log(JSON.stringify(result));
await browser.close();

const failed = [];
if (result.exportButtonsBefore !== 0) failed.push("未批准时页面上出现了导出入口");
if (result.directExport.status !== 409) failed.push(`绕过按钮的导出没有被批准门禁拒：${result.directExport.status}`);
if (!result.directExport.body.includes("approval_required")) failed.push(`拒绝原因不是缺少有效批准：${result.directExport.body.slice(0, 120)}`);
if (!result.afterApproveMessage.includes("已批准")) failed.push(`批准没有成功提示：${result.afterApproveMessage}`);
if (result.exportButtonsAfter !== 1) failed.push("批准后没有出现导出入口");
if (result.approvalAfterEdit !== 1) failed.push("批准后修改没有取消已批准显示");
if (result.exportButtonsAfterEdit !== 0) failed.push("批准被取消后导出入口仍然可见");
if (errors.length) failed.push(`页面错误：${errors.join("; ")}`);

if (failed.length) {
  console.error("检查未通过：" + failed.join("；"));
  process.exitCode = 1;
} else {
  console.log("批准与导出检查通过");
}
