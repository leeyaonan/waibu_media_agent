// 运行与费用面板：每次运行的阶段、token、费用与暂停原因。
// 费用不知道就写 unknown；恢复按钮只补未成功的阶段。
import type { ReactNode } from "react";
import { Link, redirect, useLoaderData } from "react-router";
import { beijingStamp } from "@aihot/contracts/time";
import { ApiError, editorialGet, editorialSignedIn, loginRedirect } from "./api.ts";

interface RunItem {
  run: { id: string; business_date: string; mode: string; status: string; created_at: string };
  stages_done: number;
  total_tokens: number;
}

interface StepItem {
  stage: string;
  status: string;
  attempt: number;
  error_code: string | null;
  input_tokens: number;
  output_tokens: number;
  cost: { amount: number; currency: string } | null;
}

interface RunDetail {
  run: RunItem["run"];
  steps: StepItem[];
  total_tokens: number;
  cost: { amount: number; currency: string } | null;
  paused_reason: string | null;
  resumable: string[];
}

type LoaderData =
  | { ok: true; runs: RunItem[]; detail: RunDetail | null }
  | { ok: false; message: string };

export async function loader({ request }: { request: Request }): Promise<LoaderData> {
  const url = new URL(request.url);
  if (!(await editorialSignedIn(request))) throw redirect(loginRedirect(url));
  const runId = url.searchParams.get("run");
  try {
    const runs = await editorialGet<{ items: RunItem[] }>({ request, path: "/runs" });
    const detail = runId ? await editorialGet<RunDetail>({ request, path: `/runs/${runId}` }) : null;
    return { ok: true, runs: runs.items, detail };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? `${error.message}（${error.code}）` : "连不上 api 进程" };
  }
}

export const headers = () => ({ "Cache-Control": "no-store" });

const styles = `
.wb-runs{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:20px;align-items:start}
@media (max-width:820px){.wb-runs{grid-template-columns:minmax(0,1fr)}}
.wb-run{border:1px solid #e6e6e6;border-radius:var(--radius-card);padding:12px 14px;margin-bottom:10px;background:#fff}
.wb-run[data-current="true"]{border-color:#1a1a1a}
.wb-run a{color:inherit;text-decoration:none}
.wb-run .wb-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:13px;color:#666;margin-top:6px}
.wb-badge{font-size:12px;padding:2px 8px;border-radius:9999px;background:#f1f1f1;color:#444}
.wb-badge.warn{background:#fff2e0;color:#8a4b00}
.wb-badge.ok{background:#e7f6ec;color:#1d6b34}
.wb-panel{border:1px solid #e6e6e6;border-radius:var(--radius-card);padding:14px;background:#fff;position:sticky;top:16px}
.wb-panel h2{font-size:15px;margin:0 0 8px}
.wb-panel table{width:100%;border-collapse:collapse;font-size:13px}
.wb-panel th,.wb-panel td{text-align:left;padding:6px 4px;border-bottom:1px solid #f0f0f0}
.wb-note{font-size:13px;color:#8a4b00}
`;

function statusTone(status: string): string {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "paused_budget" || status === "waiting_input") return "warn";
  return "";
}

function costText(cost: { amount: number; currency: string } | null): string {
  return cost ? `${cost.currency} ${cost.amount.toFixed(2)}` : "unknown";
}

export default function EditorialRuns(): ReactNode {
  const data = useLoaderData() as LoaderData;

  if (!data.ok) {
    return (
      <div className="wb-error" role="alert">
        <strong>运行面板加载失败</strong>
        <p>{data.message}</p>
        <Link to="/editorial">← 回队列</Link>
      </div>
    );
  }

  return (
    <section>
      <style>{styles}</style>
      <p className="wb-sub" style={{ marginTop: 0 }}>
        <Link to="/editorial">← 回队列</Link> · 最近 {data.runs.length} 次运行
      </p>

      {data.runs.length === 0 ? (
        <div className="wb-empty">
          <p>还没有运行记录。</p>
          <p className="wb-sub">每天 08:30 会创建一次定时运行；也可以手动触发。</p>
        </div>
      ) : (
        <div className="wb-runs">
          <div>
            {data.runs.map((item) => (
              <div key={item.run.id} className="wb-run" data-current={data.detail?.run.id === item.run.id ? "true" : undefined}>
                <Link to={`/editorial/runs?run=${item.run.id}`}>
                  <strong>{item.run.business_date}</strong> · {item.run.mode === "scheduled" ? "定时" : "手动"}
                  <span className={`wb-badge ${statusTone(item.run.status)}`} style={{ marginLeft: 8 }}>{item.run.status}</span>
                </Link>
                <div className="wb-meta">
                  <span>完成 {item.stages_done} 个阶段</span>
                  <span>{item.total_tokens} tokens</span>
                  <span>{beijingStamp(item.run.created_at)}</span>
                </div>
              </div>
            ))}
          </div>

          <aside className="wb-panel" aria-live="polite">
            <h2>运行详情</h2>
            {!data.detail ? (
              <p className="wb-sub">点左边一次运行，看它的阶段与花费。</p>
            ) : (
              <>
                {data.detail.paused_reason ? <p className="wb-note">{data.detail.paused_reason}</p> : null}
                <table>
                  <thead>
                    <tr><th>阶段</th><th>状态</th><th>token</th></tr>
                  </thead>
                  <tbody>
                    {data.detail.steps.map((step) => (
                      <tr key={`${step.stage}-${step.attempt}`}>
                        <td>{step.stage}</td>
                        <td><span className={`wb-badge ${statusTone(step.status)}`}>{step.status}</span></td>
                        <td>{step.input_tokens + step.output_tokens}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="wb-sub">合计 {data.detail.total_tokens} tokens · 费用 {costText(data.detail.cost)}</p>
                {data.detail.resumable.length > 0 ? (
                  <p className="wb-sub">恢复只会补这些阶段：{data.detail.resumable.join("、")}（已成功的不会重跑）</p>
                ) : (
                  <p className="wb-sub">所有阶段都已完成。</p>
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
