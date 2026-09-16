export const DEFAULT_NOTE_TITLE = "未命名笔记";
export const NOTE_TITLE_MAX_LENGTH = 40;

/** Convert one Markdown line into the plain text allowed in note metadata. */
export function cleanNoteTitleCandidate(value: string): string {
  let text = value.trim();
  text = text.replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+)/, "");
  text = text.replace(/^!\[([^\]]*)\]\([^)]*\).*$/, "$1");
  text = text.replace(/\[([^\]\n]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)([^*_\n]+)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/`([^`\n]*)`/g, "$1");
  text = text.replace(/\s+#{1,6}\s*$/, "");
  return text.replace(/\s+/g, " ").trim();
}

/** Derive a short, Markdown-free title while leaving the note body unchanged. */
export function deriveNoteTitle(
  markdown: string,
  fallback = DEFAULT_NOTE_TITLE,
  maxLength = NOTE_TITLE_MAX_LENGTH,
): string {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(?:```|~~~|---+|\*\*\*+|___+)$/.test(trimmed)) continue;
    const candidate = cleanNoteTitleCandidate(trimmed);
    if (candidate) return Array.from(candidate).slice(0, maxLength).join("");
  }
  return fallback;
}
