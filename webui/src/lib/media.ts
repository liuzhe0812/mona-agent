import type { UIMediaAttachment, UIMediaKind, UIImage } from "@/lib/types";
import { getCachedApiBase } from "@/lib/api";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".3gp",
]);

function cleanPath(value: string): string {
  return value.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
}

function extensionOf(value?: string): string {
  if (!value) return "";
  const path = cleanPath(value);
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot);
}

export function inferMediaKind(media: { url?: string; name?: string }): UIMediaKind {
  const url = media.url ?? "";
  if (url.startsWith("data:image/")) return "image";
  if (url.startsWith("data:video/")) return "video";

  const ext = extensionOf(media.name) || extensionOf(url);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "file";
}

/** Resolve a potentially relative media URL to an absolute one.
 *
 * The backend sends signed media URLs as relative paths (``/api/media/…``).
 * In Tauri mode the page origin is ``tauri://localhost``, so the browser
 * would resolve those against the wrong host. We prepend the cached
 * gateway base (``http://127.0.0.1:{port}``) to fix this. In browser
 * mode the base is empty and relative URLs resolve correctly against
 * the page origin, so the URL is returned unchanged. */
export function resolveMediaUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  const base = getCachedApiBase();
  if (!base || !url.startsWith("/")) return url;
  return `${base}${url}`;
}

export function toMediaAttachment(media: {
  url?: string;
  name?: string;
  kind?: UIMediaKind;
}): UIMediaAttachment {
  return {
    kind: media.kind ?? inferMediaKind(media),
    url: resolveMediaUrl(media.url),
    name: media.name,
  };
}

/** Resolve URLs in a UIImage array (user-attached images from history replay). */
export function resolveUIImageUrls(images: UIImage[] | undefined): UIImage[] | undefined {
  if (!images || images.length === 0) return images;
  return images.map((img) => ({
    ...img,
    url: resolveMediaUrl(img.url),
  }));
}

/** Resolve URLs in a UIMediaAttachment array (assistant media from history replay). */
export function resolveMediaAttachmentUrls(
  media: UIMediaAttachment[] | undefined,
): UIMediaAttachment[] | undefined {
  if (!media || media.length === 0) return media;
  return media.map((item) => ({
    ...item,
    url: resolveMediaUrl(item.url),
  }));
}
