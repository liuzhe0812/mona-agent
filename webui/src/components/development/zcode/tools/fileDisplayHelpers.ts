// 纯工具函数和常量，从 fileDisplay.tsx 提取以控制文件行数

export { DEFAULT_FILE_ICON_NAME, resolveIconName } from "@/lib/file-icon-names";

const ICON_COLOR_MAP: Record<string, { accent: string; background: string }> = {
  audio: { accent: "#7C3AED", background: "#EDE9FE" },
  css: { accent: "#1572B6", background: "#E0F2FE" },
  database: { accent: "#7C3AED", background: "#EDE9FE" },
  docker: { accent: "#1D63ED", background: "#DBEAFE" },
  document: { accent: "#64748B", background: "#E2E8F0" },
  editorconfig: { accent: "#F59E0B", background: "#FEF3C7" },
  eslint: { accent: "#4F46E5", background: "#E0E7FF" },
  folder: { accent: "#B45309", background: "#FEF3C7" },
  git: { accent: "#F05133", background: "#FEE2E2" },
  go: { accent: "#0EA5E9", background: "#E0F2FE" },
  html: { accent: "#E44D26", background: "#FEE2E2" },
  image: { accent: "#DB2777", background: "#FCE7F3" },
  javascript: { accent: "#CA8A04", background: "#FEF9C3" },
  json: { accent: "#0F766E", background: "#CCFBF1" },
  markdown: { accent: "#2563EB", background: "#DBEAFE" },
  nodejs_alt: { accent: "#16A34A", background: "#DCFCE7" },
  npm: { accent: "#DC2626", background: "#FEE2E2" },
  php: { accent: "#7C3AED", background: "#EDE9FE" },
  prettier: { accent: "#DB2777", background: "#FCE7F3" },
  python: { accent: "#2563EB", background: "#DBEAFE" },
  react: { accent: "#0891B2", background: "#CFFAFE" },
  react_ts: { accent: "#0284C7", background: "#E0F2FE" },
  readme: { accent: "#2563EB", background: "#DBEAFE" },
  rust: { accent: "#9A3412", background: "#FFEDD5" },
  settings: { accent: "#4B5563", background: "#E5E7EB" },
  storybook: { accent: "#EC4899", background: "#FCE7F3" },
  svg: { accent: "#EA580C", background: "#FFEDD5" },
  toml: { accent: "#B45309", background: "#FEF3C7" },
  tsconfig: { accent: "#2563EB", background: "#DBEAFE" },
  typescript: { accent: "#2563EB", background: "#DBEAFE" },
  vitest: { accent: "#65A30D", background: "#ECFCCB" },
  video: { accent: "#DC2626", background: "#FEE2E2" },
  yaml: { accent: "#B91C1C", background: "#FEE2E2" },
  yarn: { accent: "#0F766E", background: "#CCFBF1" },
};

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function trimTrailingSeparator(path: string): string {
  return path.replace(/\/+$/, "");
}

export function getIconPalette(iconName: string) {
  return ICON_COLOR_MAP[iconName] ?? ICON_COLOR_MAP.document!;
}

export function getIconLabel(iconName: string): string {
  if (iconName === "document") {
    return "DOC";
  }

  if (iconName === "folder") {
    return "DIR";
  }

  const compactName = iconName.replace(/[_-]+/g, " ").trim();
  const firstWord = compactName.split(/\s+/)[0] ?? iconName;
  return firstWord.slice(0, 3).toUpperCase();
}

export function buildInlineSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
