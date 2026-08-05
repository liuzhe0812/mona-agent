import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  List,
  Loader2,
  MessageSquareText,
  Play,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  ApiError,
  confirmPptPage,
  fetchPptPages,
  fetchPptPreviewPort,
  fetchPptOutline,
  savePptOutline,
  requestPptExport,
  getApiBase,
  type PptPageInfo,
  type PptOutlinePage,
} from "@/lib/api";
import { PptChatPanel } from "./PptChatPanel";
import type { PptChatPanelHandle } from "./PptChatPanel";
import type { Breakpoint } from "@/hooks/useBreakpoint";
import type {
  PptAnimationTrigger,
  PptEntranceAnimation,
  PptExportOptions,
  PptPageTransition,
} from "./PptMakerView";

interface PptProducingPhaseProps {
  projectName: string;
  token: string;
  chatId: string | null;
  displayContentMap: Record<string, string>;
  isStreaming: boolean;
  onStreamingChange: (streaming: boolean) => void;
  /** V3: page confirmed → request next page */
  onPageConfirmed: (
    confirmedPageId: string,
    confirmedPageIndex: number,
    nextPageId: string,
    nextPageIndex: number,
  ) => void;
  /** V3: page redo (with optional spec edit) */
  onPageRegenerate: (
    pageIndex: number,
    pageId: string,
    feedback?: string,
    pageSpec?: Record<string, unknown>,
  ) => void;
  /** V3: skip to generate a specific page */
  onPageGenerate: (pageIndex: number, pageId: string) => void;
  /** V3: all pages confirmed → request export */
  onAllConfirmed: () => void;
  /** Export options (editable in dialog before export) */
  exportOptions: PptExportOptions;
  setExportOptions: React.Dispatch<React.SetStateAction<PptExportOptions>>;
  /** Responsive breakpoint for layout adaptation */
  bp?: Breakpoint;
}

const PAGE_TRANSITION_OPTIONS: Array<{ value: PptPageTransition; label: string }> = [
  { value: "fade", label: "淡入淡出" },
  { value: "push", label: "推进" },
  { value: "wipe", label: "擦除" },
  { value: "split", label: "分割" },
  { value: "strips", label: "条带" },
  { value: "cover", label: "覆盖" },
  { value: "random", label: "随机" },
  { value: "none", label: "无过渡" },
];

const ENTRANCE_ANIMATION_OPTIONS: Array<{ value: PptEntranceAnimation; label: string }> = [
  { value: "auto", label: "自动（混合）" },
  { value: "none", label: "无入场动画" },
  { value: "fade", label: "淡入" },
  { value: "fly", label: "飞入" },
  { value: "zoom", label: "缩放" },
  { value: "wipe", label: "擦除" },
  { value: "mixed", label: "混合" },
];

const ANIMATION_TRIGGER_OPTIONS: Array<{ value: PptAnimationTrigger; label: string }> = [
  { value: "after-previous", label: "上一动画之后" },
  { value: "with-previous", label: "与上一动画同时" },
  { value: "on-click", label: "单击时" },
];

interface SpecEditState {
  pageIndex: number;
  pageId: string;
  title: string;
  bullets: string;
  visualType: string;
  layout: string;
  notes: string;
  feedback: string;
}

