import { ApiError, getServicesHttpBase, type VideoStyleDraft } from "./api";
import { httpFetch } from "./tauri";

async function styleRequest<T>(token: string, seriesId: string, suffix: string, options?: RequestInit): Promise<T> {
  const base = await getServicesHttpBase();
  const controller = new AbortController();
  const cancel = () => controller.abort(options?.signal?.reason);
  if (options?.signal?.aborted) cancel();
  else options?.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("风格操作等待超时，请重试。", "TimeoutError")), 120000);
  try {
    const response = await httpFetch(`${base}/api/video/series/${encodeURIComponent(seriesId)}${suffix}`, {
      ...options, signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...options?.headers },
    });
    const result = await response.json();
    if (!response.ok) throw new ApiError(response.status, result.message ?? result.error ?? "风格操作未能完成，请重试。", result.code);
    return result as T;
  } finally { clearTimeout(timer); options?.signal?.removeEventListener("abort", cancel); }

}

export function bindVideoStyleSample(token: string, seriesId: string, projectName: string, revision: number, description: string, refresh = false, seedVersion?: number) {
  return styleRequest<{ ok: boolean; draft: VideoStyleDraft }>(token, seriesId, "/style/sample", {
    method: "POST", body: JSON.stringify({ projectName, revision, description, refresh, ...(seedVersion ? { seedVersion } : {}) }),
  });
}

export function fetchVideoStyleSample(token: string, seriesId: string, options: { version?: number; muted?: boolean; signal?: AbortSignal } = {}) {
  const query = new URLSearchParams();
  if (options.version) query.set("version", String(options.version));
  if (options.muted) query.set("muted", "1");
  return styleRequest<{ ok: boolean; html: string; duration: number; revision: number; editableFields?: Array<"primaryColor" | "backgroundColor" | "fontFamily"> }>(token, seriesId, `/style/sample?${query}`, { signal: options.signal });
}

export function copyVideoStyle(token: string, seriesId: string) {
  return styleRequest<{ ok: boolean; series: import("./api").VideoSeries }>(token, seriesId, "/copy", { method: "POST", body: "{}" });
}

export async function fetchVideoStyleReference(token: string, seriesId: string, index: number, signal: AbortSignal) {
  const base = await getServicesHttpBase();
  const response = await httpFetch(`${base}/api/video/series/${encodeURIComponent(seriesId)}/style/reference?index=${index}`, {
    headers: { Authorization: `Bearer ${token}` }, signal,
  });
  if (!response.ok) throw new ApiError(response.status, "参考图暂时无法读取。");
  return response.blob();
}
