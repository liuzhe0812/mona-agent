import { useState, useCallback, useEffect } from "react";
import {
  ChevronLeft,
  BookOpen,
  Search,
  Upload,
  RefreshCw,
  Database,
  Loader2,
  ChevronDown,
  ChevronUp,
  FileText,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { kbStatus, kbQuery, kbIngest, kbCompile } from "@/lib/api";
import { useClient } from "@/providers/ClientProvider";

interface KbStatus {
  mode: string;
  docCount: number;
  pendingChanges: number;
  instance: string;
}

interface KbResult {
  path: string;
  title: string;
  content: string;
}

export function KnowledgeBaseView({ onBack }: { onBack?: () => void }) {
  const { token } = useClient();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KbResult[]>([]);
  const [status, setStatus] = useState<KbStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [totalTokens, setTotalTokens] = useState(0);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await kbStatus(token);
      setStatus(s);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "无法获取知识库状态";
      setError(msg);
    }
  }, [token]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setExpandedIndex(null);
    try {
      const res = await kbQuery(token, q);
      setResults(res.results);
      setTotalTokens(res.totalTokens);
    } catch {
      setError("查询失败");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [token, query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSearch();
      }
    },
    [handleSearch],
  );

  const handleIngest = useCallback(async () => {
    setIngesting(true);
    setError(null);
    try {
      await kbIngest(token, ["."], undefined, undefined, true, "notebook");
      await loadStatus();
    } catch {
      setError("入库失败");
    } finally {
      setIngesting(false);
    }
  }, [token, loadStatus]);

  const handleCompile = useCallback(async () => {
    setCompiling(true);
    setError(null);
    try {
      await kbCompile(token);
      await loadStatus();
    } catch {
      setError("编译失败");
    } finally {
      setCompiling(false);
    }
  }, [token, loadStatus]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="shrink-0 border-b border-border/70 px-4 py-3">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
              返回
            </button>
          )}
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-[#a877e7]" />
            <h1 className="text-lg font-semibold tracking-tight">知识库</h1>
          </div>
        </div>
      </div>

      <div className="shrink-0 border-b border-border/70 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="搜索知识库..."
              className="pl-9"
            />
          </div>
          <Button onClick={handleSearch} disabled={loading || !query.trim()} size="sm">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            搜索
          </Button>
        </div>
      </div>

      <div className="shrink-0 border-b border-border/70 px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 text-[12px] text-muted-foreground">
            {status ? (
              <>
                <span className="inline-flex items-center gap-1">
                  <Database className="h-3.5 w-3.5" />
                  {status.mode}
                </span>
                <span>文档 {status.docCount}</span>
                {status.pendingChanges > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    待编译 {status.pendingChanges}
                  </span>
                )}
              </>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                加载状态...
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleIngest}
              disabled={ingesting}
              className="h-7 gap-1.5 text-[12px]"
            >
              {ingesting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              入库
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCompile}
              disabled={compiling}
              className="h-7 gap-1.5 text-[12px]"
            >
              {compiling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              编译
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-4 py-3">
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {results.length > 0 && (
            <div className="mb-2 text-[12px] text-muted-foreground">
              找到 {results.length} 条结果
              {totalTokens > 0 && ` · ${totalTokens} tokens`}
            </div>
          )}

          {results.length === 0 && !loading && !error && query.trim() && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <FileText className="mb-2 h-8 w-8 opacity-40" />
              <p className="text-[13px]">未找到相关内容</p>
            </div>
          )}

          {!query.trim() && results.length === 0 && !error && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Search className="mb-2 h-8 w-8 opacity-40" />
              <p className="text-[13px]">输入关键词搜索知识库</p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {results.map((result, index) => {
              const isExpanded = expandedIndex === index;
              return (
                <div
                  key={`${result.path}-${index}`}
                  className="rounded-lg border border-border/70 bg-card transition-colors hover:border-border"
                >
                  <button
                    type="button"
                    onClick={() => setExpandedIndex(isExpanded ? null : index)}
                    className="flex w-full items-start gap-3 px-3 py-2.5 text-left"
                  >
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium leading-snug">
                        {result.title || result.path}
                      </div>
                      <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                        {result.path}
                      </div>
                    </div>
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                  {isExpanded && (
                    <>
                      <Separator />
                      <div className="px-3 py-2.5">
                        <pre className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-foreground/80">
                          {result.content}
                        </pre>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
