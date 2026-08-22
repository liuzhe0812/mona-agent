/** Shared display-only preview cleaner (session-list redesign §9.2).
 *
 *  Gateway owns preview semantics (which message, attachments → semantic
 *  text); the frontend owns display cleanup. Used by both the session list
 *  and session search, so existing ``preview`` values get identical cleanup
 *  at render time without any rewrite or cache migration. */

/** Strip display noise from a session preview: Markdown bold/italic,
 *  heading, list, quote and code-fence markers, then collapse newlines and
 *  runs of whitespace so the result fits a single-line, single-granularity
 *  list row. Idempotent and safe on plain text. */
export function cleanSessionPreview(raw: string | null | undefined): string {
  if (!raw) return "";
  let text = raw;
  // Code fences: drop the fence markers (and language tag), keep content.
  text = text.replace(/```[a-zA-Z0-9]*\n?/g, " ");
  // Line-start syntax: headings, block quotes, unordered/ordered list markers.
  text = text.replace(/^[ \t]{0,3}(#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+)/gm, "");
  // Inline syntax: bold/italic, strikethrough, inline code, links → text.
  text = text.replace(/(\*\*|__)([\s\S]*?)\1/g, "$2");
  text = text.replace(/(\*|_)([^*_\n]+)\1/g, "$2");
  text = text.replace(/~~([\s\S]*?)~~/g, "$1");
  text = text.replace(/`([^`\n]*)`/g, "$1");
  text = text.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1");
  // Collapse newlines and whitespace runs into a single line.
  text = text.replace(/\s+/g, " ");
  return text.trim();
}

const GENERIC_MONA_TITLES = new Set([
  "mona",
  "new chat",
  "new conversation",
  "新会话",
  "新对话",
]);

/** Generic Mona labels identify the agent, not the task, so they must not
 * occupy the primary title slot in a task-oriented session list. */
export function isGenericMonaTitle(
  title: string | null | undefined,
  monaDisplayName = "Mona",
): boolean {
  const normalized = title?.trim().toLocaleLowerCase() ?? "";
  if (!normalized) return false;
  return normalized === monaDisplayName.trim().toLocaleLowerCase()
    || GENERIC_MONA_TITLES.has(normalized);
}
