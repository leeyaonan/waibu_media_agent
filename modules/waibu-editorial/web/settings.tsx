// 编辑策略配置：改每天出几篇、几个候选、什么时候跑。保存即升版本，只影响之后的运行。
import type { ReactNode } from "react";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { beijingStamp } from "@aihot/contracts/time";
import { ApiError, editorialGet, editorialPost, editorialSignedIn, loginRedirect } from "./api.ts";

interface Settings {
  max_drafts_per_day: number;
  max_candidates_per_day: number;
  max_pending_reviews: number;
  daily_time: string;
  max_repair_rounds: number;
}

interface SettingsPayload {
  config: Settings;
  version: number;
  updated_by: string | null;
  updated_at: string | null;
  limits: string;
}

type LoaderData = { ok: true; data: SettingsPayload; csrf: string } | { ok: false; message: string };

export async function loader({ request }: { request: Request }): Promise<LoaderData> {
  const url = new URL(request.url);
  if (!(await editorialSignedIn(request))) throw redirect(loginRedirect(url));
  try {
    const [data, health] = await Promise.all([
      editorialGet<SettingsPayload>({ request, path: "/settings" }),
      editorialGet<{ csrf: string }>({ request, path: "/health" }),
    ]);
    return { ok: true, data, csrf: health.csrf };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? `${error.message}（${error.code}）` : "连不上 api 进程" };
  }
}

export const headers = () => ({ "Cache-Control": "no-store" });

export async function action({ request }: { request: Request }): Promise<{ ok: boolean; message: string }> {
  const form = await request.formData();
  try {
    const saved = await editorialPost<{ version: number }>({
      request,
      path: "/settings",
      method: "PUT",
      csrf: String(form.get("csrf") ?? ""),
      body: {
        expected_version: Number(form.get("expected_version") ?? 0),
        settings: {
          max_drafts_per_day: Number(form.get("max_drafts_per_day") ?? 0),
          max_candidates_per_day: Number(form.get("max_candidates_per_day") ?? 0),
          max_pending_reviews: Number(form.get("max_pending_reviews") ?? 0),
          daily_time: String(form.get("daily_time") ?? ""),
          max_repair_rounds: Number(form.get("max_repair_rounds") ?? 0),
        },
      },
    });
    return { ok: true, message: `已保存，配置版本 ${saved.version}。之后的运行用新配置，旧稿保持原样。` };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 409) return { ok: false, message: "保存失败：配置在别处已经改过，刷新后再试。" };
      return { ok: false, message: `配置保存失败：${error.message}` };
    }
    return { ok: false, message: "配置保存失败：连不上 api 进程。" };
  }
}

const styles = `
.wb-settings{max-width:560px}
.wb-field{display:flex;flex-direction:column;gap:4px;margin:14px 0}
.wb-field label{font-size:13px;color:#555}
.wb-field input{font:inherit;padding:8px 10px;border:1px solid #ddd;border-radius:var(--radius-control);max-width:200px}
.wb-actions button{font:inherit;padding:8px 14px;border-radius:var(--radius-control);border:1px solid #ccc;background:#fff;cursor:pointer}
.wb-actions button[data-primary="true"]{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
.wb-ok{font-size:13px;color:#1d6b34}
.wb-note{font-size:13px;color:#8a4b00}
`;

export default function EditorialSettings(): ReactNode {
  const loaderData = useLoaderData() as LoaderData;
  const result = useActionData() as { ok: boolean; message: string } | undefined;
  const busy = useNavigation().state === "submitting";

  if (!loaderData.ok) {
    return (
      <div className="wb-error" role="alert">
        <strong>配置加载失败</strong>
        <p>{loaderData.message}</p>
        <Link to="/editorial">← 回队列</Link>
      </div>
    );
  }

  const { config, version, updated_by, updated_at } = loaderData.data;
  return (
    <section className="wb-settings">
      <style>{styles}</style>
      <p className="wb-sub" style={{ marginTop: 0 }}>
        <Link to="/editorial">← 回队列</Link> · 当前版本 {version}
        {updated_at ? ` · 上次修改 ${beijingStamp(updated_at)}${updated_by ? `（${updated_by}）` : ""}` : ""}
      </p>

      <Form method="post">
        <input type="hidden" name="csrf" value={loaderData.csrf} />
        <input type="hidden" name="expected_version" value={version} />
        <div className="wb-field">
          <label htmlFor="wb-drafts">每天最多生成几篇待审稿（1–5）</label>
          <input id="wb-drafts" name="max_drafts_per_day" type="number" min={1} max={5} defaultValue={config.max_drafts_per_day} />
        </div>
        <div className="wb-field">
          <label htmlFor="wb-candidates">每天最多展示几个候选选题（1–10）</label>
          <input id="wb-candidates" name="max_candidates_per_day" type="number" min={1} max={10} defaultValue={config.max_candidates_per_day} />
        </div>
        <div className="wb-field">
          <label htmlFor="wb-pending">待审积压到几篇暂停自动起草（1–10）</label>
          <input id="wb-pending" name="max_pending_reviews" type="number" min={1} max={10} defaultValue={config.max_pending_reviews} />
        </div>
        <div className="wb-field">
          <label htmlFor="wb-time">每天定时运行时间（北京时间 HH:MM）</label>
          <input id="wb-time" name="daily_time" defaultValue={config.daily_time} placeholder="08:30" />
        </div>
        <div className="wb-field">
          <label htmlFor="wb-repair">自检后最多修复几轮（0–3）</label>
          <input id="wb-repair" name="max_repair_rounds" type="number" min={0} max={3} defaultValue={config.max_repair_rounds} />
        </div>
        <div className="wb-actions">
          <button type="submit" data-primary="true" disabled={busy}>{busy ? "保存中…" : "保存配置"}</button>
        </div>
      </Form>

      {result ? <p className={result.ok ? "wb-ok" : "wb-note"} role="status">{result.message}</p> : null}
      <p className="wb-sub">{loaderData.data.limits}</p>
      <p className="wb-sub">改配置只影响之后创建的运行；已经生成的稿子保留它们当时的策略版本。</p>
    </section>
  );
}
