// 预览与复制：同一份渲染结果，两条路径都能复制出一样的富文本 HTML。
//
// 路径一：按钮通过 Clipboard API 写入 text/html；
// 路径二：选中正文后走浏览器原生复制（老浏览器与内嵌浏览器只认这条）。
// 两条路径的 HTML 必须一致，所以都从同一个 DOM 节点读，不各拼一份。
import { useRef, useState, type ReactNode } from "react";
import { Link, redirect, useLoaderData, useParams } from "react-router";
import { ApiError, editorialGet, editorialSignedIn, loginRedirect } from "./api.ts";
import { copyRich, copyText } from "@aihot/web/lib/clipboard";

interface RenderPayload {
  title: string;
  html: string;
  plain_text: string;
  images: Array<{ hash: string; alt: string; width: number; height: number; mime: string; url: string | null }>;
}

type LoaderData = { ok: true; data: RenderPayload } | { ok: false; message: string };

export async function loader({ request, params }: { request: Request; params: Record<string, string | undefined> }): Promise<LoaderData> {
  const url = new URL(request.url);
  if (!(await editorialSignedIn(request))) throw redirect(loginRedirect(url));
  try {
    const data = await editorialGet<RenderPayload>({ request, path: `/drafts/${params.draftId ?? ""}/render` });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? `${error.message}（${error.code}）` : "连不上 api 进程" };
  }
}

export const headers = () => ({ "Cache-Control": "no-store" });

const styles = `
.wb-preview{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:20px;align-items:start}
@media (max-width:820px){.wb-preview{grid-template-columns:minmax(0,1fr)}}
.wb-article{border:1px solid #e6e6e6;border-radius:var(--radius-card);background:#fffefa;overflow:hidden}
.wb-article img{max-width:100%;height:auto;display:block}
.wb-tools{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.wb-tools button{font:inherit;padding:8px 14px;border-radius:var(--radius-control);border:1px solid #ccc;background:#fff;cursor:pointer}
.wb-tools button[data-primary="true"]{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
.wb-panel{border:1px solid #e6e6e6;border-radius:var(--radius-card);padding:14px;background:#fff}
.wb-panel h2{font-size:15px;margin:0 0 8px}
.wb-ok{font-size:13px;color:#1d6b34}
.wb-note{font-size:13px;color:#8a4b00}
.wb-asset{display:flex;gap:10px;align-items:center;font-size:13px;padding:8px 0;border-top:1px solid #f0f0f0}
.wb-asset img{width:56px;height:38px;object-fit:cover;border-radius:var(--radius-control)}
`;

export default function EditorialPreview(): ReactNode {
  const data = useLoaderData() as LoaderData;
  const params = useParams();
  const articleRef = useRef<HTMLElement>(null);
  const [status, setStatus] = useState("");

  if (!data.ok) {
    return (
      <div className="wb-error" role="alert">
        <strong>预览加载失败</strong>
        <p>{data.message}</p>
        <Link to="/editorial">← 回队列</Link>
      </div>
    );
  }

  const { html, plain_text, images, title } = data.data;

  async function copyArticle(): Promise<void> {
    const node = articleRef.current;
    if (!node) return;
    try {
      // 两条路径都读同一个节点，保证内容一致。
      const rich = node.innerHTML;
      await copyRich(rich, plain_text);
      setStatus(`已复制富文本（${rich.length} 字符），粘贴到公众号编辑器即可`);
    } catch {
      setStatus("复制被浏览器拒绝，请手动全选复制");
    }
  }

  async function copyPlain(): Promise<void> {
    try {
      await copyText(plain_text);
      setStatus("已复制纯文字");
    } catch {
      setStatus("纯文字复制被浏览器拒绝");
    }
  }

  return (
    <section>
      <style>{styles}</style>
      <p className="wb-sub" style={{ marginTop: 0 }}>
        <Link to="/editorial">← 回队列</Link> · <Link to={`/editorial/drafts/${params.draftId}`}>回审核页</Link>
      </p>
      <h2 className="wb-title" style={{ marginBottom: 4 }}>{title}</h2>
      <p className="wb-sub" style={{ marginTop: 0 }}>下面是粘贴进公众号后的样子；标题由公众号后台单独填写，不在复制内容里。</p>

      <div className="wb-tools">
        <button type="button" data-primary="true" onClick={copyArticle}>复制公众号正文</button>
        <button type="button" onClick={copyPlain}>复制纯文字</button>
      </div>
      {status ? <p className="wb-ok" role="status">{status}</p> : null}

      <div className="wb-preview">
        <div className="wb-article">
          {/*
            这里信任服务端渲染结果：/render 返回前会跑 assertSafeHtml，
            禁止 script、iframe、on* 事件属性与内部 claim 编号。
          */}
          <article id="wechat-article" ref={articleRef} dangerouslySetInnerHTML={{ __html: html }} />
        </div>

        <aside className="wb-panel">
          <h2>素材清单（{images.length}）</h2>
          {images.length === 0 ? (
            <p className="wb-sub">这篇没有配图。</p>
          ) : (
            images.map((image) => (
              <div key={image.hash} className="wb-asset">
                {image.url ? <img src={image.url} alt={image.alt} /> : null}
                <div>
                  <div>{image.alt || "（无说明）"}</div>
                  <div className="wb-sub">
                    {image.width}×{image.height} · {image.mime.replace("image/", "").toUpperCase()}
                  </div>
                </div>
              </div>
            ))
          )}
          <p className="wb-note">图片需要你在公众号素材库里单独上传；复制内容里的图片地址只在登录后的工作台可见。</p>
        </aside>
      </div>
    </section>
  );
}
