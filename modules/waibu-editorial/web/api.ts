// 私人页面读取数据的唯一通道：带着访问者的 cookie 去问自己的 API。
//
// 页面不直接连数据库、也不持有模型密钥；会话校验发生在 API 那边，
// 这里只是把浏览器带来的 cookie 原样转过去，因此 SSR 与浏览器看到的是同一份权限。
const API_BASE = () => process.env.API_BASE_URL ?? "http://127.0.0.1:3001";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface ApiRequest {
  request: Request;
  path: string;
  /** 页面统一 no-store：稿件不能进任何共享缓存。 */
  init?: RequestInit;
}

export async function editorialGet<T>({ request, path, init }: ApiRequest): Promise<T> {
  const cookie = request.headers.get("cookie") ?? "";
  const response = await fetch(`${API_BASE()}/api/admin/editorial${path}`, {
    ...init,
    headers: { accept: "application/json", cookie, ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    let code = `http_${response.status}`;
    let detail = `请求失败（${response.status}）`;
    try {
      const problem = (await response.json()) as { code?: string; detail?: string };
      code = problem.code ?? code;
      detail = problem.detail ?? detail;
    } catch {
      // 非 JSON 错误体：保留状态码信息即可。
    }
    throw new ApiError(response.status, code, detail);
  }
  return (await response.json()) as T;
}

/** 会话是否有效：401 就当没登录，其他错误照常抛出（页面要区分“没登录”和“服务挂了”）。 */
export async function editorialSignedIn(request: Request): Promise<boolean> {
  try {
    await editorialGet<{ ok: boolean }>({ request, path: "/health" });
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return false;
    throw error;
  }
}

/** 未登录时跳转的地址：带上 return，登录后回到这一页。 */
export function loginRedirect(url: URL): string {
  return `/admin/login?${new URLSearchParams({ return: `${url.pathname}${url.search}` })}`;
}
