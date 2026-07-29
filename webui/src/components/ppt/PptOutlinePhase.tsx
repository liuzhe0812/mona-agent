import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, GripVertical, Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ApiError,
  fetchPptOutline,
  lockPptOutline,
  savePptOutline,
  type PptOutlinePage,
} from "@/lib/api";

interface PptOutlinePhaseProps {
  projectName: string;
  token: string;
  onLocked: () => void;
}

const VISUAL_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "text_layout", label: "文本版式" },
  { value: "chart_bar", label: "柱状图" },
  { value: "chart_line", label: "折线图" },
  { value: "chart_pie", label: "饼图" },
  { value: "diagram", label: "图示" },
  { value: "process", label: "流程图" },
  { value: "comparison", label: "对比" },
  { value: "timeline", label: "时间线" },
  { value: "image", label: "图片为主" },
  { value: "cover", label: "封面" },
  { value: "section_divider", label: "章节分隔" },
  { value: "quote", label: "引用" },
];

function makeEmptyPage(): PptOutlinePage {
  return {
    page: `page_${Date.now()}`,
    file: "",
    title: "新页面",
    bullets: [],
    visual_type: "text_layout",
    chart_template: null,
    layout_template: "",
    has_ai_image: false,
    layout: "",
    notes: "",
  };
}

