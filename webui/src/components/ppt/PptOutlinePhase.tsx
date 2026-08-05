import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, ChevronUp, GripVertical, List, Loader2, Plus, SlidersHorizontal, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { Breakpoint } from "@/hooks/useBreakpoint";
import {
  ApiError,
  fetchPptDesignSpecSummary,
  fetchPptOutline,
  lockPptOutline,
  savePptOutline,
  updatePptDesignSpecSummary,
  type PptDesignSpecSummary,
  type PptOutlinePage,
} from "@/lib/api";
interface PptOutlinePhaseProps {
  projectName: string;
  token: string;
  onLocked: () => void;
  /** Incremented by parent when AI streaming transitions from true → false.
   *  Mirrors VideoMakerView's aiTurnComplete pattern: triggers an immediate
   *  refresh + 800ms fallback to catch files the AI just wrote to disk. */
  refreshTrigger?: number;
  /** Responsive breakpoint: narrow 时页面列表和整体规格通过 Sheet 打开 */
  bp?: Breakpoint;
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

// --- Editable spec field options ---
const CANVAS_FORMAT_OPTIONS = [
  { value: "ppt169", label: "16:9 宽屏" },
  { value: "ppt43", label: "4:3 标准" },
  { value: "a4h", label: "A4 横向" },
  { value: "a4v", label: "A4 纵向" },
];

const STYLE_MODE_SPEC_OPTIONS = [
  { value: "general", label: "简洁" },
  { value: "consulting", label: "商务" },
  { value: "top-consulting", label: "高端商务" },
];

const ICON_APPROACH_OPTIONS = [
  { value: "minimal", label: "极简" },
  { value: "rich", label: "丰富" },
  { value: "none", label: "无图标" },
];

const ICON_LIBRARY_OPTIONS = [
  { value: "lucide", label: "Lucide" },
  { value: "emoji", label: "Emoji" },
  { value: "none", label: "无" },
];

const IMAGE_APPROACH_OPTIONS = [
  { value: "none", label: "无图片" },
  { value: "search", label: "网络搜索" },
  { value: "generate", label: "AI 生成" },
  { value: "mixed", label: "混合" },
];

const FORMULA_POLICY_OPTIONS = [
  { value: "none", label: "无公式" },
  { value: "image", label: "图片" },
  { value: "text", label: "文本" },
];

// 内置主题色预设：一键应用主色 + 配色方案 + 视觉风格描述
const THEME_PRESETS: Array<{
  label: string;
  primaryColor: string;
  colorScheme: string;
  styleDescriptor: string;
}> = [
  { label: "科技蓝", primaryColor: "#1A73E8", colorScheme: "科技蓝主色+浅蓝辅色+浅灰底", styleDescriptor: "科技感" },
  { label: "商务深蓝", primaryColor: "#1E3A8A", colorScheme: "深蓝主色+金棕辅色+米白底", styleDescriptor: "商务严谨" },
  { label: "翡翠绿", primaryColor: "#10B981", colorScheme: "翡翠绿主色+青蓝辅色+浅灰底", styleDescriptor: "生机现代" },
  { label: "暖橙", primaryColor: "#F59E0B", colorScheme: "暖橙主色+深棕辅色+米白底", styleDescriptor: "活力温暖" },
  { label: "中国红", primaryColor: "#DC2626", colorScheme: "中国红主色+金色辅色+浅米底", styleDescriptor: "庄重权威" },
  { label: "极简灰", primaryColor: "#475569", colorScheme: "深灰主色+蓝色辅色+纯白底", styleDescriptor: "极简专业" },
  { label: "紫罗兰", primaryColor: "#7C3AED", colorScheme: "紫主色+粉辅色+浅灰底", styleDescriptor: "神秘创新" },
  { label: "青墨", primaryColor: "#0F766E", colorScheme: "青墨主色+琥珀辅色+米白底", styleDescriptor: "沉静东方" },
];

const selectClass =
  "h-7 w-full rounded-md border border-border/60 bg-background/60 px-2 text-[11px] outline-none focus:border-primary";
const inputClass =
  "h-7 w-full rounded-md border border-border/60 bg-background/60 px-2 text-[11px] outline-none focus:border-primary";

/** Normalize a color string to #RRGGBB format for <input type="color">.
 *  Returns #000000 as fallback if the input is not a valid hex color. */
function normalizeColor(color: string | null | undefined): string {
  if (!color) return "#000000";
  const trimmed = color.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9A-Fa-f]{3}$/.test(trimmed)) {
    return "#" + trimmed.slice(1).split("").map((c) => c + c).join("").toLowerCase();
  }
  return "#000000";
}

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
    summary: "",
    image_plan: "",
  };
}

