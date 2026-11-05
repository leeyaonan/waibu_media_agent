// 公众号 HTML 渲染：把正文 Markdown 变成能直接粘进微信编辑器的片段。
//
// 移植自本机技能 waibu-wechat-official-account-article/scripts/render_article.py
// （2026-11 版本，作者维护），规则逐条搬过来并用测试锁住：
// - 一级标题是发布用的元数据，不进复制正文；
// - 正文不允许超链接：公众号会吞掉或改写，来源改用普通文字归属；
// - 不支持的语法（围栏代码、表格、嵌套列表、原始 HTML）明确报错，不静默出错版；
// - 图片必须给得出真实宽高，按原始比例自适应，绝不写死宽度。
import { EditorialError } from "../../contracts/errors.ts";

export interface RenderImage {
  /** 正文里引用的素材 hash。 */
  hash: string;
  alt: string;
  mime: string;
  width: number;
  height: number;
  bytes?: Uint8Array;
}

export interface RenderOptions {
  markdown: string;
  /** 发布标题；正文里的一级标题只用来兜底，不进入复制内容。 */
  title?: string;
  /** 图片解析：给 hash，返回真实尺寸；解析不到就报错。 */
  resolveImage?: (hash: string) => Omit<RenderImage, "hash" | "alt"> | null;
  /** 图片 src 生成方式，默认转成 data URI，保证离线预览也能看到图。 */
  imageSrc?: (image: RenderImage) => string;
}

export interface RenderResult {
  title: string;
  html: string;
  plainText: string;
  images: RenderImage[];
}

const PARAGRAPH_STYLE = "text-align:left;font-size:16px;line-height:1.95;color:#343e37;margin:0 0 21px;";
const CAPTION_STYLE = "text-align:left;font-size:12px;line-height:1.8;color:#69756c;margin:8px 0 24px;";

