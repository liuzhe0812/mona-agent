/**
 * OfficePreview — 通用 Office 文档预览组件。
 *
 * 使用 jit-viewer SDK 在前端渲染 docx / xlsx / pptx / pdf 等格式。
 * 通过 ArrayBuffer 加载文件二进制数据，由 SDK 在浏览器端解析渲染。
 */

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { createViewer, type ViewerInstance } from "jit-viewer";
import "jit-viewer/style.css";

export const OFFICE_PREVIEW_EXTS = new Set([
  "docx", "xlsx", "xls", "pptx", "ppt", "pdf", "ofd",
]);

export function isOfficePreviewable(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return OFFICE_PREVIEW_EXTS.has(ext);
}

interface OfficePreviewProps {
  /** 文件名（用于推断类型和下载名） */
  filename: string;
  /** 文件二进制数据获取函数，返回 ArrayBuffer */
  fetchBuffer: () => Promise<ArrayBuffer>;
}

export function OfficePreview({ filename, fetchBuffer }: OfficePreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerInstance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;

    setLoading(true);
    setError(null);

    const viewer = createViewer({
      target: container,
      filename,
      toolbar: true,
      theme: "light",
      width: "100%",
      height: "100%",
      onError: (err: Error) => {
        if (cancelled) return;
        setError(String(err.message || err));
        setLoading(false);
      },
      onReady: () => {
        if (cancelled) return;
        setLoading(false);
        // 将下载按钮从底部工具栏移到顶部工具栏右侧（全屏按钮左边）
        const moveDownloadBtn = () => {
          const el = container.querySelector(
            ".jv-toolbar__bottom .jv-toolbar-btn--download",
          );
          const topRight = container.querySelector(
            ".jv-toolbar__top .jv-toolbar__right",
          );
          if (el && topRight && !topRight.contains(el)) {
            topRight.appendChild(el);
          }
        };
        moveDownloadBtn();
        setTimeout(moveDownloadBtn, 200);
      },
    });
    viewerRef.current = viewer;
    viewer.mount();

    // Ctrl+滚轮缩放
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const current = viewer.getState()?.zoom ?? 1;
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      const next = Math.max(0.1, Math.min(5, +(current + delta).toFixed(2)));
      viewer.zoom(next);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });

    // 加载文件
    fetchBuffer()
      .then((buf) => {
        if (cancelled) return;
        viewer.setFile(buf, filename);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      container.removeEventListener("wheel", handleWheel);
      try {
        viewer.destroy();
      } catch {
        /* noop */
      }
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {loading ? (
        <div className="flex items-center justify-center py-8 text-[13px] text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在加载文档...
        </div>
      ) : null}
      {error ? (
        <div className="px-4 py-8 text-[13px] text-destructive">
          文档加载失败：{error}
        </div>
      ) : null}
      <div
        ref={containerRef}
        className="office-preview-host min-h-0 flex-1"
        style={{ display: error ? "none" : "flex", flexDirection: "column" }}
      />
    </div>
  );
}
