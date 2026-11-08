import { getHostedPlatform } from "@/lib/hosted-platform";
import type { DeliveredFile, UIMediaAttachment } from "@/lib/types";
import { isGeneratedMediaUrl } from "./generated-media";

const PREVIEW = /^\/workspace\/\.generated-previews\/[a-f0-9]{32}\/[a-f0-9]{32}\/([a-f0-9]{64})\.(?:png|jpg|webp)$/;
const DIGEST = /^[a-f0-9]{64}$/;

function workspacePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || /[\\?#%\x00-\x1f]/.test(value)) return;
  const path = value.startsWith("/workspace/") ? value : value.startsWith("/") ? "" : `/workspace/${value}`;
  if (!path || path.split("/").some((part) => part === "." || part === "..")) return;
  return path;
}

/** Suppress only a local Markdown image already delivered as the same hosted preview. */
export function duplicateGeneratedImageSources(files: DeliveredFile[] | undefined, media: UIMediaAttachment[] | undefined): string[] {
  if (!getHostedPlatform() || !files?.length || !media?.length) return [];
  const previewNames = new Set(media.filter((item) => {
    if (item.kind !== "image" || !item.name || !isGeneratedMediaUrl(item.url)) return false;
    try {
      const url = new URL(item.url!, window.location.origin);
      return url.origin === window.location.origin && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }).map((item) => item.name));
  const previewDigests = new Set(files.flatMap((file) => {
    const path = workspacePath(file.absolute_path);
    const match = path && PREVIEW.exec(path);
    return match && file.sha256 === match[1] && previewNames.has(file.name) ? [match[1]] : [];
  }));
  return files.flatMap((file) => {
    const path = workspacePath(file.absolute_path);
    if (!path || path !== workspacePath(file.path) || path.startsWith("/workspace/.generated-previews/")
        || typeof file.mime !== "string" || !file.mime.startsWith("image/") || !file.sha256 || !DIGEST.test(file.sha256)
        || !previewDigests.has(file.sha256)) return [];
    return [`sandbox:${path}`, path];
  });
}
