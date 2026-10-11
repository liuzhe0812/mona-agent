import { decodeFilePathUriEscapes, joinFilePath } from "./path.js";
import { resolveMarkdownFileLink } from "./markdownFileLink.js";

export interface AssistantFilePathResolveOptions {
  homePath?: string;
}

function cleanAssistantFilePathCandidate(candidate: string): string {
  return candidate
    .trim()
    .replace(/[.,;!?，。！？；：、]+$/, "")
    .replace(/:\d+(?::\d+)?$/, "");
}

function parseAssistantFileUrlPath(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "file:") return null;

    const decodedPathname = decodeFilePathUriEscapes(parsedUrl.pathname);
    if (/^\/[a-zA-Z]:\//.test(decodedPathname)) return decodedPathname.slice(1);
    if (parsedUrl.hostname && parsedUrl.hostname !== "localhost") {
      return `//${parsedUrl.hostname}${decodedPathname}`;
    }
    return decodedPathname;
  } catch {
    return null;
  }
}

export function resolveAssistantRawFilePath(
  workspacePath: string,
  rawPath: string,
  options: AssistantFilePathResolveOptions = {},
): string | null {
  if (/^file:\/\//i.test(rawPath)) return parseAssistantFileUrlPath(rawPath);

  const cleanedPath = cleanAssistantFilePathCandidate(rawPath);
  if (!cleanedPath || cleanedPath.startsWith("http://") || cleanedPath.startsWith("https://")) {
    return null;
  }
  if (/^~(?:[\\/]|[^\\/]+[\\/])/.test(cleanedPath)) {
    return resolveMarkdownFileLink(workspacePath, cleanedPath, options)?.path ?? null;
  }

  const parsedLink = resolveMarkdownFileLink(workspacePath, rawPath, options);
  if (parsedLink) return parsedLink.path;

  if (!cleanedPath.includes("/") && !cleanedPath.includes("\\")) {
    return joinFilePath(workspacePath, cleanedPath);
  }
  return resolveMarkdownFileLink(workspacePath, `./${cleanedPath}`, options)?.path ?? null;
}
