import remend from "remend";

function normalizeText(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
    .replace(/\\\((.*?)\\\)/g, (_, math: string) => `$${math}$`)
    .replace(/(?<![\\$])\$(?!\$)([^$\n]+)\$(?!\$)/g, (whole, inner: string, offset: number, input: string) => {
      // A second price/variable starts at the closing dollar, rather than ending a formula.
      const after = input.slice(offset + whole.length);
      return (/^\d/.test(inner) && /^\d/.test(after))
        || (/^[A-Z_][A-Z_\d]*(?:\s|\b)/.test(inner) && /^[A-Z_]/.test(after))
        ? whole.replaceAll("$", "\\$") : whole;
    });
}

export function normalizeConversationMarkdown(source: string, streaming: boolean): string {
  // Preserve fenced/indented code, inline code and link destinations byte for byte.
  let fence: { mark: string; size: number } | null = null;
  let displayMath = false;
  let plain = "";
  let result = "";
  const flush = () => {
    result += plain.split(/(`+[^`\n]*`+|\]\([^\n]*?\))/g)
      .map((part) => /^(?:`|\]\()/.test(part) ? part : normalizeText(part)).join("");
    plain = "";
  };
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const outsideCode = line.replace(/`+[^`\n]*`+/g, "");
    if (fence) {
      result += line;
      if (marker && marker[1][0] === fence.mark && marker[1].length >= fence.size
        && line.slice(marker[0].length).trim() === "") fence = null;
    } else if (marker) {
      flush(); result += line;
      fence = { mark: marker[1][0], size: marker[1].length };
    } else if (displayMath || !/^(?: {4}|\t)/.test(line) && outsideCode.includes("\\[")) {
      plain += line;
      displayMath = !outsideCode.includes("\\]");
    } else if (/^(?: {4}|\t)/.test(line)) {
      flush(); result += line;
    } else plain += line;
  }
  flush();
  return streaming ? remend(result, { linkMode: "text-only", inlineKatex: false }) : result;
}
