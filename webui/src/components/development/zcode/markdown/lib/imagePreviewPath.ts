import { getPathLeaf } from "./path.js";

const IMAGE_EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

export function isImagePreviewPath(path?: string): boolean {
  if (!path) return false;
  const leaf = getPathLeaf(path);
  const extension = leaf.includes(".") ? leaf.split(".").pop()?.toLowerCase() : undefined;
  return extension ? IMAGE_EXTENSION_TO_MEDIA_TYPE[extension] !== undefined : false;
}