export function PptOutlinePhase({ projectName, token, onLocked }: PptOutlinePhaseProps) {
  const [pages, setPages] = useState<PptOutlinePage[]>([]);
  const [revision, setRevision] = useState<number>(0);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [locking, setLocking] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Refs to access latest values inside async callbacks without re-creating them
  const pagesRef = useRef<PptOutlinePage[]>(pages);
  const revisionRef = useRef<number>(revision);
  pagesRef.current = pages;
  revisionRef.current = revision;

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFetchingRef = useRef<boolean>(false);
  const dragIdxRef = useRef<number | null>(null);

  // --- Re-fetch outline (used by initial load and 409 recovery) ---
  const refetch = useCallback(async (): Promise<void> => {
    isFetchingRef.current = true;
    try {
      const outline = await fetchPptOutline(token, projectName);
      setPages(outline.pages);
      setRevision(outline.revision);
      setError(null);
    } finally {
      isFetchingRef.current = false;
    }
  }, [token, projectName]);

  // --- Initial load + polling while pages empty ---
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        isFetchingRef.current = true;
        const outline = await fetchPptOutline(token, projectName);
        if (cancelled) return;
        setPages(outline.pages);
        setRevision(outline.revision);
        if (outline.pages.length > 0) {
          setLoading(false);
          isFetchingRef.current = false;
        } else {
          // Agent still generating outline, poll every 5s
          pollTimer = setTimeout(load, 5000);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "加载大纲失败");
        setLoading(false);
        isFetchingRef.current = false;
      }
    };

    load();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      isFetchingRef.current = false;
    };
  }, [token, projectName]);

  // --- Debounced save (1s after last edit) ---
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        setSaving(true);
        const res = await savePptOutline(
          token,
          projectName,
          revisionRef.current,
          pagesRef.current,
        );
        setRevision(res.revision);
        setError(null);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setError("大纲已被修改，正在重新加载...");
          try {
            await refetch();
            setError(null);
          } catch (e2) {
            setError(e2 instanceof Error ? e2.message : "重新加载失败");
          }
        } else {
          setError(e instanceof Error ? e.message : "保存失败");
        }
      } finally {
        setSaving(false);
      }
    }, 1000);
  }, [token, projectName, refetch]);

  // Cleanup pending save on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Clamp selectedIdx when pages shrink
  useEffect(() => {
    if (pages.length === 0) return;
    if (selectedIdx >= pages.length) {
      setSelectedIdx(pages.length - 1);
    }
  }, [pages.length, selectedIdx]);

  // --- Page-level mutations ---
  const handleAddPage = useCallback(() => {
    const newPage = makeEmptyPage();
    setPages((prev) => [...prev, newPage]);
    setSelectedIdx(pagesRef.current.length);
    scheduleSave();
  }, [scheduleSave]);

  const handleDeletePage = useCallback(
    (idx: number) => {
      setPages((prev) => prev.filter((_, i) => i !== idx));
      setSelectedIdx((prev) => {
        if (prev === idx) return Math.max(0, prev - 1);
        if (prev > idx) return prev - 1;
        return prev;
      });
      scheduleSave();
    },
    [scheduleSave],
  );

  // --- Drag and drop reorder ---
  const handleDragStart = useCallback((idx: number) => {
    dragIdxRef.current = idx;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (idx: number) => {
      const from = dragIdxRef.current;
      dragIdxRef.current = null;
      if (from === null || from === idx) return;
      setPages((prev) => {
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        next.splice(idx, 0, moved);
        return next;
      });
      setSelectedIdx(idx);
      scheduleSave();
    },
    [scheduleSave],
  );

  // --- Field-level mutations on the selected page ---
  const updateField = useCallback(
    <K extends keyof PptOutlinePage>(field: K, value: PptOutlinePage[K]) => {
      setPages((prev) => {
        if (selectedIdx < 0 || selectedIdx >= prev.length) return prev;
        const next = [...prev];
        next[selectedIdx] = { ...next[selectedIdx], [field]: value };
        return next;
      });
      scheduleSave();
    },
    [selectedIdx, scheduleSave],
  );

  const updateBullet = useCallback(
    (bIdx: number, value: string) => {
      setPages((prev) => {
        if (selectedIdx < 0 || selectedIdx >= prev.length) return prev;
        const page = { ...prev[selectedIdx] };
        page.bullets = [...page.bullets];
        page.bullets[bIdx] = value;
        const next = [...prev];
        next[selectedIdx] = page;
        return next;
      });
      scheduleSave();
    },
    [selectedIdx, scheduleSave],
  );

  const addBullet = useCallback(() => {
    setPages((prev) => {
      if (selectedIdx < 0 || selectedIdx >= prev.length) return prev;
      const page = { ...prev[selectedIdx] };
      page.bullets = [...page.bullets, ""];
      const next = [...prev];
      next[selectedIdx] = page;
      return next;
    });
    scheduleSave();
  }, [selectedIdx, scheduleSave]);

  const deleteBullet = useCallback(
    (bIdx: number) => {
      setPages((prev) => {
        if (selectedIdx < 0 || selectedIdx >= prev.length) return prev;
        const page = { ...prev[selectedIdx] };
        page.bullets = page.bullets.filter((_, i) => i !== bIdx);
        const next = [...prev];
        next[selectedIdx] = page;
        return next;
      });
      scheduleSave();
    },
    [selectedIdx, scheduleSave],
  );

  // --- Confirm: save then lock ---
  const handleConfirm = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setLocking(true);
    setError(null);
    try {
      const saveRes = await savePptOutline(
        token,
        projectName,
        revisionRef.current,
        pagesRef.current,
      );
      setRevision(saveRes.revision);
      await lockPptOutline(token, projectName);
      onLocked();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError("大纲已被修改，正在重新加载...");
        try {
          await refetch();
          setError(null);
        } catch (e2) {
          setError(e2 instanceof Error ? e2.message : "重新加载失败");
        }
      } else {
        setError(e instanceof Error ? e.message : "锁定大纲失败");
      }
    } finally {
      setLocking(false);
    }
  }, [token, projectName, onLocked, refetch]);

  const selectedPage: PptOutlinePage | null =
    selectedIdx >= 0 && selectedIdx < pages.length ? pages[selectedIdx] : null;

  // Build visual type options, ensuring the current value is present
  const visualOptions =
    selectedPage && !VISUAL_TYPE_OPTIONS.some((o) => o.value === selectedPage.visual_type)
      ? [
          ...VISUAL_TYPE_OPTIONS,
          { value: selectedPage.visual_type, label: selectedPage.visual_type },
        ]
      : VISUAL_TYPE_OPTIONS;

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="text-[13px] text-muted-foreground">正在加载大纲...</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Left: page list */}
        <div className="flex w-[200px] shrink-0 flex-col border-r border-border/70">
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto scrollbar-hover p-2">
            {pages.map((page, idx) => (
              <div
                key={`${page.page}-${idx}`}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={handleDragOver}
                onDrop={() => handleDrop(idx)}
                onClick={() => setSelectedIdx(idx)}
                className={cn(
                  "group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors",
                  selectedIdx === idx
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <GripVertical className="h-3 w-3 shrink-0 opacity-40 group-hover:opacity-70" />
                <span className="shrink-0 text-[10px] font-medium tabular-nums">
                  {String(idx + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {page.title || "未命名"}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeletePage(idx);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            {pages.length === 0 && (
              <div className="px-2 py-4 text-center text-[11px] text-muted-foreground">
                暂无页面
              </div>
            )}
          </div>
          <div className="shrink-0 border-t border-border/70 p-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={handleAddPage}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              添加页
            </Button>
          </div>
        </div>

        {/* Right: detail editor */}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-4">
          {selectedPage ? (
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-foreground">
                  标题
                </label>
                <Input
                  value={selectedPage.title}
                  onChange={(e) => updateField("title", e.target.value)}
                  placeholder="页面标题"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-foreground">
                  核心要点
                </label>
                <div className="space-y-1.5">
                  {selectedPage.bullets.map((bullet, bIdx) => (
                    <div key={bIdx} className="flex items-start gap-1.5">
                      <Textarea
                        className="min-h-[36px] flex-1 resize-none text-[13px]"
                        value={bullet}
                        onChange={(e) => updateBullet(bIdx, e.target.value)}
                        placeholder={`要点 ${bIdx + 1}`}
                        rows={1}
                      />
                      <button
                        type="button"
                        className="mt-1 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteBullet(bIdx)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" onClick={addBullet}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    添加要点
                  </Button>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-foreground">
                  视觉表达方式
                </label>
                <select
                  className="w-full rounded-lg border border-border/70 bg-transparent px-3 py-1.5 text-[12px] outline-none focus:border-primary"
                  value={selectedPage.visual_type}
                  onChange={(e) => updateField("visual_type", e.target.value)}
                >
                  {visualOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-foreground">
                  布局建议
                </label>
                <Textarea
                  className="min-h-[80px] resize-none text-[13px]"
                  value={selectedPage.layout}
                  onChange={(e) => updateField("layout", e.target.value)}
                  placeholder="描述页面布局建议..."
                />
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
              选择左侧页面进行编辑，或添加新页
            </div>
          )}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="shrink-0 border-t border-border/70 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                保存中...
              </>
            ) : pages.length > 0 ? (
              <>
                <Check className="h-3 w-3 text-emerald-500" />
                已保存 · {pages.length} 页
              </>
            ) : null}
          </div>
          <Button onClick={handleConfirm} disabled={locking || pages.length === 0}>
            {locking ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                锁定中...
              </>
            ) : (
              <>
                <Check className="mr-1.5 h-3.5 w-3.5" />
                确认大纲并继续
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
