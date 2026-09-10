/**
 * 资料库预览面板：根据选中项渲染文本预览、Office 预览或 Wiki markdown。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Loader2 } from "lucide-react";

import { PdfPreview } from "@/components/common/PdfPreview";
import { OfficeFileEditor, officeDocumentType } from "@/components/office/OfficeFileEditor";
import { getServicesHttpBase } from "@/lib/api";
import { httpFetch } from "@/lib/tauri";
import {
  getMaterialsText,
  getMaterialsRawFile,
  getEvidenceDetail,
  getWikiPage,
} from "@/lib/materials-api";
import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";
import { useMaterialsOpenStore } from "@/lib/materials-open-store";
import type { MaterialsPreviewProps } from "./types";

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export function MaterialsPreview({ selection }: MaterialsPreviewProps) {
  if (!selection) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        选择左侧资料查看内容
      </div>
    );
  }
  return selection.kind === "raw" ? (
    <RawPreview path={selection.path} knowledgeBaseId={selection.knowledgeBaseId} agentId={selection.agentId} />
  ) : (
    <WikiPreview path={selection.path} knowledgeBaseId={selection.knowledgeBaseId} agentId={selection.agentId} />
  );
}

// 可直接读取原文预览的扩展名
const DIRECT_PREVIEW_EXTS = new Set(["md", "markdown", "html", "htm", "txt", "csv", "json", "xml", "yaml", "yml", "log", "py", "js", "ts", "css", "sh", "toml"]);

function getExt(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function rawPathToTextPath(rawRel: string): string {
  const stripped = rawRel.replace(/^raw\//, "");
  return `text/${stripped}.md`;
}

function RawPreview({ path, knowledgeBaseId, agentId }: { path: string; knowledgeBaseId?: string; agentId?: string }) {
  const rawRel = path.replace(/^raw\//, "");
  const ext = getExt(rawRel);
  const isOffice = !!officeDocumentType(rawRel);
  const isDirect = DIRECT_PREVIEW_EXTS.has(ext);
  const isImage = ["png", "jpg", "jpeg", "webp"].includes(ext);

  // 引用跳转带位置时强制走文本预览（提取文本含 seg 标题，可滚动定位），
  // 否则 Office 原文预览无法定位到 Page/Sheet。
  // 位置标签捕获到本地 state 后立即清除全局 pending：避免已消费的请求
  // 残留导致用户之后手动选中同一文件时仍被强制文本预览。
  const pending = useMaterialsOpenStore((s) => s.pending);
  const [captured, setCaptured] = useState<{ nonce: number; location: string } | null>(null);

  useEffect(() => {
    if (!pending || pending.kind !== "raw" || pending.path !== path) return;
    if (pending.agentId && pending.agentId !== agentId) return;
    if (pending.knowledgeBaseId && pending.knowledgeBaseId !== knowledgeBaseId) return;
    if (pending.location) {
      setCaptured({ nonce: pending.nonce, location: pending.location });
    }
    useMaterialsOpenStore.getState().clear();
  }, [agentId, pending, path, knowledgeBaseId]);

  // 切换文件后丢弃旧的捕获位置
  useEffect(() => {
    setCaptured(null);
  }, [path]);

  const forceText = captured !== null;

  if ((isOffice || ext === "pdf") && !forceText) {
    return <OfficeRawPreview path={path} knowledgeBaseId={knowledgeBaseId} agentId={agentId} />;
  }
  if (isImage && !forceText) {
    return <ImageRawPreview path={path} knowledgeBaseId={knowledgeBaseId} agentId={agentId} />;
  }

  return (
    <TextRawPreview
      path={path}
      rawRel={rawRel}
      ext={ext}
      isDirect={isDirect && !forceText}
      scrollToLabel={captured?.location}
      scrollNonce={captured?.nonce}
      knowledgeBaseId={knowledgeBaseId}
      agentId={agentId}
    />
  );
}

function ImageRawPreview({ path, knowledgeBaseId, agentId }: { path: string; knowledgeBaseId?: string; agentId?: string }) {
  const rawRel = path.replace(/^raw\//, "");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const base = await getServicesHttpBase();
        const query = agentId
          ? `?agentId=${encodeURIComponent(agentId)}`
          : knowledgeBaseId
            ? `?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`
            : "";
        const response = await httpFetch(
          `${base}/api/materials/raw-binary/${encodeURIComponent(rawRel)}${query}`,
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        objectUrl = URL.createObjectURL(await response.blob());
        if (!cancelled) setUrl(objectUrl);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "无法读取图片");
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [agentId, knowledgeBaseId, rawRel]);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-6">
      {error ? <span className="text-caption text-destructive">{error}</span> : null}
      {!error && !url ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
      {url ? <img src={url} alt={rawRel} className="max-h-full max-w-full object-contain" /> : null}
    </div>
  );
}

function OfficeRawPreview({ path, knowledgeBaseId, agentId }: { path: string; knowledgeBaseId?: string; agentId?: string }) {
  const rawRel = path.replace(/^raw\//, "");
  const [toolbarContainer, setToolbarContainer] = useState<HTMLDivElement | null>(null);
  const fetchBuffer = useCallback(async () => {
    const base = await getServicesHttpBase();
    // 必须走 httpFetch（Tauri 本地桥）：裸 fetch 不会附带 X-Mona-Token，会 401
    const query = agentId
      ? `?agentId=${encodeURIComponent(agentId)}`
      : knowledgeBaseId
        ? `?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`
        : "";
    const resp = await httpFetch(`${base}/api/materials/raw-binary/${encodeURIComponent(rawRel)}${query}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.arrayBuffer();
  }, [agentId, rawRel, knowledgeBaseId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px]">{rawRel}</span>
        <div ref={setToolbarContainer} className="flex shrink-0 items-center" />
      </div>
      {getExt(rawRel) === "pdf" ? (
        <PdfPreview key={`${agentId ?? knowledgeBaseId}:${rawRel}`} filename={rawRel} fetchBuffer={fetchBuffer} />
      ) : (
        <OfficeFileEditor
          key={`${agentId ?? knowledgeBaseId}:${rawRel}`}
          filename={rawRel.replace(/\\/g, "/").split("/").pop()!}
          sourceIdentity={`materials:${agentId ?? knowledgeBaseId ?? "default"}:${rawRel}`}
          ownerSessionKey={`materials:${agentId ?? knowledgeBaseId ?? "default"}`}
          fetchBuffer={fetchBuffer}
          toolbarContainer={toolbarContainer}
        />
      )}
    </div>
  );
}

function TextRawPreview({
  path,
  rawRel,
  ext,
  isDirect,
  scrollToLabel,
  scrollNonce,
  knowledgeBaseId,
  agentId,
}: {
  path: string;
  rawRel: string;
  ext: string;
  isDirect: boolean;
  scrollToLabel?: string;
  scrollNonce?: number;
  knowledgeBaseId?: string;
  agentId?: string;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"text" | "markdown" | "html">("text");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  // 引用定位：提取文本中 seg 标题形如 "## Page 12"，按行精确匹配后拆分内容，
  // 在目标行处插入锚点 <span>，渲染完成后 scrollIntoView。
  const split = useMemo(() => {
    if (!scrollToLabel || !content) return null;
    const heading = `## ${scrollToLabel}`.trim().toLowerCase();
    const lines = content.split("\n");
    const idx = lines.findIndex((l) => l.trim().toLowerCase() === heading);
    if (idx < 0) return null;
    return {
      before: lines.slice(0, idx).join("\n") + "\n",
      after: lines.slice(idx).join("\n"),
    };
  }, [content, scrollToLabel]);

  useEffect(() => {
    if (!split || !anchorRef.current) return;
    anchorRef.current.scrollIntoView({ block: "start" });
  }, [split, scrollNonce]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    setPreviewMode("text");
    (async () => {
      try {
        if (isDirect) {
          // md/html/txt 等文本格式：直接读取 raw 原文
          const data = await getMaterialsRawFile(rawRel, knowledgeBaseId, agentId);
          if (cancelled) return;
          setContent(data.content);
          if (ext === "md" || ext === "markdown") {
            setPreviewMode("markdown");
          } else if (ext === "html" || ext === "htm") {
            setPreviewMode("html");
          } else {
            setPreviewMode("text");
          }
        } else {
          // pdf/docx/xlsx/pptx 等：读取提取后的文本
          const textPath = rawPathToTextPath(path);
          const data = await getMaterialsText(textPath, knowledgeBaseId, agentId);
          if (cancelled) return;
          // 去掉 frontmatter
          let text = data.content;
          if (text.startsWith("---")) {
            const end = text.indexOf("---", 3);
            if (end !== -1) text = text.slice(end + 3).trimStart();
          }
          setContent(text);
          setPreviewMode("text");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, path, rawRel, ext, isDirect, knowledgeBaseId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="truncate text-[13px]">{rawRel}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 scrollbar-hover">
        {loading ? (
          <div className="flex items-center text-[13px] text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在读取...
          </div>
        ) : error ? (
          <div className="text-[13px] text-muted-foreground">
            {isDirect
              ? "无法读取文件内容。"
              : "暂无可读正文。可能原因：文件尚未提取、格式不支持或提取失败。"}
            <div className="mt-1 text-[12px] text-destructive">{error}</div>
          </div>
        ) : previewMode === "markdown" ? (
          <MarkdownTextRenderer>{content ?? ""}</MarkdownTextRenderer>
        ) : previewMode === "html" ? (
          <iframe
            srcDoc={content ?? ""}
            title={rawRel}
            // 用户上传的 HTML 属不可信内容：空 sandbox 禁用脚本且强制独立源，
            // 禁止 allow-scripts 与 allow-same-origin 组合（P0-1 / ui-spec）。
            sandbox=""
            className="h-full min-h-[400px] w-full border-0"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed">
            {split ? (
              <>
                {split.before}
                <span ref={anchorRef} className="block h-0 scroll-mt-2" />
                {split.after}
              </>
            ) : (
              content ?? ""
            )}
          </pre>
        )}
      </div>
    </div>
  );
}

function WikiPreview({ path, knowledgeBaseId, agentId }: { path: string; knowledgeBaseId?: string; agentId?: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidenceLinks, setEvidenceLinks] = useState<Record<string, string>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 引用跳转（wiki）：捕获位置标签后立即清除全局 pending，
  // 渲染完成后在 markdown 标题中定位并滚动。
  const pending = useMaterialsOpenStore((s) => s.pending);
  const [captured, setCaptured] = useState<{ nonce: number; location: string } | null>(null);

  useEffect(() => {
    if (!pending || pending.kind !== "wiki" || pending.path !== path) return;
    if (pending.agentId && pending.agentId !== agentId) return;
    if (pending.knowledgeBaseId && pending.knowledgeBaseId !== knowledgeBaseId) return;
    if (pending.location) {
      setCaptured({ nonce: pending.nonce, location: pending.location });
    }
    useMaterialsOpenStore.getState().clear();
  }, [agentId, pending, path, knowledgeBaseId]);

  useEffect(() => {
    setCaptured(null);
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    (async () => {
      try {
        const data = await getWikiPage(path, knowledgeBaseId, agentId);
        if (!cancelled) setContent(data.content);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, path, knowledgeBaseId]);

  useEffect(() => {
    let cancelled = false;
    const ids = Array.from(
      new Set(Array.from((content ?? "").matchAll(/\[\[evidence:(ev-[a-f0-9]+)\]\]/g), (match) => match[1])),
    );
    if (ids.length === 0) {
      setEvidenceLinks({});
      return () => { cancelled = true; };
    }
    void Promise.all(ids.map(async (id) => {
      try {
        const detail = await getEvidenceDetail(id, knowledgeBaseId, agentId);
        const params = new URLSearchParams({
          ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
          ...(agentId ? { agentId } : {}),
          path: `raw/${detail.source}`,
          location: detail.label,
        });
        return [id, `mona:material?${params.toString()}`] as const;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (cancelled) return;
      setEvidenceLinks(Object.fromEntries(entries.filter((entry) => entry !== null)));
    });
    return () => { cancelled = true; };
  }, [agentId, content, knowledgeBaseId]);

  const body = useMemo(() => {
    if (!content) return "";
    let value = content;
    if (content.startsWith("---")) {
      const end = content.indexOf("---", 3);
      if (end !== -1) value = content.slice(end + 3).trimStart();
    }
    return value.replace(
      /\[\[evidence:(ev-[a-f0-9]+)\]\]/g,
      (marker, id: string) => evidenceLinks[id] ? `[证据](${evidenceLinks[id]})` : marker,
    );
  }, [content, evidenceLinks]);

  useEffect(() => {
    if (!captured || !body || !containerRef.current) return;
    const label = captured.location.trim().toLowerCase();
    const headings = containerRef.current.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (const h of Array.from(headings)) {
      const text = h.textContent?.trim().toLowerCase() ?? "";
      if (text === label || text.includes(label)) {
        h.scrollIntoView({ block: "start" });
        return;
      }
    }
  }, [captured, body]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="truncate text-[13px]">{path}</span>
      </div>
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4 scrollbar-hover"
      >
        {loading ? (
          <div className="flex items-center text-[13px] text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在读取...
          </div>
        ) : error ? (
          <div className="text-[13px] text-destructive">{error}</div>
        ) : (
          <MarkdownTextRenderer>{body}</MarkdownTextRenderer>
        )}
      </div>
    </div>
  );
}
