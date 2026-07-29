import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * 把 Markdown 渲染成独立 HTML 片段，用于导出 PDF / 打印等离线场景。
 * 复用 react-markdown + remark-gfm + remark-breaks，不依赖 tauri / store 等客户端环境。
 */
export function markdownToHtml(markdown: string): string {
  const container = document.createElement("div");
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <ReactMarkdown remarkPlugins={[remarkBreaks, remarkGfm]}>
        {markdown}
      </ReactMarkdown>,
    );
  });
  const html = container.innerHTML;
  root.unmount();
  return html;
}
