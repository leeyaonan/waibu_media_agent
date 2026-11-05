// 正文审核页：段落、事实、证据抽屉、意见与批准入口。
// 证据摘录一律当纯文本渲染（不注入 HTML）：来源网页里的脚本、样式、iframe 都不能在这里执行。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, redirect, useLoaderData, useParams } from "react-router";
import { beijingStamp } from "@aihot/contracts/time";
import { ApiError, editorialGet, editorialSignedIn, loginRedirect } from "./api.ts";

interface EvidenceItem {
  id: string;
  source_id: string;
  url: string;
  excerpt: string;
  validity: string;
  published_at: string | null;
}

interface ClaimItem {
  id: string;
  text: string;
  kind: string;
  status: string;
  evidence: EvidenceItem[];
}

interface ReviewPayload {
  draft: { id: string; state: string; lock_version: number; current_revision_id: string | null };
  revision: { id: string; title: string; summary: string; body: string; content_hash: string; policy_version: string } | null;
  blocks: Array<{ block_id: string; index: number; text: string; claim_ids: string[] }>;
  claims: ClaimItem[];
  feedback: Array<{ id: string; block_id: string | null; text: string; resolution_revision_id: string | null }>;
  approval: { id: string; revision_id: string; content_hash: string; approved_at: string } | null;
}

type LoaderData =
  | { ok: true; detail: ReviewPayload }
  | { ok: false; status: number; code: string; message: string };

export async function loader({ request, params }: { request: Request; params: Record<string, string | undefined> }): Promise<LoaderData> {
  const url = new URL(request.url);
  if (!(await editorialSignedIn(request))) throw redirect(loginRedirect(url));
  try {
    const detail = await editorialGet<ReviewPayload>({ request, path: `/drafts/${params.draftId ?? ""}` });
    return { ok: true, detail };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, status: error.status, code: error.code, message: error.message };
    return { ok: false, status: 500, code: "network_error", message: "连不上 api 进程" };
  }
}

export const headers = () => ({ "Cache-Control": "no-store" });

const styles = `
.wb-review{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:20px;align-items:start}
@media (max-width:820px){.wb-review{grid-template-columns:minmax(0,1fr)}}
.wb-body p{margin:0 0 14px;line-height:1.8;font-size:16px}
.wb-block{position:relative;padding-right:8px}
.wb-block[data-active="true"]{background:#fff8e6;border-radius:var(--radius-control)}
.wb-claim-btn{display:inline-flex;align-items:center;gap:4px;margin-left:6px;font-size:12px;border:1px solid #d8d8d8;background:#fff;border-radius:9999px;padding:1px 8px;cursor:pointer;color:#444;vertical-align:middle}
.wb-claim-btn[aria-pressed="true"]{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
.wb-panel{border:1px solid #e6e6e6;border-radius:var(--radius-card);padding:14px;background:#fff;position:sticky;top:16px}
.wb-panel h2{font-size:15px;margin:0 0 10px}
.wb-evidence{border-top:1px solid #eee;padding-top:10px;margin-top:10px;font-size:14px;line-height:1.7}
.wb-evidence blockquote{margin:6px 0;padding:8px 10px;background:#f7f7f7;border-left:3px solid #d8d8d8;white-space:pre-wrap;word-break:break-word}
.wb-evidence a{color:#1a56c4;word-break:break-all}
.wb-status{font-size:12px;padding:2px 8px;border-radius:9999px;background:#f1f1f1}
.wb-status.warn{background:#fff2e0;color:#8a4b00}
.wb-status.ok{background:#e7f6ec;color:#1d6b34}
.wb-edit{width:100%;min-height:280px;font:inherit;line-height:1.7;padding:12px;border:1px solid #ddd;border-radius:var(--radius-control)}
.wb-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.wb-actions button{font:inherit;padding:8px 14px;border-radius:var(--radius-control);border:1px solid #ccc;background:#fff;cursor:pointer}
.wb-actions button[data-primary="true"]{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
.wb-note{font-size:13px;color:#8a4b00}
`;

function statusLabel(status: string): { text: string; tone: string } {
  if (status === "supported") return { text: "已核实", tone: "ok" };
  if (status === "disputed") return { text: "有冲突", tone: "warn" };
  if (status === "unsupported") return { text: "缺证据", tone: "warn" };
  return { text: "未核查", tone: "" };
}

