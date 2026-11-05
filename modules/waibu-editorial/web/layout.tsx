// 私人工作台外壳：进入任何私人页面前先确认会话，未登录直接去登录页并带回跳地址。
// 页面本身不缓存：稿件、批注、证据都不允许进共享缓存。
import type { ReactNode } from "react";
import { Outlet, isRouteErrorResponse, redirect, useRouteError } from "react-router";
import { editorialSignedIn, loginRedirect } from "./api.ts";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  if (!(await editorialSignedIn(request))) throw redirect(loginRedirect(url));
  return { signedIn: true as const };
}

export const headers = () => ({ "Cache-Control": "no-store" });

const styles = `
.wb-shell{max-width:960px;margin:0 auto;padding:24px 16px 64px;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;color:#1a1a1a}
.wb-head{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between;border-bottom:1px solid #e6e6e6;padding-bottom:12px}
.wb-title{font-size:20px;font-weight:600;margin:0}
.wb-sub{font-size:13px;color:#666}
.wb-nav{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 20px}
.wb-tab{padding:6px 12px;border-radius:9999px;border:1px solid #ddd;font-size:14px;text-decoration:none;color:#333;background:#fff}
.wb-tab[aria-current="page"]{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
.wb-card{border:1px solid #e6e6e6;border-radius:var(--radius-card);padding:14px 16px;margin-bottom:12px;background:#fff}
.wb-card h3{margin:0 0 6px;font-size:16px;line-height:1.45}
.wb-meta{font-size:13px;color:#666;display:flex;gap:12px;flex-wrap:wrap}
.wb-badge{font-size:12px;padding:2px 8px;border-radius:9999px;background:#f1f1f1;color:#444}
.wb-badge.warn{background:#fff2e0;color:#8a4b00}
.wb-badge.ok{background:#e7f6ec;color:#1d6b34}
.wb-empty{border:1px dashed #ccc;border-radius:var(--radius-card);padding:32px 16px;text-align:center;color:#666}
.wb-error{border:1px solid #f0c2c2;background:#fdf3f3;border-radius:var(--radius-card);padding:16px;color:#8a1f1f}
.wb-more{display:inline-block;margin-top:8px;font-size:14px;color:#1a56c4}
@media (max-width:520px){.wb-shell{padding:16px 12px 48px}.wb-card{padding:12px}.wb-title{font-size:18px}}
`;

export default function EditorialLayout(): ReactNode {
  return (
    <div className="wb-shell">
      <style>{styles}</style>
      <header className="wb-head">
        <h1 className="wb-title">公众号工作台</h1>
        <span className="wb-sub">私人页面 · 只有登录后才能看到稿件</span>
      </header>
      <Outlet />
    </div>
  );
}

export function ErrorBoundary(): ReactNode {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : "页面加载失败";
  return (
    <div className="wb-shell">
      <style>{styles}</style>
      <h1 className="wb-title">公众号工作台</h1>
      <div className="wb-error" role="alert">
        <strong>这一页没能加载</strong>
        <p>{message}</p>
        <p className="wb-sub">刷新重试；如果一直失败，先确认 api 进程在运行。</p>
      </div>
    </div>
  );
}
