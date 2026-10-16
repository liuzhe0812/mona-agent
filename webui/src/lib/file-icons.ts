import { DEFAULT_FILE_ICON_NAME, resolveIconName } from "./file-icon-names";

const iconAssets = import.meta.glob("../components/development/zcode/tools/assets/material-icons/*.svg", {
  eager: true,
  query: "?url&no-inline",
  import: "default",
}) as Record<string, string>;

export const INLINE_FALLBACK_FILE_ICON_SRC =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><path d="M4.5 1.5h4.586L12.5 4.914V13a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3.5 13V3A1.5 1.5 0 0 1 5 1.5Z" stroke="#94A3B8" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.75V5h3.25" stroke="#94A3B8" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );

export function getFileIconAssetSource(iconName: string, fallbackName = DEFAULT_FILE_ICON_NAME): string {
  const prefix = "../components/development/zcode/tools/assets/material-icons/";
  return iconAssets[`${prefix}${iconName}.svg`] ?? iconAssets[`${prefix}${fallbackName}.svg`] ?? INLINE_FALLBACK_FILE_ICON_SRC;
}

export const DOCUMENT_FILE_ICON_SRC = getFileIconAssetSource(DEFAULT_FILE_ICON_NAME);
export const FOLDER_FILE_ICON_SRC = getFileIconAssetSource("folder");

export function getFileIconSource(name: string, isDirectory = false, expanded = false): string {
  return isDirectory
    ? getFileIconAssetSource(expanded ? "folder-open" : "folder", "folder")
    : getFileIconAssetSource(resolveIconName(name));
}

export function getFileIconFallback(source: string): string | null {
  if (source === INLINE_FALLBACK_FILE_ICON_SRC) return null;
  return source.endsWith(DOCUMENT_FILE_ICON_SRC) ? INLINE_FALLBACK_FILE_ICON_SRC : DOCUMENT_FILE_ICON_SRC;
}
