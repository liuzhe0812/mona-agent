/**
 * 思维导图导出为 FreeMind (.mm) 通用格式。
 *
 * 基于 XML，递归遍历 MindMapNode 即可生成。
 * 不依赖任何第三方库，纯字符串拼接 + XML 转义。
 */
import { downloadMediaUrl } from "@/lib/tauri";
import type { MindMapNode } from "./mindmap-outline";

/** XML 属性值转义 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** XML 文本内容转义 */
function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 安全文件名（去除 Windows 非法字符） */
export function safeFileName(name: string, fallback = "mindmap"): string {
  const cleaned = (name || "").replace(/[\\/:*?"<>|]/g, "_").trim();
  return cleaned.slice(0, 40) || fallback;
}

/**
 * 导出为 FreeMind 1.0.1 (.mm)。
 *
 * FreeMind / Freeplane / XMind 都支持导入。
 * map 元素下递归 node，支持 text、color、link 属性。
 */
export function exportToFreemind(root: MindMapNode): string {
  function buildNode(node: MindMapNode, indent: number): string {
    const pad = "  ".repeat(indent);
    const text = escapeAttr(node.topic || "");
    const color = node.style?.color ? ` COLOR="${escapeAttr(node.style.color)}"` : "";
    const link = node.hyperLink ? ` LINK="${escapeAttr(node.hyperLink)}"` : "";
    const childrenXml = (node.children || [])
      .map((c) => buildNode(c, indent + 1))
      .join("\n");

    // 备注：FreeMind 用 richcontent 标签承载 note
    const noteXml = node.note
      ? `\n${pad}  <richcontent TYPE="NOTE"><html><head></head><body><p>${escapeText(node.note)}</p></body></html></richcontent>`
      : "";

    if (childrenXml || noteXml) {
      const inner = [noteXml, childrenXml].filter(Boolean).join("\n");
      return `${pad}<node TEXT="${text}"${color}${link}>\n${inner}\n${pad}</node>`;
    }
    return `${pad}<node TEXT="${text}"${color}${link} />`;
  }

  const body = buildNode(root, 1);

  return `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.0.1">
${body}
</map>`;
}

/**
 * 下载文本内容为文件。
 * 桌面端走 Tauri 原生 save 对话框，浏览器模式回退到 a[download]。
 * 使用 data URL 以兼容 downloadMediaUrl 的输入要求。
 */
export async function downloadTextFile(
  content: string,
  filename: string,
  mimeType: string,
): Promise<void> {
  // 用 data URL 让 downloadMediaUrl 内部统一走 Tauri save 或浏览器下载
  const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
  await downloadMediaUrl(dataUrl, filename);
}