export default function EditorialReview(): ReactNode {
  const data = useLoaderData() as LoaderData;
  const params = useParams();
  const [selected, setSelected] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [dirty, setDirty] = useState(false);

  // 未保存的修改要拦住关闭/刷新；内部跳转也提示。
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const claimsById = useMemo(() => new Map((data.ok ? data.detail.claims : []).map((claim) => [claim.id, claim])), [data]);
  const claim = selected ? claimsById.get(selected) ?? null : null;

  if (!data.ok) {
    return (
      <div className="wb-error" role="alert">
        <strong>稿件加载失败</strong>
        <p>
          {data.message}（{data.code}）
        </p>
        <Link to="/editorial">← 回队列</Link>
      </div>
    );
  }

  const detail = data.detail;
  if (!detail.revision) {
    return (
      <div className="wb-empty">
        <p>这篇稿子还没有版本内容。</p>
        <Link to="/editorial">← 回队列</Link>
      </div>
    );
  }

  return (
    <section>
      <style>{styles}</style>
      <p className="wb-sub" style={{ marginTop: 0 }}>
        <Link to="/editorial">← 回队列</Link> · 状态 {detail.draft.state} · 规则版本 {detail.revision.policy_version}
      </p>
      <h2 className="wb-title" style={{ marginBottom: 4 }}>{detail.revision.title}</h2>
      <p className="wb-sub" style={{ marginTop: 0 }}>摘要：{detail.revision.summary || "（无）"}</p>

      <div className="wb-review">
        <div>
          <div className="wb-body">
            {detail.blocks.map((block) => (
              <p key={block.block_id} className="wb-block" data-active={block.claim_ids.includes(selected ?? "") ? "true" : undefined}>
                {block.text}
                {block.claim_ids.map((claimId) => (
                  <button
                    key={claimId}
                    type="button"
                    className="wb-claim-btn"
                    aria-pressed={selected === claimId}
                    onClick={() => setSelected(selected === claimId ? null : claimId)}
                  >
                    {selected === claimId ? "收起证据" : "看证据"}
                  </button>
                ))}
              </p>
            ))}
          </div>

          <div className="wb-actions">
            <button type="button" onClick={() => { setDraftBody(detail.blocks.map((block) => block.text).join("\n\n")); setDirty(true); }}>
              在下方编辑
            </button>
            <button type="button" data-primary="true" disabled title="保存接口在 F25 接入">
              保存为新版本
            </button>
          </div>
          {dirty ? <p className="wb-note">有未保存的修改：离开或刷新会被拦下确认。</p> : null}
          <textarea
            className="wb-edit"
            value={draftBody}
            placeholder="点上面的“在下方编辑”把正文载入这里。保存为新版本的能力在 F25 接入。"
            onChange={(event) => {
              setDraftBody(event.target.value);
              setDirty(true);
            }}
          />
        </div>

        <aside className="wb-panel" aria-live="polite">
          <h2>证据与核查</h2>
          {!claim ? (
            <p className="wb-sub">点正文里的“看证据”，这里显示对应的事实与来源摘录。</p>
          ) : (
            <div>
              <p style={{ margin: "0 0 6px" }}>{claim.text}</p>
              <span className={`wb-status ${statusLabel(claim.status).tone}`}>{statusLabel(claim.status).text}</span>
              {claim.evidence.length === 0 ? (
                <p className="wb-sub">这条结论还没有绑定证据。</p>
              ) : (
                claim.evidence.map((item) => (
                  <div key={item.id} className="wb-evidence">
                    {/* 摘录当纯文本渲染：来源网页里的脚本不会执行 */}
                    <blockquote data-excerpt="true">{item.excerpt}</blockquote>
                    <div className="wb-sub">
                      来源 {item.source_id}
                      {item.validity !== "valid" ? ` · ${item.validity}` : ""}
                    </div>
                    <a href={item.url} target="_blank" rel="noreferrer noopener">{item.url}</a>
                  </div>
                ))
              )}
            </div>
          )}

          <h2 style={{ marginTop: 18 }}>意见（{detail.feedback.length}）</h2>
          {detail.feedback.length === 0 ? (
            <p className="wb-sub">还没有意见。</p>
          ) : (
            <ul style={{ paddingLeft: 16, fontSize: 14, lineHeight: 1.7 }}>
              {detail.feedback.map((item) => (
                <li key={item.id}>
                  第 {item.block_id ?? "全篇"} 段：{item.text}
                </li>
              ))}
            </ul>
          )}

          <h2 style={{ marginTop: 18 }}>批准</h2>
          {detail.approval ? (
            <p className="wb-sub">已于 {beijingStamp(detail.approval.approved_at)} 批准</p>
          ) : (
            <p className="wb-sub">尚未批准。批准入口见队列页上方的说明；批准能力已在 F20 落地为接口。</p>
          )}
          <p className="wb-sub">稿件 {params.draftId}</p>
        </aside>
      </div>
    </section>
  );
}