const UNSUPPORTED = /^\s*(```|~~~|\|)|^\s{2,}(?:[-*+] |\d+\. )|^\s*<(?:section|div|table|script|iframe)\b/mu;
const LINK_PATTERN = /(?<!!)\[[^\]\n]+\]\s*(?:\([^\n]*\)|\[[^\]\n]*\])|^\s*\[[^\]\n]+\]:\s*\S+|<a\b|<(?:https?:\/\/|mailto:)[^>]+>/imu;
const IMAGE_BLOCK = /^!\[(.*?)\]\((.*?)\)$/u;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** 行内样式：粗体、斜体、行内代码。链接在这里直接拒绝。 */
function renderInline(text: string): string {
  if (LINK_PATTERN.test(text)) {
    throw new EditorialError(
      "invalid_request",
      "公众号正文不支持超链接；请把引用改成作者、文章名、日期等普通文字，完整 URL 放进素材清单",
    );
  }
  const tokens: string[] = [];
  const protect = (html: string): string => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };

  let out = text.replace(/`([^`]+)`/gu, (_, code: string) =>
    protect(`<code style="text-align:left;background:#eeeae2;">${escapeHtml(code)}</code>`),
  );
  out = escapeHtml(out);
  out = out.replace(/\*\*(.+?)\*\*/gu, '<strong style="font-weight:700;color:#173d3a;text-align:left;">$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, '<em style="text-align:left;">$1</em>');
  return out.replace(/\u0000(\d+)\u0000/gu, (_, index: string) => tokens[Number(index)]!);
}

/** 微信会把段落里的裸文本当短语处理，包一层 span 能让对齐稳定。 */
function wrapTextLeaves(fragment: string): string {
  return fragment.replace(/(<(p|h2|h3|li)\b[^>]*>)([\s\S]*?)(<\/\2>)/gu, (_match, open: string, _tag: string, inner: string, close: string) => {
    if (/<(?:img|span|strong|em|code|ul|ol|p)\b/u.test(inner)) return `${open}${inner}${close}`;
    return `${open}<span style="text-align:left;">${inner}</span>${close}`;
  });
}

function defaultImageSrc(image: RenderImage): string {
  if (image.bytes) {
    return `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
  }
  return `data:${image.mime};base64,`;
}

/** 渲染正文。任何不支持的写法都抛 EditorialError，而不是产出一份“看起来还行”的错版。 */
export function renderWechat(options: RenderOptions): RenderResult {
  const { markdown } = options;
  if (UNSUPPORTED.test(markdown)) {
    throw new EditorialError(
      "invalid_request",
      "暂不支持围栏代码块、表格、嵌套列表或原始 HTML；请先改成段落或平级列表再导出",
    );
  }

  let title = options.title?.trim() ?? "";
  const parts: string[] = [];
  const images: RenderImage[] = [];

  for (const rawBlock of markdown.trim().split(/\n\s*\n/u)) {
    const block = rawBlock.trim();
    if (block.length === 0) continue;

    // 一级标题是发布元数据：写进 title，但不进正文。
    if (block.startsWith("# ")) {
      const heading = block.slice(2).trim();
      if (!title) title = heading;
      else if (!options.title) throw new EditorialError("invalid_request", "正文只能有一个一级标题");
      continue;
    }

    const image = IMAGE_BLOCK.exec(block);
    if (image) {
      const [, alt, reference] = image;
      const hash = reference!.trim();
      const meta = options.resolveImage?.(hash);
      if (!meta) throw new EditorialError("asset_not_found", `正文引用的素材不存在：${hash.slice(0, 15)}`);
      const record: RenderImage = { hash, alt: alt ?? "", mime: meta.mime, width: meta.width, height: meta.height, bytes: meta.bytes };
      images.push(record);
      const src = (options.imageSrc ?? defaultImageSrc)(record);
      parts.push(
        `<p style="text-align:left;margin:26px 0 10px;"><img src="${escapeHtml(src)}" alt="${escapeHtml(record.alt)}" data-w="${record.width}" data-ratio="${(record.height / record.width).toFixed(4)}" data-type="${escapeHtml(record.mime.replace("image/", ""))}" style="text-align:left;display:block;width:100%;max-width:100%;height:auto;margin:0;"></p>`,
      );
      continue;
    }

    if (/^#{2,3} /u.test(block)) {
      const [mark, ...rest] = block.split(" ");
      const tag = mark!.length === 2 ? "h2" : "h3";
      parts.push(
        `<${tag} style="text-align:left;font-size:22px;line-height:1.6;color:#173d3a;margin:36px 0 20px;padding:10px 0 10px 14px;border-left:4px solid #c46a4a;">${renderInline(rest.join(" "))}</${tag}>`,
      );
      continue;
    }

    const lines = block.split("\n");
    if (lines.every((line) => line.startsWith("> "))) {
      const text = lines.map((line) => line.slice(2)).join("\n");
      parts.push(
        `<blockquote style="text-align:left;font-size:16px;line-height:1.9;margin:24px 0;padding:18px;background:#f1eee4;border-left:3px solid #c46a4a;color:#526054;">${renderInline(text).replace(/\n/gu, "<br>")}</blockquote>`,
      );
      continue;
    }

    if (lines.every((line) => /^(?:[-*+] |\d+\. )/u.test(line))) {
      const ordered = /^\d+\. /u.test(lines[0]!);
      const tag = ordered ? "ol" : "ul";
      const items = lines
        .map((line) => `<li style="text-align:left;margin:0 0 8px;"><p style="${PARAGRAPH_STYLE}margin-bottom:0;">${renderInline(line.replace(/^(?:[-*+] |\d+\. )/u, ""))}</p></li>`)
        .join("");
      parts.push(`<${tag} style="text-align:left;font-size:16px;line-height:1.95;color:#343e37;margin:0 0 21px;padding-left:24px;">${items}</${tag}>`);
      continue;
    }

    if (block.includes("![")) {
      throw new EditorialError("invalid_request", "图片需要单独成段，与前后文字之间空一行");
    }
    const isCaption = block.startsWith("*") && block.endsWith("*") && !block.startsWith("**");
    const style = isCaption ? CAPTION_STYLE : PARAGRAPH_STYLE;
    const text = isCaption ? block.slice(1, -1) : block.replace(/\n/gu, " ");
    parts.push(`<p style="${style}">${renderInline(text)}</p>`);
  }

  if (!title) throw new EditorialError("invalid_request", "缺少标题：请在正文首行写一级标题，或在导出时提供标题");

  const fragment = `<section style="text-align:left;margin:0;padding:24px 20px 36px;box-sizing:border-box;background:#fffefa;">${parts.join("")}</section>`;
  const html = wrapTextLeaves(fragment);

  return { title, html, plainText: toPlainText(markdown, title), images };
}

/**
 * 纯文字版：与 HTML 同源，去掉标题、图片转成【配图：说明】、去掉强调符号。
 * 复制到不支持富文本的地方时，内容必须和 HTML 一致。
 */
export function toPlainText(markdown: string, title?: string): string {
  const lines: string[] = [];
  for (const rawBlock of markdown.trim().split(/\n\s*\n/u)) {
    const block = rawBlock.trim();
    if (!block) continue;
    if (block.startsWith("# ")) continue;
    const image = IMAGE_BLOCK.exec(block);
    if (image) {
      lines.push(`【配图：${image[1] || "无说明"}】`);
      continue;
    }
    lines.push(
      block
        .replace(/^#{2,3} /u, "")
        .replace(/^> /gmu, "")
        .replace(/^(?:[-*+] |\d+\. )/gmu, "")
        .replace(/\*\*(.+?)\*\*/gu, "$1")
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, "$1")
        .replace(/`([^`]+)`/gu, "$1"),
    );
  }
  const body = lines.join("\n\n");
  void title;
  return body;
}

/** 安全自检：渲染结果里不允许出现脚本、iframe 或内部 claim id。 */
export function assertSafeHtml(html: string): void {
  if (/<script\b|<iframe\b|on\w+\s*=/iu.test(html)) {
    throw new EditorialError("invalid_request", "渲染结果里出现了不允许的标签或事件属性");
  }
  if (/claim_[0-9a-f]{8}|waibu_claims/iu.test(html)) {
    throw new EditorialError("invalid_request", "渲染结果泄露了内部事实编号");
  }
}