export function PptProducingPhase({
  projectName,
  token,
  chatId,
  displayContentMap,
  isStreaming,
  onStreamingChange,
  onPageConfirmed,
  onPageRegenerate,
  onPageGenerate,
  onAllConfirmed,
  exportOptions,
  setExportOptions,
  bp = "wide",
}: PptProducingPhaseProps) {
  const [pages, setPages] = useState<PptPageInfo[]>([]);
  const [outlinePages, setOutlinePages] = useState<PptOutlinePage[]>([]);
  const [outlineRevision, setOutlineRevision] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiBase, setApiBase] = useState("");
  const [specEdit, setSpecEdit] = useState<SpecEditState | null>(null);
  const [specExpanded, setSpecExpanded] = useState(true);
  const [svgObjectUrl, setSvgObjectUrl] = useState<string | null>(null);
  const [svgLoadState, setSvgLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [pageListSheetOpen, setPageListSheetOpen] = useState(false);
  const [chatSheetOpen, setChatSheetOpen] = useState(false);

  const chatPanelRef = useRef<PptChatPanelHandle>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    getApiBase().then(setApiBase);
  }, []);

  const loadPages = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchPptPages(token, projectName);
      setPages(res.pages);
      setOutlineRevision(res.outlineRevision);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载页面失败");
    } finally {
      setRefreshing(false);
    }
  }, [token, projectName]);

  const loadOutline = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchPptOutline(token, projectName);
      if (res.ok && res.pages) {
        setOutlinePages(
          (res.pages ?? []).map((p) => ({
            ...p,
            bullets: Array.isArray(p.bullets) ? p.bullets : [],
            title: p.title ?? "",
            visual_type: p.visual_type ?? "text_layout",
            layout: p.layout ?? "",
            notes: p.notes ?? "",
            summary: p.summary ?? "",
            image_plan: p.image_plan ?? "",
          })) as PptOutlinePage[],
        );
        setOutlineRevision(res.revision);
      }
    } catch {
      // outline may not be available yet
    }
  }, [token, projectName]);

  useEffect(() => {
    loadPages();
    loadOutline();
  }, [loadPages, loadOutline]);

  // Poll page list as long as the producing phase is open.
  // During streaming check every 2s so newly generated pages appear quickly;
  // otherwise 4s is enough for status updates.
  useEffect(() => {
    let stopped = false;

    async function tick() {
      if (stopped) return;
      await loadPages();
      if (stopped) return;
      pollTimerRef.current = setTimeout(tick, isStreaming ? 2000 : 4000);
    }

    tick();

    return () => {
      stopped = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [isStreaming, loadPages]);

  useEffect(() => {
    if (pages.length === 0) return;
    if (selectedIdx >= pages.length) setSelectedIdx(pages.length - 1);
  }, [pages.length, selectedIdx]);

  // Refresh immediately when streaming stops — the agent just wrote files.
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (wasStreaming && !isStreaming) {
      loadPages();
    }
  }, [isStreaming, loadPages]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadPages();
  }, [loadPages]);

  const selectedPage: PptPageInfo | null =
    selectedIdx >= 0 && selectedIdx < pages.length ? pages[selectedIdx] : null;

  const handleConfirm = useCallback(async () => {
    if (!selectedPage || selectedPage.mtime === null) return;
    setConfirming(true);
    setError(null);
    try {
      await confirmPptPage(token, projectName, selectedPage.file, selectedPage.mtime);
      await loadPages();
      // Auto-advance to next page
      const currentIdx = pages.findIndex((p) => p.file === selectedPage.file);
      if (currentIdx >= 0 && currentIdx < pages.length - 1) {
        const nextPage = pages[currentIdx + 1];
        const nextIdx = currentIdx + 2;
        onPageConfirmed(
          selectedPage.page,
          currentIdx + 1,
          nextPage.page,
          nextIdx,
        );
        setSelectedIdx(currentIdx + 1);
      } else {
        // Last page confirmed — all done
        // Will check allConfirmed below
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError("SVG 已变更，正在重新加载...");
        await loadPages();
        setError(null);
      } else {
        setError(e instanceof Error ? e.message : "确认失败");
      }
    } finally {
      setConfirming(false);
    }
  }, [token, projectName, selectedPage, loadPages, pages, onPageConfirmed]);

  const handleStartGenerate = useCallback(() => {
    if (!selectedPage) return;
    onPageGenerate(selectedIdx + 1, selectedPage.page);
  }, [selectedPage, selectedIdx, onPageGenerate]);

  const handleOpenRegenerate = useCallback(() => {
    if (!selectedPage) return;
    const outlinePage = outlinePages[selectedIdx];
    setSpecEdit({
      pageIndex: selectedIdx + 1,
      pageId: selectedPage.page,
      title: outlinePage?.title ?? selectedPage.title ?? "",
      bullets: (outlinePage?.bullets ?? []).join("\n"),
      visualType: outlinePage?.visual_type ?? "",
      layout: outlinePage?.layout ?? "",
      notes: outlinePage?.notes ?? "",
      feedback: "",
    });
  }, [selectedPage, selectedIdx, outlinePages]);

  const handleCancelRegenerate = useCallback(() => {
    setSpecEdit(null);
  }, []);

  const handleConfirmRegenerate = useCallback(async () => {
    if (!specEdit) return;
    // Build page spec object
    const pageSpec: Record<string, unknown> = {};
    if (specEdit.title) pageSpec.title = specEdit.title;
    if (specEdit.bullets.trim()) pageSpec.bullets = specEdit.bullets.split("\n").filter(Boolean);
    if (specEdit.visualType) pageSpec.visual_type = specEdit.visualType;
    if (specEdit.layout) pageSpec.layout = specEdit.layout;
    if (specEdit.notes) pageSpec.notes = specEdit.notes;

    // Update outline if spec changed
    if (outlinePages.length > 0 && outlineRevision > 0) {
      const updatedPages = [...outlinePages];
      if (updatedPages[specEdit.pageIndex - 1]) {
        updatedPages[specEdit.pageIndex - 1] = {
          ...updatedPages[specEdit.pageIndex - 1],
          title: specEdit.title,
          bullets: specEdit.bullets.split("\n").filter(Boolean),
          visual_type: specEdit.visualType,
          layout: specEdit.layout,
          notes: specEdit.notes,
        };
        try {
          await savePptOutline(token, projectName, outlineRevision, updatedPages);
        } catch {
          // revision conflict — proceed anyway, Agent will read from file
        }
      }
    }

    onPageRegenerate(
      specEdit.pageIndex,
      specEdit.pageId,
      specEdit.feedback || undefined,
      Object.keys(pageSpec).length > 0 ? pageSpec : undefined,
    );
    setSpecEdit(null);
  }, [specEdit, outlinePages, outlineRevision, token, projectName, onPageRegenerate]);

  // "全部确认导出"按钮：先弹出导出配置面板，用户确认后再执行导出
  const handleRequestExport = useCallback(() => {
    setShowExportDialog(true);
  }, []);

  // 用户在导出配置面板中确认后执行实际导出
  const handleConfirmExport = useCallback(async () => {
    setShowExportDialog(false);
    setExporting(true);
    setError(null);
    try {
      await requestPptExport(token, projectName);
      onAllConfirmed();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError(e.message || "存在未确认的页面");
        await loadPages();
      } else {
        setError(e instanceof Error ? e.message : "请求导出失败");
      }
    } finally {
      setExporting(false);
    }
  }, [token, projectName, onAllConfirmed, loadPages]);

  const handleOpenEditor = useCallback(() => {
    if (!projectName) return;
    fetchPptPreviewPort(token, projectName)
      .then((data: { port: number | null }) => {
        if (data.port) {
          window.open(`http://127.0.0.1:${data.port}`, "_blank");
        }
      })
      .catch(() => {});
  }, [token, projectName]);

  const confirmedCount = pages.filter((p) => p.state === "confirmed").length;
  const allConfirmed = pages.length > 0 && confirmedCount === pages.length;

  // 当前正在制作的页：AI 流式输出时，第一个未生成的页就是正在制作的页。
  // 不依赖 selectedIdx（用户可能选中了其他页查看），只反映真实制作进度。
  const producingIdx = isStreaming
    ? pages.findIndex((p) => p.state === "pending")
    : -1;
  const producingPage = producingIdx >= 0 ? pages[producingIdx] : null;

  const svgUrl =
    selectedPage && selectedPage.mtime !== null && apiBase
      ? `${apiBase}/api/ppt/project-svg?project=${encodeURIComponent(projectName)}&file=${encodeURIComponent(selectedPage.file)}&dir=output&token=${encodeURIComponent(token)}`
      : null;

  // Fetch selected SVG as a Blob URL so we can render it via <img>.
  // This mirrors PptPreview: it lets us sanitize malformed XML entities
  // defensively and avoids the strict XML parsing of <object>.
  useEffect(() => {
    if (!svgUrl) {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      setSvgObjectUrl(null);
      setSvgLoadState("idle");
      return;
    }

    let cancelled = false;

    function sanitizeSvgXml(text: string): string {
      const xmlBuiltin = new Set(["amp", "lt", "gt", "quot", "apos"]);
      text = text.replace(
        /&([A-Za-z_][A-Za-z0-9_]*|#[0-9]+|#x[0-9A-Fa-f]+);/g,
        (match, ref) => {
          if (xmlBuiltin.has(ref)) return match;
          if (/^#[0-9]+$/.test(ref) || /^#x[0-9A-Fa-f]+$/i.test(ref)) return match;
          const textarea = document.createElement("textarea");
          textarea.innerHTML = match;
          const expanded = textarea.value;
          if (expanded !== match) return expanded;
          return `&amp;${ref};`;
        },
      );
      text = text.replace(
        /&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9A-Fa-f]+;)/g,
        "&amp;",
      );
      text = text.replace(/<(?![A-Za-z/!?])/g, "&lt;");
      text = text.replace(/]]>/g, "]]&gt;");
      return text;
    }

    async function fetchSvg() {
      setSvgLoadState("loading");
      try {
        const res = await fetch(svgUrl!);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let text = await res.text();
        text = sanitizeSvgXml(text);
        const blob = new Blob([text], { type: "image/svg+xml;charset=utf-8" });
        const objectUrl = URL.createObjectURL(blob);
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = objectUrl;
        if (!cancelled) {
          setSvgObjectUrl(objectUrl);
          setSvgLoadState("loaded");
        }
      } catch {
        if (!cancelled) {
          setSvgLoadState("error");
          setSvgObjectUrl(null);
        }
      }
    }

    fetchSvg();

    return () => {
      cancelled = true;
    };
  }, [svgUrl]);

  // Shared page-list content (rendered inline on wide/medium, in Sheet on narrow)
  const pageListContent = (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-3 py-2">
        <span className="text-[12px] font-medium text-foreground">页面</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {confirmedCount}/{pages.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto scrollbar-hover p-2">
        {pages.map((page, idx) => (
          <button
            key={`${page.page}-${idx}`}
            onClick={() => {
              setSelectedIdx(idx);
              setPageListSheetOpen(false);
            }}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
              selectedIdx === idx
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            aria-label={`第 ${idx + 1} 页 ${page.title || "未命名"}，${
              page.state === "confirmed"
                ? "已确认"
                : producingIdx === idx
                  ? "正在生成"
                  : page.state === "previewing"
                    ? "待确认"
                    : "未生成"
            }`}
          >
            <span className="shrink-0 text-[10px] font-medium tabular-nums">
              {String(idx + 1).padStart(2, "0")}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {page.title || "未命名"}
            </span>
            {page.state === "confirmed" ? (
              <Check className="h-3 w-3 shrink-0 text-emerald-500" aria-hidden />
            ) : producingIdx === idx ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-hidden />
            ) : page.state === "previewing" ? (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                aria-label="待确认"
                role="img"
              />
            ) : (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/30"
                aria-label="未生成"
                role="img"
              />
            )}
          </button>
        ))}
        {pages.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-2 py-8 text-[11px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin opacity-50" />
            <span>等待页面生成...</span>
          </div>
        )}
      </div>
      {/* Progress bar */}
      {pages.length > 0 && (
        <div className="shrink-0 border-t border-border/70 px-3 py-2">
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${(confirmedCount / pages.length) * 100}%` }}
            />
          </div>
        </div>
      )}
    </>
  );

  const showPageListInline = bp !== "narrow";
  const showChatInline = bp === "wide";

  return (
    <div className="flex h-full">
      {/* Left: page list — inline on wide/medium, Sheet on narrow */}
      {showPageListInline ? (
        <div className="flex w-[200px] shrink-0 flex-col border-r border-border/70">
          {pageListContent}
        </div>
      ) : (
        <Sheet open={pageListSheetOpen} onOpenChange={setPageListSheetOpen}>
          <SheetContent side="left" className="flex w-[240px] flex-col p-0 sm:max-w-[240px]">
            <SheetHeader className="sr-only">
              <SheetTitle>页面列表</SheetTitle>
            </SheetHeader>
            {pageListContent}
          </SheetContent>
        </Sheet>
      )}

      {/* Middle: SVG preview + action bar */}
      <div className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        )}

        {/* Page spec info panel (collapsible) */}
        {selectedPage && !specEdit && (
          <div className="shrink-0 border-b border-border/70 bg-background/50">
            <button
              onClick={() => setSpecExpanded((v) => !v)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {specExpanded ? (
                <ChevronUp className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronDown className="h-3 w-3 shrink-0" />
              )}
              <span className="font-medium text-foreground">
                第 {selectedIdx + 1} 页规格
              </span>
              <span className="truncate text-[11px]">
                {outlinePages[selectedIdx]?.title || selectedPage.title || "未命名"}
              </span>
              {outlinePages[selectedIdx]?.visual_type && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                  {outlinePages[selectedIdx].visual_type}
                </span>
              )}
            </button>
            {specExpanded && outlinePages[selectedIdx] && (
              <div className="max-h-[200px] space-y-1.5 overflow-y-auto scrollbar-thin px-3 pb-2 text-[11px]">
                {outlinePages[selectedIdx].bullets.length > 0 && (
                  <div>
                    <span className="text-muted-foreground">要点：</span>
                    <span className="text-foreground">
                      {outlinePages[selectedIdx].bullets.join(" · ")}
                    </span>
                  </div>
                )}
                {outlinePages[selectedIdx].summary && (
                  <div>
                    <span className="text-muted-foreground">概要：</span>
                    <span className="text-foreground">{outlinePages[selectedIdx].summary}</span>
                  </div>
                )}
                {outlinePages[selectedIdx].layout && (
                  <div>
                    <span className="text-muted-foreground">布局：</span>
                    <span className="text-foreground">{outlinePages[selectedIdx].layout}</span>
                  </div>
                )}
                {outlinePages[selectedIdx].image_plan && (
                  <div>
                    <span className="text-muted-foreground">图片：</span>
                    <span className="text-foreground">{outlinePages[selectedIdx].image_plan}</span>
                  </div>
                )}
                {outlinePages[selectedIdx].notes && (
                  <div>
                    <span className="text-muted-foreground">备注：</span>
                    <span className="text-foreground">{outlinePages[selectedIdx].notes}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* SVG display or spec edit panel */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4">
          {specEdit ? (
            <div className="flex h-full w-full max-w-[520px] flex-col gap-3 overflow-y-auto scrollbar-hover p-4">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-foreground">
                  重新生成第 {specEdit.pageIndex} 页
                </span>
                <button
                  onClick={handleCancelRegenerate}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-2">
                <label className="text-[11px] text-muted-foreground">标题</label>
                <Input
                  value={specEdit.title}
                  onChange={(e) => setSpecEdit({ ...specEdit, title: e.target.value })}
                  className="h-8 text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] text-muted-foreground">要点（每行一条）</label>
                <Textarea
                  value={specEdit.bullets}
                  onChange={(e) => setSpecEdit({ ...specEdit, bullets: e.target.value })}
                  className="min-h-[60px] resize-none text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] text-muted-foreground">视觉类型</label>
                <Input
                  value={specEdit.visualType}
                  onChange={(e) => setSpecEdit({ ...specEdit, visualType: e.target.value })}
                  className="h-8 text-[12px]"
                  placeholder="如：text_layout / chart / flowchart"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] text-muted-foreground">布局描述</label>
                <Input
                  value={specEdit.layout}
                  onChange={(e) => setSpecEdit({ ...specEdit, layout: e.target.value })}
                  className="h-8 text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] text-muted-foreground">备注</label>
                <Input
                  value={specEdit.notes}
                  onChange={(e) => setSpecEdit({ ...specEdit, notes: e.target.value })}
                  className="h-8 text-[12px]"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] text-muted-foreground">补充说明（可选）</label>
                <Textarea
                  value={specEdit.feedback}
                  onChange={(e) => setSpecEdit({ ...specEdit, feedback: e.target.value })}
                  className="min-h-[40px] resize-none text-[12px]"
                  placeholder="如：图表颜色用品牌主色..."
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" size="sm" onClick={handleCancelRegenerate} className="h-7 text-[11px]">
                  取消
                </Button>
                <Button size="sm" onClick={handleConfirmRegenerate} className="h-7 gap-1 text-[11px]">
                  <RotateCw className="h-3 w-3" />
                  按新规格重做
                </Button>
              </div>
            </div>
          ) : !svgUrl ? (
            <div className="flex flex-col items-center gap-3 text-[13px] text-muted-foreground">
              {producingPage ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span>正在制作第 {producingIdx + 1} 页...</span>
                  {producingPage.title && (
                    <span className="max-w-[320px] truncate text-[11px] opacity-70">
                      {producingPage.title}
                    </span>
                  )}
                </>
              ) : isStreaming ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin opacity-50" />
                  <span>正在处理...</span>
                </>
              ) : (
                <>
                  <Play className="h-5 w-5 opacity-40" />
                  <span>{selectedPage ? "该页面尚未生成" : "选择左侧页面进行预览"}</span>
                </>
              )}
            </div>
          ) : svgLoadState === "loading" ? (
            <div className="flex flex-col items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>正在加载幻灯片…</span>
            </div>
          ) : svgLoadState === "error" || !svgObjectUrl ? (
            <div className="flex flex-col items-center gap-2 text-[13px] text-muted-foreground">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <span>幻灯片加载失败</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefresh}
                disabled={refreshing}
                className="h-6 gap-1 text-[11px]"
              >
                <RefreshCw className="h-3 w-3" />
                重试
              </Button>
            </div>
          ) : (
            <img
              src={svgObjectUrl}
              alt={selectedPage?.file ?? ""}
              className="max-h-full max-w-full rounded shadow-md"
              draggable={false}
              onError={() => setSvgLoadState("error")}
            />
          )}
        </div>

        {/* Action bar — allow wrapping on narrow screens */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/70 px-3 py-2">
          <div className="flex items-center gap-1">
            {/* Narrow: page list toggle */}
            {bp === "narrow" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPageListSheetOpen(true)}
                className="h-7 gap-1 px-2 text-[11px]"
                aria-label="打开页面列表"
              >
                <List className="h-3.5 w-3.5" />
                页面
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRefresh}
              disabled={refreshing}
              className="h-7 w-7"
              title="刷新"
              aria-label="刷新页面列表"
            >
              {refreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleOpenEditor}
              className="h-7 w-7"
              title="在高级编辑器中打开"
              aria-label="在高级编辑器中打开"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="flex items-center gap-1">
            {/* Narrow/medium: chat toggle */}
            {!showChatInline && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setChatSheetOpen(true)}
                className="h-7 gap-1 px-2 text-[11px]"
                aria-label="与 AI 讨论"
              >
                <MessageSquareText className="h-3.5 w-3.5" />
                与 AI 讨论
              </Button>
            )}
            {selectedPage?.state === "pending" && !isStreaming && !specEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleStartGenerate}
                className="h-7 gap-1 px-2 text-[11px]"
              >
                <Play className="h-3 w-3" />
                生成本页
              </Button>
            )}
            {selectedPage && selectedPage.state !== "pending" && !specEdit && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenRegenerate}
                disabled={isStreaming}
                className="h-7 gap-1 px-2 text-[11px]"
              >
                <RotateCw className="h-3 w-3" />
                重新生成
              </Button>
            )}
            {allConfirmed ? (
              <Button
                size="sm"
                onClick={handleRequestExport}
                disabled={exporting || isStreaming || !!specEdit}
                className="h-7 gap-1 px-2 text-[11px]"
              >
                {exporting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <CheckCheck className="h-3 w-3" />
                )}
                导出 PPTX
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleConfirm}
                disabled={
                  confirming ||
                  !selectedPage ||
                  selectedPage.state !== "previewing" ||
                  isStreaming ||
                  !!specEdit
                }
                className="h-7 gap-1 px-2 text-[11px]"
              >
                {confirming ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                通过并继续
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Right: chat panel — inline on wide, Sheet on medium/narrow */}
      {showChatInline ? (
        <div className="flex w-[360px] shrink-0 flex-col border-l border-border/70">
          <PptChatPanel
            key={chatId ?? "empty"}
            chatId={chatId}
            onStreamingChange={onStreamingChange}
            displayContentMap={displayContentMap}
            ref={chatPanelRef}
          />
        </div>
      ) : (
        <Sheet open={chatSheetOpen} onOpenChange={setChatSheetOpen}>
          <SheetContent side="right" className="flex w-[360px] flex-col p-0 sm:max-w-[360px]">
            <SheetHeader className="sr-only">
              <SheetTitle>与 AI 讨论</SheetTitle>
            </SheetHeader>
            <PptChatPanel
              key={chatId ?? "empty"}
              chatId={chatId}
              onStreamingChange={onStreamingChange}
              displayContentMap={displayContentMap}
              ref={chatPanelRef}
            />
          </SheetContent>
        </Sheet>
      )}

      {/* 导出配置面板：全部确认后弹出，默认只显示生成 PPTX 按钮，高级选项折叠 */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>导出 PPTX</DialogTitle>
            <DialogDescription>
              所有页面已确认。点击"生成 PPTX"开始导出。
            </DialogDescription>
          </DialogHeader>

          <details className="group rounded-md border border-border/60 px-3 py-2">
            <summary className="cursor-pointer text-[12px] font-medium text-muted-foreground hover:text-foreground">
              高级演示设置
            </summary>
            <div className="space-y-3 pt-3">
              {/* 页面过渡 */}
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-foreground">页面过渡</label>
                <div className="flex flex-wrap gap-1">
                  {PAGE_TRANSITION_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={cn(
                        "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                        exportOptions.pageTransition === opt.value
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                      onClick={() =>
                        setExportOptions((prev) => ({ ...prev, pageTransition: opt.value }))
                      }
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 入场动画 */}
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-foreground">入场动画</label>
                <div className="flex flex-wrap gap-1">
                  {ENTRANCE_ANIMATION_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={cn(
                        "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                        exportOptions.entranceAnimation === opt.value
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                      onClick={() =>
                        setExportOptions((prev) => ({ ...prev, entranceAnimation: opt.value }))
                      }
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 动画触发 */}
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-foreground">动画触发方式</label>
                <div className="flex gap-1">
                  {ANIMATION_TRIGGER_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={cn(
                        "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                        exportOptions.animationTrigger === opt.value
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                      onClick={() =>
                        setExportOptions((prev) => ({ ...prev, animationTrigger: opt.value }))
                      }
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 自动翻页 */}
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-foreground">
                  自动翻页
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                    （秒，留空则不自动翻页）
                  </span>
                </label>
                <Input
                  type="number"
                  min={1}
                  max={300}
                  className="h-8 w-24 text-[12px]"
                  value={exportOptions.autoAdvance ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setExportOptions((prev) => ({
                      ...prev,
                      autoAdvance: v === "" ? null : Math.max(1, Math.min(300, parseInt(v) || 1)),
                    }));
                  }}
                  placeholder="手动"
                />
              </div>

              {/* 旁白 + 合并段落 */}
              <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
                <label className="flex items-center gap-2 text-[12px] text-foreground">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-border"
                    checked={exportOptions.enableNarration}
                    onChange={(e) =>
                      setExportOptions((prev) => ({ ...prev, enableNarration: e.target.checked }))
                    }
                  />
                  为演示生成旁白音频
                </label>
                <label className="flex items-center gap-2 text-[12px] text-foreground">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-border"
                    checked={exportOptions.mergeParagraphs}
                    onChange={(e) =>
                      setExportOptions((prev) => ({ ...prev, mergeParagraphs: e.target.checked }))
                    }
                  />
                  合并连续文本段落
                </label>
              </div>
            </div>
          </details>

          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowExportDialog(false)}
              className="h-8 text-[12px]"
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={handleConfirmExport}
              disabled={exporting}
              className="h-8 gap-1 text-[12px]"
            >
              {exporting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  导出中...
                </>
              ) : (
                <>
                  <CheckCheck className="h-3.5 w-3.5" />
                  生成 PPTX
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
