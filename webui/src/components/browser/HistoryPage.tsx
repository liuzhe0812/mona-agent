import { useState, useEffect, useCallback, useMemo } from "react";
import { Search, Trash2, Clock, Globe, X, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  browserListHistory,
  browserDeleteHistory,
  browserClearHistory,
  type HistoryRecord,
} from "@/lib/browser-ipc";
import { isTauri } from "@/lib/tauri";

interface HistoryPageProps {
  onNavigate: (url: string) => void;
  onBack: () => void;
}

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString + (isoString.endsWith("Z") ? "" : "Z"));
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin} 分钟前`;
    if (diffHour < 24) return `${diffHour} 小时前`;
    if (diffDay < 7) return `${diffDay} 天前`;
    return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return isoString;
  }
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function getFaviconUrl(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    if (!hostname) return null;
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=16`;
  } catch {
    return null;
  }
}

export function HistoryPage({ onNavigate, onBack }: HistoryPageProps) {
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    if (!isTauri()) return;
    setLoading(true);
    try {
      const records = await browserListHistory(1000);
      setHistory(records);
    } catch (e) {
      console.error("[HistoryPage] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const filteredHistory = useMemo(() => {
    if (!searchQuery.trim()) return history;
    const q = searchQuery.toLowerCase();
    return history.filter(
      (h) => h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q)
    );
  }, [history, searchQuery]);

  // 按日期分组
  const groupedHistory = useMemo(() => {
    const groups: Record<string, HistoryRecord[]> = {};
    filteredHistory.forEach((h) => {
      const date = new Date(h.lastVisitedAt + (h.lastVisitedAt.endsWith("Z") ? "" : "Z"));
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      let key: string;
      if (date.toDateString() === today.toDateString()) {
        key = "今天";
      } else if (date.toDateString() === yesterday.toDateString()) {
        key = "昨天";
      } else {
        key = date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
      }
      if (!groups[key]) groups[key] = [];
      groups[key].push(h);
    });
    return groups;
  }, [filteredHistory]);

  const handleDelete = useCallback(async (id: number) => {
    try {
      await browserDeleteHistory(id);
      setHistory((prev) => prev.filter((h) => h.id !== id));
    } catch (e) {
      console.error("[HistoryPage] delete failed:", e);
    }
  }, []);

  const handleClearAll = useCallback(async () => {
    if (!confirm("确定要清空所有历史记录吗？此操作不可撤销。")) return;
    try {
      await browserClearHistory();
      setHistory([]);
    } catch (e) {
      console.error("[HistoryPage] clear all failed:", e);
    }
  }, []);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onBack} title="返回">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Clock className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-[14px] font-semibold">历史记录</h1>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-7 w-56 rounded-full border-0 bg-muted/50 pl-7 pr-7 text-[12px]"
              placeholder="搜索历史记录..."
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          {history.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[12px] text-destructive hover:text-destructive"
              onClick={handleClearAll}
            >
              <Trash2 className="mr-1.5 h-3 w-3" />
              清空全部
            </Button>
          )}
        </div>
      </div>

      {/* 历史记录列表 */}
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl px-4 py-4">
          {loading ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground text-[13px]">
              加载中...
            </div>
          ) : filteredHistory.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Clock className="h-8 w-8 opacity-50" />
              <span className="text-[13px]">
                {searchQuery ? "未找到匹配的记录" : "暂无历史记录"}
              </span>
            </div>
          ) : (
            Object.entries(groupedHistory).map(([dateLabel, items]) => (
              <div key={dateLabel} className="mb-6">
                <h2 className="mb-2 text-[12px] font-medium text-muted-foreground">{dateLabel}</h2>
                <div className="space-y-0.5">
                  {items.map((item) => {
                    const favicon = getFaviconUrl(item.url);
                    return (
                      <div
                        key={item.id}
                        className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                          {favicon ? (
                            <img
                              src={favicon}
                              alt=""
                              className="h-4 w-4 rounded-sm"
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                              }}
                            />
                          ) : (
                            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => onNavigate(item.url)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <div className="truncate text-[13px] font-medium">
                            {item.title || item.url}
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {getDomain(item.url)}
                          </div>
                        </button>
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                          {formatDate(item.lastVisitedAt)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="删除"
                          onClick={() => void handleDelete(item.id)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
