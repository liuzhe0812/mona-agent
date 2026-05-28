import { getFileTypeIcon } from "../ipc";

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

function cacheKey(extension: string, isDir: boolean): string {
  return `${extension}:${isDir ? "d" : "f"}`;
}

export function getCachedIcon(
  extension: string,
  isDir: boolean,
): string | null {
  const key = cacheKey(extension, isDir);
  return cache.get(key) ?? null;
}

export async function getIcon(
  extension: string,
  isDir: boolean,
): Promise<string | null> {
  const key = cacheKey(extension, isDir);

  const cached = cache.get(key);
  if (cached) return cached;

  const existing = pending.get(key);
  if (existing) return existing;

  const promise = getFileTypeIcon(extension, isDir).then((b64) => {
    pending.delete(key);
    if (b64) {
      const dataUrl = `data:image/png;base64,${b64}`;
      cache.set(key, dataUrl);
      return dataUrl;
    }
    return null;
  });

  pending.set(key, promise);
  return promise;
}

export function extractExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return name.slice(dotIndex + 1).toLowerCase();
}
