// 公众号渲染：AC-031 的样本——链接、嵌套列表、GIF、长段落、中英混排。
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderWechat, toPlainText, assertSafeHtml } from "../backend/render/index.ts";

const GIF_META = { mime: "image/gif", width: 320, height: 180 };

test("标题不进入复制正文", () => {
  const result = renderWechat({ markdown: "# 标题在这里\n\n正文第一段。", resolveImage: () => GIF_META });
  assert.equal(result.title, "标题在这里");
  assert.ok(!result.html.includes("标题在这里"), "复制正文里不能出现标题");
  assert.ok(result.plainText.includes("正文第一段。"));
  assert.ok(!result.plainText.includes("标题在这里"));
});

test("正文有链接直接拒绝，并说明怎么改", () => {
  assert.throws(
    () => renderWechat({ markdown: "# 标题\n\n见[官方文档](https://example.com/doc)。" }),
    /不支持超链接/u,
  );
  assert.throws(() => renderWechat({ markdown: "# 标题\n\n<a href=\"https://x.com\">点这里</a>" }), /不支持超链接/u);
});

test("裸 URL 保留为普通文字，不当链接" , () => {
  const result = renderWechat({ markdown: "# 标题\n\n原文地址 https://example.com/a 供核对。" });
  assert.ok(result.html.includes("https://example.com/a"));
  assert.ok(!result.html.includes("<a "), "不能出现 a 标签");
});

test("嵌套列表明确报错", () => {
  assert.throws(() => renderWechat({ markdown: "# 标题\n\n- 一级\n  - 二级" }), /嵌套列表/u);
});

test("围栏代码与表格明确报错", () => {
  assert.throws(() => renderWechat({ markdown: "# 标题\n\n```js\nconst a = 1\n```" }), /围栏代码/u);
  assert.throws(() => renderWechat({ markdown: "# 标题\n\n| a | b |\n| - | - |" }), /表格|围栏/u);
});

test("GIF 按原始尺寸自适应，不写死宽度", () => {
  const result = renderWechat({
    markdown: "# 标题\n\n![演示动图](sha256:abc)\n\n图注在这里。",
    resolveImage: () => GIF_META,
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0]!.width, 320);
  assert.match(result.html, /width:100%;max-width:100%;height:auto/u);
  assert.match(result.html, /data-w="320"/u);
  assert.match(result.html, /data-ratio="0\.5625"/u);
  assert.match(result.html, /data-type="gif"/u);
  assert.ok(!/width:\s*\d+px/u.test(result.html), "不能出现固定像素宽度");
});

test("图片找不到就报错，不产出一张空图", () => {
  assert.throws(() => renderWechat({ markdown: "# 标题\n\n![图](sha256:missing)", resolveImage: () => null }), /素材不存在/u);
});

test("图片必须单独成段", () => {
  assert.throws(() => renderWechat({ markdown: "# 标题\n\n文字![图](sha256:abc)文字", resolveImage: () => GIF_META }), /单独成段/u);
});

test("长段落与中英混排原样保留", () => {
  const paragraph = "OpenAI 在 2026 年发布了 GPT-5.2，上下文窗口扩大到 1M tokens。".repeat(6);
  const result = renderWechat({ markdown: `# 标题\n\n${paragraph}` });
  assert.ok(result.html.includes(paragraph), "长段落不能被截断");
  assert.ok(result.plainText.includes(paragraph));
});

test("粗体、行内代码与引用都能渲染", () => {
  const result = renderWechat({ markdown: "# 标题\n\n这里有 **重点** 和 `code`。\n\n> 引用一句。" });
  assert.match(result.html, /<strong[^>]*>重点<\/strong>/u);
  assert.match(result.html, /<code[^>]*>code<\/code>/u);
  assert.match(result.html, /<blockquote/u);
});

test("渲染结果没有脚本与内部事实编号", () => {
  const result = renderWechat({ markdown: "# 标题\n\n一段正文。" });
  assertSafeHtml(result.html);
  assert.throws(() => assertSafeHtml('<script>alert(1)</script>'), /不允许的标签/u);
  assert.throws(() => assertSafeHtml('<p onclick="x()">a</p>'), /不允许的标签/u);
  assert.throws(() => assertSafeHtml("<p>claim_ab12cd34</p>"), /内部事实编号/u);
});

test("纯文字与 HTML 内容一致：段落数与文字都对得上", () => {
  const markdown = "# 标题\n\n第一段。\n\n## 小标题\n\n第二段 **加粗**。\n\n- 列表一\n- 列表二\n\n![图](sha256:abc)\n\n> 引用。";
  const html = renderWechat({ markdown, resolveImage: () => GIF_META });
  const plain = toPlainText(markdown, html.title);
  for (const piece of ["第一段。", "小标题", "第二段 加粗。", "列表一", "列表二", "引用。", "【配图：图】"]) {
    assert.ok(plain.includes(piece), `纯文字缺内容：${piece}`);
  }
  assert.ok(!plain.includes("**"), "纯文字里不应残留 Markdown 符号");
  assert.ok(!plain.includes("# "), "纯文字里不应有标题标记");
});

test("同一份 Markdown 渲染两次结果相同", () => {
  const markdown = "# 标题\n\n正文。\n\n![图](sha256:abc)";
  const first = renderWechat({ markdown, resolveImage: () => GIF_META });
  const second = renderWechat({ markdown, resolveImage: () => GIF_META });
  assert.equal(first.html, second.html);
});
