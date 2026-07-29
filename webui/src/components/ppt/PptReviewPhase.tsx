import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCheck,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ApiError,
  confirmPptPage,
  fetchPptPages,
  fetchPptPreviewPort,
  regeneratePptPage,
  requestPptExport,
  getApiBase,
  type PptPageInfo,
} from "@/lib/api";
import { PptChatPanel } from "./PptChatPanel";
import type { PptChatPanelHandle } from "./PptChatPanel";

interface PptReviewPhaseProps {
  projectName: string;
  token: string;
  chatId: string | null;
  displayContentMap: Record<string, string>;
  isStreaming: boolean;
  onStreamingChange: (streaming: boolean) => void;
  /** V2 §5.4: single page regenerate — wake up Agent */
  onRegenerate: (file: string) => void;
  /** V2 §5.5: all pages confirmed — request export via Agent */
  onAllConfirmed: () => void;
}

export function PptReviewPhase({
  projectName,
  token,
  chatId,
  displayContentMap,
  isStreaming,
  onStreamingChange,
  onRegenerate,
  onAllConfirmed,
}: PptReviewPhaseProps) {
  const [pages, setPages] = useState<PptPageInfo[]>([]);
  const [reviewReady, setReviewReady] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiBase, setApiBase] = useState("");

  const chatPanelRef = useRef<PptChatPanelHandle>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getApiBase().then(setApiBase);
  }, []);

  const loadPages = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchPptPages(token, projectName);
      setPages(res.pages);
      setReviewReady(res.reviewReady);
      setError(null);
      return;
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载页面失败");
      return;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, projectName]);

  // Initial load
  useEffect(() => {
    loadPages();
  }, [loadPages]);

  // Poll while agent is streaming (producing SVGs) or review gate not yet ready
  useEffect(() => {
    if (!isStreaming && reviewReady) return;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(async () => {
      await loadPages();
    }, 3000);
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [isStreaming, reviewReady, loadPages]);

  // Clamp selectedIdx
  useEffect(() => {
    if (pages.length === 0) return;
    if (selectedIdx >= pages.length) setSelectedIdx(pages.length - 1);
  }, [pages.length, selectedIdx]);

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
  }, [token, projectName, selectedPage, loadPages]);

  const handleRegenerate = useCallback(async () => {
    if (!selectedPage) return;
    setRegenerating(true);
    setError(null);
    try {
      await regeneratePptPage(token, projectName, selectedPage.file);
      onRegenerate(selectedPage.file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求重做失败");
    } finally {
      setRegenerating(false);
    }
  }, [token, projectName, selectedPage, onRegenerate]);

  const handleRequestExport = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      await requestPptExport(token, projectName);
      onAllConfirmed();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError(e.message || "存在未确认的页面或计划外文件");
        await loadPages();
      } else {
        setError(e instanceof Error ? e.message : "请求导出失败");
      }
    } finally {
      setExporting(false);
    }
  }, [token, projectName, onAllConfirmed, loadPages]);

  const confirmedCount = pages.filter((p) => p.state === "confirmed").length;
  const allConfirmed =
    pages.length > 0 && confirmedCount === pages.length && reviewReady;

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="text-[13px] text-muted-foreground">正在加载页面...</span>
      </div>
    );
  }

  // Build SVG URL for the selected page
  const svgUrl =
    selectedPage && selectedPage.mtime !== null && apiBase
      ? `${apiBase}/api/ppt/project-svg?project=${encodeURIComponent(projectName)}&file=${encodeURIComponent(selectedPage.file)}&dir=output&token=${encodeURIComponent(token)}`
      : null;

  // Open Flask SVG Editor in new window
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

  return (
    <div className="flex h-full">
      {/* Left: page list (200px) */}
      <div className="flex w-[200px] shrink-0 flex-col border-r border-border/70">
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
              onClick={() => setSelectedIdx(idx)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
                selectedIdx === idx
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <span className="shrink-0 text-[10px] font-medium tabular-nums">
                {String(idx + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {page.title || "未命名"}
              </span>
              {page.state === "confirmed" ? (
                <Check className="h-3 w-3 shrink-0 text-emerald-500" />
              ) : page.state === "previewing" ? (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                  title="待确认"
                />
              ) : (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/30"
                  title="未生成"
                />
              )}
            </button>
          ))}
          {pages.length === 0 && (
            <div className="px-2 py-4 text-center text-[11px] text-muted-foreground">
              暂无页面
            </div>
          )}
        </div>
      </div>

      {/* Middle: SVG preview + action bar */}
      <div className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        )}

        {/* SVG display */}
        <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4">
          {svgUrl ? (
            <object
              data={svgUrl}
              type="image/svg+xml"
              className="max-h-full max-w-full rounded shadow-md"
            >
              <img
                src={svgUrl}
                alt={selectedPage?.file ?? ""}
                className="max-h-full max-w-full rounded shadow-md"
                draggable={false}
              />
            </object>
          ) : (
            <div className="flex flex-col items-center gap-2 text-[13px] text-muted-foreground">
              <RotateCw className="h-5 w-5 opacity-40" />
              <span>{selectedPage ? "该页面尚未生成" : "选择左侧页面进行预览"}</span>
            </div>
          )}
        </div>

        {/* Action bar */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-3 py-2">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
              className="h-7 gap-1 px-2 text-[11px]"
            >
              {refreshing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              刷新
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleOpenEditor}
              className="h-7 gap-1 px-2 text-[11px]"
            >
              <ExternalLink className="h-3 w-3" />
              SVG Editor
            </Button>
          </div>

          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRegenerate}
              disabled={regenerating || !selectedPage || isStreaming}
              className="h-7 gap-1 px-2 text-[11px]"
            >
              {regenerating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RotateCw className="h-3 w-3" />
              )}
              重新生成
            </Button>
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={
                confirming ||
                !selectedPage ||
                selectedPage.state !== "previewing" ||
                isStreaming
              }
              className="h-7 gap-1 px-2 text-[11px]"
            >
              {confirming ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              确认本页
            </Button>
            <Button
              size="sm"
              onClick={handleRequestExport}
              disabled={!allConfirmed || exporting || isStreaming}
              className="h-7 gap-1 px-2 text-[11px]"
            >
              {exporting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <CheckCheck className="h-3 w-3" />
              )}
              全部确认并导出
            </Button>
          </div>
        </div>
      </div>

      {/* Right: chat panel (360px) */}
      <div className="flex w-[360px] shrink-0 flex-col border-l border-border/70">
        <PptChatPanel
          key={chatId ?? "empty"}
          chatId={chatId}
          onStreamingChange={onStreamingChange}
          displayContentMap={displayContentMap}
          ref={chatPanelRef}
        />
      </div>
    </div>
  );
}