export function PptOutlinePhase({ projectName, token, onLocked, refreshTrigger, bp = "wide" }: PptOutlinePhaseProps) {
  const [pages, setPages] = useState<PptOutlinePage[]>([]);
  const [revision, setRevision] = useState<number>(0);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [saving, setSaving] = useState<boolean>(false);
  const [locking, setLocking] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [specPanelOpen, setSpecPanelOpen] = useState(true);
  const [specSummary, setSpecSummary] = useState<PptDesignSpecSummary | null>(null);
  const [summaryCheckedOnce, setSummaryCheckedOnce] = useState(false);
  const [specSaving, setSpecSaving] = useState(false);
  // 镜像 specSaveErrorRef 的 state，用于 JSX 响应式渲染保存失败状态
  const [specSaveError, setSpecSaveError] = useState<string | null>(null);
  // 镜像 pendingPatchRef 是否有未保存修改，用于 JSX 响应式渲染
  const [specHasPending, setSpecHasPending] = useState(false);
  // 整页删除二次确认：记录待删除页索引，null 表示无待确认删除
  const [pendingDeleteIdx, setPendingDeleteIdx] = useState<number | null>(null);
  // 窄屏 Sheet：页面列表 / 整体规格
  const [pageSheetOpen, setPageSheetOpen] = useState(false);
  const [specSheetOpen, setSpecSheetOpen] = useState(false);

  // Refs to access latest values inside async callbacks without re-creating them
  const pagesRef = useRef<PptOutlinePage[]>(pages);
  const revisionRef = useRef<number>(revision);
  pagesRef.current = pages;
  revisionRef.current = revision;

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFetchingRef = useRef<boolean>(false);
  const dragIdxRef = useRef<number | null>(null);
  const specSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const specSummaryRef = useRef<PptDesignSpecSummary | null>(specSummary);
  specSummaryRef.current = specSummary;
  // Spec save state: track in-flight request to serialize saves
  const specSaveInFlightRef = useRef(false);
  const specSaveErrorRef = useRef<string | null>(null);

  // --- Re-fetch outline (used by initial load and 409 recovery) ---
  const refetch = useCallback(async (): Promise<void> => {
    isFetchingRef.current = true;
    try {
      const outline = await fetchPptOutline(token, projectName);
      setPages(
        (outline.pages ?? []).map((p) => ({
          ...p,
          bullets: Array.isArray(p.bullets) ? p.bullets : [],
          title: p.title ?? "",
          visual_type: p.visual_type ?? "text_layout",
          layout: p.layout ?? "",
          notes: p.notes ?? "",
          summary: p.summary ?? "",
          image_plan: p.image_plan ?? "",
        })),
      );
      setRevision(outline.revision);
      setError(null);
    } finally {
      isFetchingRef.current = false;
    }
  }, [token, projectName]);

  // --- Load design spec summary (AI 推荐的 8 项确认，可编辑) ---
  // AI writes design_spec_summary.json with recommended values. User can
  // edit any field inline; changes are debounced-saved via PUT API.
  // When user locks the outline, the [OUTLINE_CONFIRMED] message tells
  // the Agent to rebuild design_spec.md from the latest summary JSON.
  const loadSpecSummary = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchPptDesignSpecSummary(token, projectName);
      setSummaryCheckedOnce(true);
      if (!res.ok || !res.summary) return;
      setSpecSummary(res.summary);
    } catch {
      // summary may not exist yet — silently ignore
      setSummaryCheckedOnce(true);
    }
  }, [token, projectName]);

  // --- Debounced save for spec edits (800ms, 累积合并多次 patch) ---
  // 多次快速调用（如点击主题预设同时改 primaryColor + colorScheme）会累积到
  // pendingPatchRef，800ms 静默后一次性 PUT，避免前一次 patch 被覆盖丢失。
  const pendingPatchRef = useRef<Partial<PptDesignSpecSummary>>({});

  /** Immediately flush all pending spec patches to the server.
   *  Serializes concurrent calls: if a save is already in-flight, waits for it
   *  then sends the accumulated patch. Returns true on success, false on failure.
   *  Never throws — error state is stored in specSaveErrorRef. */
  const flushSpecSave = useCallback(async (): Promise<boolean> => {
    // Clear any pending debounce timer — we're saving now
    if (specSaveTimerRef.current) {
      clearTimeout(specSaveTimerRef.current);
      specSaveTimerRef.current = null;
    }

    // Wait for any in-flight save to complete
    while (specSaveInFlightRef.current) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const patchToSend = { ...pendingPatchRef.current };
    if (Object.keys(patchToSend).length === 0) return true; // nothing to save

    pendingPatchRef.current = {};
    setSpecHasPending(false);
    specSaveInFlightRef.current = true;
    setSpecSaving(true);
    specSaveErrorRef.current = null;
    setSpecSaveError(null);

    try {
      const res = await updatePptDesignSpecSummary(token, projectName, patchToSend);
      if (res.ok && res.summary) {
        setSpecSummary(res.summary);
      }
      return true;
    } catch (e) {
      // Put the patch back so it can be retried
      Object.assign(pendingPatchRef.current, patchToSend);
      setSpecHasPending(true);
      specSaveErrorRef.current = e instanceof Error ? e.message : "规格保存失败";
      setSpecSaveError(specSaveErrorRef.current);
      return false;
    } finally {
      specSaveInFlightRef.current = false;
      setSpecSaving(false);
    }
  }, [token, projectName]);

  const scheduleSpecSave = useCallback(
    (patch: Partial<PptDesignSpecSummary>) => {
      Object.assign(pendingPatchRef.current, patch);
      setSpecHasPending(true);
      if (specSaveTimerRef.current) clearTimeout(specSaveTimerRef.current);
      specSaveTimerRef.current = setTimeout(() => {
        void flushSpecSave();
      }, 800);
    },
    [flushSpecSave],
  );

  // Update a single spec field locally + schedule debounced save
  const updateSpecField = useCallback(
    <K extends keyof PptDesignSpecSummary>(field: K, value: PptDesignSpecSummary[K]) => {
      setSpecSummary((prev) => (prev ? { ...prev, [field]: value } : prev));
      scheduleSpecSave({ [field]: value } as Partial<PptDesignSpecSummary>);
    },
    [scheduleSpecSave],
  );

  // 批量更新多个 spec 字段（用于主题预设等一键应用场景）
  const applySpecPreset = useCallback(
    (patch: Partial<PptDesignSpecSummary>) => {
      setSpecSummary((prev) => (prev ? { ...prev, ...patch } : prev));
      scheduleSpecSave(patch);
    },
    [scheduleSpecSave],
  );

  // Cleanup pending spec save on unmount
  useEffect(() => {
    return () => {
      if (specSaveTimerRef.current) clearTimeout(specSaveTimerRef.current);
    };
  }, []);

  // --- Initial load + polling while pages empty ---
  // 加超时保护：5 秒轮询一次，最多 60 次（5 分钟），超过后提示用户。
  const pollExhaustedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const MAX_ATTEMPTS = 60;

    const load = async () => {
      if (cancelled) return;
      try {
        isFetchingRef.current = true;
        const outline = await fetchPptOutline(token, projectName);
        if (cancelled) return;
        setPages(
          (outline.pages ?? []).map((p) => ({
            ...p,
            bullets: Array.isArray(p.bullets) ? p.bullets : [],
            title: p.title ?? "",
            visual_type: p.visual_type ?? "text_layout",
            layout: p.layout ?? "",
            notes: p.notes ?? "",
            summary: p.summary ?? "",
            image_plan: p.image_plan ?? "",
          })),
        );
        setRevision(outline.revision);
        if (outline.pages.length > 0) {
          isFetchingRef.current = false;
          pollExhaustedRef.current = false;
        } else {
          attempts += 1;
          if (attempts >= MAX_ATTEMPTS) {
            isFetchingRef.current = false;
            pollExhaustedRef.current = true;
            setError("Agent 长时间未生成大纲，可能已失败。请检查右侧聊天面板的输出，或返回重试。");
            return;
          }
          pollTimer = setTimeout(load, 5000);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "加载大纲失败");
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

  // --- V3 streaming→refresh trigger + mount initial spec summary load ---
  // mount (refreshTrigger === 0): only load design_spec_summary.json — the
  //   outline polling useEffect above handles fetchPptOutline.
  // refreshTrigger > 0: AI just finished a reply (streaming true → false).
  //   Immediately refresh outline + spec summary, then schedule an 800ms
  //   fallback to catch file system flush delays.
  useEffect(() => {
    if (refreshTrigger === undefined || refreshTrigger === 0) {
      // mount: load spec summary once (e.g. restoring from history)
      void loadSpecSummary();
      return;
    }
    void refetch();
    void loadSpecSummary();
    const t = setTimeout(() => {
      void refetch();
      void loadSpecSummary();
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger]);

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

  // --- Keyboard reorder (上移/下移按钮，拖拽之外的可达入口) ---
  const handleMovePage = useCallback(
    (idx: number, delta: number) => {
      const target = idx + delta;
      setPages((prev) => {
        if (target < 0 || target >= prev.length) return prev;
        const next = [...prev];
        const [moved] = next.splice(idx, 1);
        next.splice(target, 0, moved);
        return next;
      });
      setSelectedIdx(target);
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

  // --- Confirm: flush spec save → save outline → lock ---
  const handleConfirm = useCallback(async () => {
    // Clear any pending outline save timer
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setLocking(true);
    setError(null);
    try {
      // Step 1: Flush pending spec edits first — design_spec_summary.json must
      // reflect the UI state before the Agent reads it during Step 4 rebuild.
      const specOk = await flushSpecSave();
      if (!specOk) {
        setError("整体规格保存失败，无法确认大纲。请重试。");
        return;
      }
      // Step 2: Save outline pages
      const saveRes = await savePptOutline(
        token,
        projectName,
        revisionRef.current,
        pagesRef.current,
      );
      setRevision(saveRes.revision);
      // Step 3: Lock outline
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
  }, [token, projectName, onLocked, refetch, flushSpecSave]);

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

  // 整体设计规格面板：宽屏内联在顶部，窄屏通过 Sheet 作为上下文面板打开
  const specPanel = (
      <div className={bp === "narrow" ? "min-h-0 flex-1 overflow-y-auto scrollbar-hover" : "shrink-0 border-b border-border/70 bg-muted/30"}>
        <button
          type="button"
          onClick={() => setSpecPanelOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-[12px] text-foreground hover:bg-accent"
        >
          {specPanelOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
          <span className="font-medium">整体设计规格</span>
          <span className="truncate text-muted-foreground">
            {specSummary
              ? `AI 已生成 · ${specSummary.pageCount ?? pages.length} 页 · ${specSummary.styleMode ?? "—"} · ${specSummary.primaryColor ?? "—"}`
              : summaryCheckedOnce
                ? "等待 AI 生成推荐..."
                : "AI 正在分析内容..."}
          </span>
          {specSummary && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px]">
              {specSaveError ? (
                <>
                  <span className="text-destructive">保存失败</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void flushSpecSave();
                    }}
                    className="rounded px-1.5 py-0.5 text-primary hover:bg-primary/10"
                  >
                    重试保存
                  </button>
                </>
              ) : specSaving ? (
                <>
                  <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />
                  <span className="text-muted-foreground">保存中</span>
                </>
              ) : specHasPending ? (
                <span className="text-amber-500">有未保存修改</span>
              ) : (
                <>
                  <Check className="h-2.5 w-2.5 text-emerald-500" />
                  <span className="text-muted-foreground">已保存</span>
                </>
              )}
            </span>
          )}
        </button>
        {specPanelOpen && (
          <div className="px-3 pb-2.5">
            {specSummary ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Check className="h-3 w-3 text-primary" />
                  <span>AI 已基于内容分析生成推荐规格，可直接修改下方字段，确认大纲时将同步给 AI</span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-md border border-border/60 bg-background/50 p-2.5 text-[11px] leading-relaxed">
                  {/* 画布格式 */}
                  <label className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">画布格式</span>
                    <select
                      className={selectClass}
                      value={specSummary.canvasFormat ?? "ppt169"}
                      onChange={(e) => updateSpecField("canvasFormat", e.target.value)}
                    >
                      {CANVAS_FORMAT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                  {/* 页数 */}
                  <label className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">页数</span>
                    <input
                      type="number"
                      min={3}
                      max={50}
                      className={inputClass}
                      value={specSummary.pageCount ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        updateSpecField("pageCount", v === "" ? null : Math.max(3, Math.min(50, parseInt(v) || 3)));
                      }}
                    />
                  </label>
                  {/* 目标受众 */}
                  <label className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">目标受众</span>
                    <input
                      type="text"
                      className={inputClass}
                      value={specSummary.audience ?? ""}
                      onChange={(e) => updateSpecField("audience", e.target.value)}
                      placeholder="如：管理层/客户/团队"
                    />
                  </label>
                  {/* 风格模式 */}
                  <label className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">风格模式</span>
                    <select
                      className={selectClass}
                      value={specSummary.styleMode ?? "general"}
                      onChange={(e) => updateSpecField("styleMode", e.target.value)}
                    >
                      {STYLE_MODE_SPEC_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                  {/* 视觉风格 */}
                  <label className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">视觉风格</span>
                    <input
                      type="text"
                      className={inputClass}
                      value={specSummary.styleDescriptor ?? ""}
                      onChange={(e) => updateSpecField("styleDescriptor", e.target.value)}
                      placeholder="如：科技感/商务/极简"
                    />
                  </label>
                  {/* 主色调 */}
                  <label className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">主色调</span>
                    <div className="flex flex-1 items-center gap-1">
                      <input
                        type="color"
                        className="h-7 w-7 shrink-0 cursor-pointer rounded border border-border/60 bg-background/60 p-0.5"
                        value={normalizeColor(specSummary.primaryColor)}
                        onChange={(e) => updateSpecField("primaryColor", e.target.value)}
                      />
                      <input
                        type="text"
                        className={inputClass}
                        value={specSummary.primaryColor ?? ""}
                        onChange={(e) => updateSpecField("primaryColor", e.target.value)}
                        placeholder="#RRGGBB"
                      />
                    </div>
                  </label>
                  {/* 主题色快捷预设：点击一键应用主色+配色方案+视觉风格 */}
                  <div className="col-span-2 flex flex-wrap items-center gap-1 pl-[4.4rem]">
                    <span className="text-[10px] text-foreground/40">预设</span>
                    {THEME_PRESETS.map((p) => {
                      const active =
                        (specSummary.primaryColor ?? "").toLowerCase() === p.primaryColor.toLowerCase();
                      return (
                        <button
                          key={p.primaryColor}
                          type="button"
                          title={`${p.label} · ${p.colorScheme}`}
                          onClick={() =>
                            applySpecPreset({
                              primaryColor: p.primaryColor,
                              colorScheme: p.colorScheme,
                              styleDescriptor: p.styleDescriptor,
                            })
                          }
                          className={cn(
                            "flex h-4 w-4 items-center justify-center rounded-full border transition-transform hover:scale-110",
                            active ? "border-foreground ring-1 ring-foreground/30" : "border-border/60",
                          )}
                          style={{ backgroundColor: p.primaryColor }}
                        >
                          {active && <Check className="h-2.5 w-2.5 text-white" />}
                        </button>
                      );
                    })}
                  </div>
                  {/* 配色方案 */}
                  <label className="col-span-2 flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">配色方案</span>
                    <input
                      type="text"
                      className={inputClass}
                      value={specSummary.colorScheme ?? ""}
                      onChange={(e) => updateSpecField("colorScheme", e.target.value)}
                      placeholder="如：深蓝+橙金辅色+浅灰底"
                    />
                  </label>
                  {/* 图标方案 */}
                  <label className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">图标方案</span>
                    <select
                      className={selectClass}
                      value={specSummary.iconApproach ?? "minimal"}
                      onChange={(e) => updateSpecField("iconApproach", e.target.value)}
                    >
                      {ICON_APPROACH_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                  {/* 图标库 */}
                  <label className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">图标库</span>
                    <select
                      className={selectClass}
                      value={specSummary.iconLibrary ?? "lucide"}
                      onChange={(e) => updateSpecField("iconLibrary", e.target.value)}
                    >
                      {ICON_LIBRARY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                  {/* 字体方案 */}
                  <label className="col-span-2 flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">字体方案</span>
                    <input
                      type="text"
                      className={inputClass}
                      value={specSummary.typographyPlan ?? ""}
                      onChange={(e) => updateSpecField("typographyPlan", e.target.value)}
                      placeholder="如：思源黑体+Inter，标题粗体"
                    />
                  </label>
                  {/* 标题字体 */}
                  <label className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">标题字体</span>
                    <input
                      type="text"
                      className={inputClass}
                      value={specSummary.titleFont ?? ""}
                      onChange={(e) => updateSpecField("titleFont", e.target.value)}
                      placeholder="如：思源黑体"
                    />
                  </label>
                  {/* 正文字体 */}
                  <label className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">正文字体</span>
                    <input
                      type="text"
                      className={inputClass}
                      value={specSummary.bodyFont ?? ""}
                      onChange={(e) => updateSpecField("bodyFont", e.target.value)}
                      placeholder="如：Inter"
                    />
                  </label>
                  {/* 图片方案 */}
                  <label className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">图片方案</span>
                    <select
                      className={selectClass}
                      value={specSummary.imageApproach ?? "search"}
                      onChange={(e) => updateSpecField("imageApproach", e.target.value)}
                    >
                      {IMAGE_APPROACH_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                  {/* 公式策略 */}
                  <label className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-foreground/55">公式策略</span>
                    <select
                      className={selectClass}
                      value={specSummary.formulaPolicy ?? "none"}
                      onChange={(e) => updateSpecField("formulaPolicy", e.target.value)}
                    >
                      {FORMULA_POLICY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-1 py-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>AI 正在分析内容并生成推荐规格...</span>
              </div>
            )}
          </div>
        )}
      </div>
  );

  // 页面列表：宽屏常驻左列，窄屏通过 Sheet 打开
  const pageListContent = (
    <>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto scrollbar-hover p-2">
        {pages.map((page, idx) => (
          <div
            key={`${page.page}-${idx}`}
            draggable
            onDragStart={() => handleDragStart(idx)}
            onDragOver={handleDragOver}
            onDrop={() => handleDrop(idx)}
            className={cn(
              "group flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] transition-colors",
              selectedIdx === idx
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <GripVertical className="h-3 w-3 shrink-0 opacity-40 group-hover:opacity-70" aria-hidden />
            <button
              type="button"
              onClick={() => {
                setSelectedIdx(idx);
                setPageSheetOpen(false);
              }}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              aria-label={`编辑第 ${idx + 1} 页：${page.title || "未命名"}`}
              aria-current={selectedIdx === idx ? "true" : undefined}
            >
              <span className="shrink-0 text-[10px] font-medium tabular-nums">
                {String(idx + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {page.title || "未命名"}
              </span>
            </button>
            <button
              type="button"
              aria-label={`上移第 ${idx + 1} 页`}
              disabled={idx === 0}
              onClick={() => handleMovePage(idx, -1)}
              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-20"
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label={`下移第 ${idx + 1} 页`}
              disabled={idx === pages.length - 1}
              onClick={() => handleMovePage(idx, 1)}
              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-20"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label={`删除第 ${idx + 1} 页`}
              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
              onClick={() => setPendingDeleteIdx(idx)}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        {pages.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-2 py-8 text-[11px] text-muted-foreground">
            {!pollExhaustedRef.current && <Loader2 className="h-4 w-4 animate-spin opacity-50" />}
            <span>{pollExhaustedRef.current ? "生成超时" : "AI 正在生成大纲..."}</span>
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border/70 p-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => {
            handleAddPage();
            setPageSheetOpen(false);
          }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          添加页
        </Button>
      </div>
    </>
  );

  // 确认按钮不可用原因（锁定/大纲保存期间不可重复触发，向用户说明原因）。
  // 注意：规格保存进行中（specSaving）不禁用——handleConfirm 内的 flushSpecSave
  // 会等待在途请求完成后再提交累积 patch，点击确认即排队等待。
  const confirmReason = locking
    ? "正在确认大纲…"
    : saving
      ? "大纲保存中…"
      : pages.length === 0
        ? "等待 AI 生成大纲"
        : null;

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      {bp !== "narrow" && specPanel}

      {/* 窄屏顶部工具条：页面列表 + 整体规格入口 */}
      {bp === "narrow" && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border/70 px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPageSheetOpen(true)}
            className="h-7 gap-1 px-2 text-[11px]"
            aria-label="打开页面列表"
          >
            <List className="h-3.5 w-3.5" />
            页面
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSpecSheetOpen(true)}
            className="h-7 gap-1 px-2 text-[11px]"
            aria-label="打开整体设计规格"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            整体规格
          </Button>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {saving ? "保存中…" : pages.length > 0 ? `已保存 · ${pages.length} 页` : ""}
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Left: page list — 宽屏常驻，窄屏 Sheet */}
        {bp !== "narrow" && (
          <div className="flex w-[200px] shrink-0 flex-col border-r border-border/70">
            {pageListContent}
          </div>
        )}

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
                  内容概要
                </label>
                <Textarea
                  className="min-h-[60px] resize-none text-[13px]"
                  value={selectedPage.summary}
                  onChange={(e) => updateField("summary", e.target.value)}
                  placeholder="用中文简述本页要传达的核心信息（1-2 句话）"
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
                        aria-label={`删除要点 ${bIdx + 1}`}
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
                  placeholder="用中文描述页面布局建议（如：左标题右内容、上下分栏、居中大图等）"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-foreground">
                  图片方案
                </label>
                <Textarea
                  className="min-h-[60px] resize-none text-[13px]"
                  value={selectedPage.image_plan}
                  onChange={(e) => updateField("image_plan", e.target.value)}
                  placeholder="用中文描述本页图片需求（如：AI 生成科技感背景图、柱状图展示季度数据、无需图片等）"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-foreground">
                  备注（演讲词/补充说明）
                </label>
                <Textarea
                  className="min-h-[80px] resize-none text-[13px]"
                  value={selectedPage.notes}
                  onChange={(e) => updateField("notes", e.target.value)}
                  placeholder="该页的演讲备注或补充说明..."
                />
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
              {pages.length === 0 ? (
                <>
                  <span>AI 正在生成大纲，可在上方"整体设计规格"中预先调整风格</span>
                </>
              ) : (
                <span>选择左侧页面进行编辑，或添加新页</span>
              )}
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
          <div className="flex items-center gap-2">
            {confirmReason && (
              <span className="text-[11px] text-muted-foreground">{confirmReason}</span>
            )}
            <Button
              onClick={handleConfirm}
              disabled={confirmReason !== null}
            >
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

      {/* 窄屏：页面列表 Sheet */}
      <Sheet open={pageSheetOpen} onOpenChange={setPageSheetOpen}>
        <SheetContent side="left" className="flex w-[260px] flex-col p-0 sm:max-w-[260px]">
          <SheetHeader className="sr-only">
            <SheetTitle>页面列表</SheetTitle>
          </SheetHeader>
          {pageListContent}
        </SheetContent>
      </Sheet>

      {/* 窄屏：整体设计规格 Sheet */}
      <Sheet open={specSheetOpen} onOpenChange={setSpecSheetOpen}>
        <SheetContent side="right" className="flex w-[360px] flex-col p-0 sm:max-w-[360px]">
          <SheetHeader className="sr-only">
            <SheetTitle>整体设计规格</SheetTitle>
          </SheetHeader>
          {specPanel}
        </SheetContent>
      </Sheet>

      {/* 整页删除二次确认（删除单个要点保持直接操作） */}
      <AlertDialog
        open={pendingDeleteIdx !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteIdx(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这一页？</AlertDialogTitle>
            <AlertDialogDescription>
              将从大纲中移除第 {(pendingDeleteIdx ?? 0) + 1} 页
              {pendingDeleteIdx !== null && pages[pendingDeleteIdx]?.title
                ? `「${pages[pendingDeleteIdx].title}」`
                : ""}
              。删除后可重新添加页面，但本页内容需要重新填写。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeleteIdx !== null) handleDeletePage(pendingDeleteIdx);
                setPendingDeleteIdx(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
