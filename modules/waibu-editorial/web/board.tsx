// 稿件队列：待审、改稿中、已批准三类，支持翻页；空队列、加载失败、积压超限都有明确界面。
import type { ReactNode } from "react";
import { Link, redirect, useLoaderData } from "react-router";
import { beijingStamp } from "@aihot/contracts/time";
import { ApiError, editorialGet, editorialSignedIn, loginRedirect } from "./api.ts";

interface DraftItem {
  draft: { id: string; state: string; updated_at: string; lock_version: number };
  topic: { id: string; angle: string };
  title: string;
  blocking_issues: number;
}

interface DraftsResponse {
  items: DraftItem[];
  next_cursor: string | null;
  pending_review: number;
}

const TABS: Array<{ key: string; label: string }> = [
  { key: "in_review", label: "待审" },
  { key: "revising", label: "改稿中" },
  { key: "approved", label: "已批准" },
  { key: "on_hold", label: "搁置" },
];

type LoaderData =
  | { ok: true; state: string; items: DraftItem[]; next: string | null; pending: number }
  | { ok: false; state: string; status: number; code: string; message: string };

export async function loader({ request }: { request: Request }): Promise<LoaderData> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "in_review";
  const cursor = url.searchParams.get("cursor");

  // 每个 loader 自己校会话：即使导航里看不到入口，直接访问 URL 也拦得住。
  if (!(await editorialSignedIn(request))) throw redirect(loginRedirect(url));

  const query = new URLSearchParams({ state, limit: "20" });
  if (cursor) query.set("cursor", cursor);
  try {
    const page = await editorialGet<DraftsResponse>({ request, path: `/drafts?${query.toString()}` });
    return { ok: true, state, items: page.items, next: page.next_cursor, pending: page.pending_review };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, state, status: error.status, code: error.code, message: error.message };
    return { ok: false, state, status: 500, code: "network_error", message: "连不上 api 进程" };
  }
}

export const headers = () => ({ "Cache-Control": "no-store" });

function stateLabel(state: string): string {
  return ({ in_review: "待审", revising: "改稿中", approved: "已批准", exported: "已导出", published: "已发布", on_hold: "搁置", rejected: "已驳回", checking: "自检中", drafting: "起草中" } as Record<string, string>)[state] ?? state;
}

export default function EditorialBoard(): ReactNode {
  const data = useLoaderData() as LoaderData;
  const current = data.state;

  return (
    <section>
      <nav className="wb-nav" aria-label="队列分类">
        {TABS.map((tab) => (
          <Link key={tab.key} className="wb-tab" to={`/editorial?state=${tab.key}`} aria-current={current === tab.key ? "page" : undefined}>
            {tab.label}
          </Link>
        ))}
      </nav>

      {data.ok ? (
        <>
          {data.pending >= 3 ? (
            <p className="wb-sub" role="status">
              待审已积压 {data.pending} 篇，自动起草会暂停，先处理已有的稿子。
            </p>
          ) : null}

          {data.items.length === 0 ? (
            <div className="wb-empty">
              <p>这个分类下还没有稿子。</p>
              <p className="wb-sub">自动流程每天最多出一篇待审稿；没有合格选题时当天就不出稿，这是正常的。</p>
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {data.items.map((item) => (
                <li key={item.draft.id} className="wb-card">
                  <h3>
                    <Link to={`/editorial/drafts/${item.draft.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                      {item.title || item.topic.angle}
                    </Link>
                  </h3>
                  <div className="wb-meta">
                    <span className="wb-badge">{stateLabel(item.draft.state)}</span>
                    {item.blocking_issues > 0 ? <span className="wb-badge warn">{item.blocking_issues} 项待处理</span> : <span className="wb-badge ok">可批准</span>}
                    <span>更新于 {beijingStamp(item.draft.updated_at)}</span>
                  </div>
                  <p className="wb-sub" style={{ margin: "8px 0 0" }}>选题角度：{item.topic.angle}</p>
                </li>
              ))}
            </ul>
          )}

          {data.next ? (
            <Link className="wb-more" to={`/editorial?state=${current}&cursor=${encodeURIComponent(data.next)}`}>
              下一页 →
            </Link>
          ) : null}
        </>
      ) : (
        <div className="wb-error" role="alert">
          <strong>队列加载失败</strong>
          <p>
            {data.message}（{data.code}）
          </p>
          <p className="wb-sub">刷新重试；连续失败时先看 api 进程是否在运行。</p>
        </div>
      )}
    </section>
  );
}
