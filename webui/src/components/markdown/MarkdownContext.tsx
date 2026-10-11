import { createContext, useContext } from "react";

export interface MarkdownContextValue {
  projectId?: string;
  rootPath?: string;
  readMedia?: (path: string) => Promise<Blob>;
  openFile?: (path: string) => Promise<void>;
}

export const MarkdownContext = createContext<MarkdownContextValue | null>(null);
export const useMarkdownContext = () => useContext(MarkdownContext);

/** This is URL classification, not authorization; the server resolves and checks containment. */
export function projectRelativePath(source: string, rootPath = ""): string {
  if (source.startsWith("mona-media:")) return source;
  let path = source;
  if (/^file:/i.test(path)) {
    const url = new URL(path);
    if (url.hostname && url.hostname !== "localhost") throw new Error("无法读取其他主机的文件。");
    path = url.pathname.replace(/^\/([a-z]:\/)/i, "$1");
  } else {
    path = path.split(/[?#]/)[0];
  }
  try { path = decodeURIComponent(path); } catch { throw new Error("文件路径编码无效。"); }
  path = path.replace(/\\/g, "/").replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+)?)$/, "");
  const root = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  if (/^(?:[a-z]:\/|\/)/i.test(path)) {
    const fold = /^[a-z]:/i.test(root) ? (s: string) => s.toLowerCase() : (s: string) => s;
    if (!root || !fold(path).startsWith(`${fold(root)}/`)) throw new Error("该文件不在当前项目中。");
    path = path.slice(root.length + 1);
  }
  if (/^[a-z][\w+.-]*:/i.test(path) || path.startsWith("//")) throw new Error("不支持此文件地址。");
  return path.replace(/^\.\//, "");
}

export function isProjectReference(value: string): boolean {
  if (value.startsWith("mona-media:")) return true;
  return !!value && !value.startsWith("#") && !/^https?:\/\//i.test(value)
    && (/^(?:file:|[a-z]:[\\/])/i.test(value) || !/^[a-z][\w+.-]*:/i.test(value));
}
