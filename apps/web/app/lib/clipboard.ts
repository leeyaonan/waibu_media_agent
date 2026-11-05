/**
 * Copies text; in-app browsers without the async clipboard (WeChat and the like) fall back to a selection
 * copy. Rejects when neither copies.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const copied = document.execCommand("copy");
    ta.remove();
    if (!copied) throw new Error("copy failed");
  }
}

/**
 * Copies rich HTML (with a plain-text fallback for the same content); in-app browsers without the async
 * clipboard get a selection copy of the same markup. Used by pages that paste into an editor, where the
 * formatting is the point — copyText would drop it.
 */
export async function copyRich(html: string, text: string): Promise<void> {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
  } catch {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    holder.setAttribute("aria-hidden", "true");
    holder.style.cssText = "position:fixed;left:-9999px;top:0;white-space:pre-wrap;";
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const copied = document.execCommand("copy");
    selection?.removeAllRanges();
    holder.remove();
    if (!copied) throw new Error("copy failed");
  }
}
