import type { Extension } from "@codemirror/state";

const LANG_MAP: Record<string, () => Promise<Extension>> = {
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
};

export function detectLanguage(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return LANG_MAP[ext] ? ext : null;
}

export async function loadLanguage(filename: string): Promise<Extension | null> {
  const ext = detectLanguage(filename);
  if (!ext) return null;
  return LANG_MAP[ext]();
}
