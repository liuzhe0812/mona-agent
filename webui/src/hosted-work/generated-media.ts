import { getHostedPlatform, hostedPlatformFetch, HostedPlatformError } from "@/lib/hosted-platform";

const GENERATED_MEDIA_PATH = /^\/api\/work\/desktop\/generated-media\/[A-Za-z0-9_-]{32,128}$/;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024; // HostedWorkConfig.max_file_bytes cannot exceed this.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function isGeneratedMediaUrl(value: string | undefined): boolean {
  if (!value) return false;
  try { return GENERATED_MEDIA_PATH.test(new URL(value, window.location.origin).pathname); }
  catch { return false; }
}

export async function fetchGeneratedMedia(value: string, sessionKey: string, signal: AbortSignal): Promise<Blob> {
  const session = getHostedPlatform();
  if (!session) throw new HostedPlatformError("请重新登录后查看图片。", 401);
  if (!/^websocket:[a-f0-9]{32}$/.test(sessionKey)) throw new HostedPlatformError("会话无效。", 400);
  const target = new URL(value, window.location.origin);
  if (target.origin !== window.location.origin || target.username || target.password || target.search || target.hash
      || !GENERATED_MEDIA_PATH.test(target.pathname)) {
    throw new HostedPlatformError("图片地址无效。", 400);
  }
  // Expired image tickets do not imply the account session expired.
  const response = await hostedPlatformFetch(target.href, {
    signal, headers: { "X-Mona-Session-Key": sessionKey },
  }, { logoutOnUnauthorized: false });
  if (!response.ok) throw new HostedPlatformError("图片暂时无法查看，请刷新会话后重试。", response.status);
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const length = response.headers.get("content-length");
  if (!IMAGE_TYPES.has(mime) || length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_BYTES)) {
    throw new HostedPlatformError("图片格式或大小无效。", 413);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HostedPlatformError("图片内容无效。", 503);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new HostedPlatformError("图片大小超出限制。", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!total || signal.aborted || getHostedPlatform() !== session) {
    throw new HostedPlatformError("图片无法在当前账号中查看。", 409);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new Blob([bytes.buffer], { type: mime });
}
