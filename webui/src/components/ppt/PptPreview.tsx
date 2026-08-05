import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  fetchPptPreviewPort,
  fetchPptProjectSlides,
  fetchPptVisualPlan,
  generatePptPreview,
  getApiBase,
  type PptSlide,
  type PptVisualPlanPage,
} from "@/lib/api";
import { useClient } from "@/providers/ClientProvider";

interface PptPreviewProps {
  projectName: string | null;
  /** Whether the agent is currently streaming. When streaming stops, preview
   *  triggers an immediate refresh — this is the most reliable moment to
   *  check whether SVGs have appeared on disk. */
  isStreaming?: boolean;
  /** Whether the project has an output.pptx file. When true and slides are
   *  empty, the component will auto-generate preview images. */
  hasPptxOutput?: boolean;
  /** Current pipeline stage from backend. Used to trigger visual plan refresh
   *  when the stage reaches "planned". */
  pipelineStage?: string;
}

export function PptPreview({ projectName, isStreaming, hasPptxOutput, pipelineStage }: PptPreviewProps) {
  const { token } = useClient();
  const [slides, setSlides] = useState<PptSlide[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editorUrl, setEditorUrl] = useState<string | null>(null);
  const [apiBase, setApiBase] = useState("");
  const [visualPlan, setVisualPlan] = useState<PptVisualPlanPage[]>([]);
  const slidesFoundRef = useRef(false);
  const [svgObjectUrls, setSvgObjectUrls] = useState<Record<string, string>>({});
  const [svgLoadStates, setSvgLoadStates] = useState<Record<string, "idle" | "loading" | "loaded" | "error">>({});
  const svgRequestedRef = useRef<Set<string>>(new Set());
  const objectUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    getApiBase().then(setApiBase);
  }, []);

  // Load visual plan — poll during generation when no slides exist yet,
  // so the plan appears as soon as Strategist writes page_visual_plan.json.
  useEffect(() => {
    if (!projectName) {
      setVisualPlan([]);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function fetch() {
      try {
        const res = await fetchPptVisualPlan(token, projectName!);
        if (!cancelled) setVisualPlan(res.pages ?? []);
      } catch {
        if (!cancelled) setVisualPlan([]);
      }
    }

    // Fetch immediately
    fetch();

    // If still generating and no slides, keep polling every 4s
    if (isStreaming && slides.length === 0) {
      function schedule() {
        timer = setTimeout(async () => {
          if (cancelled) return;
          await fetch();
          if (!cancelled) schedule();
        }, 4000);
      }
      schedule();
    }

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token, projectName, isStreaming, slides.length]);

  // Also refresh visual plan when pipelineStage transitions to "planned"
  const prevStageRef = useRef("");
  useEffect(() => {
    if (pipelineStage === "planned" && prevStageRef.current !== "planned" && projectName) {
      fetchPptVisualPlan(token, projectName)
        .then((res) => setVisualPlan(res.pages ?? []))
        .catch(() => {});
    }
    prevStageRef.current = pipelineStage ?? "";
  }, [pipelineStage, token, projectName]);

  // Load slides
  const loadSlides = useCallback(async () => {
    if (!projectName) return false;
    try {
      const res = await fetchPptProjectSlides(token, projectName);
      setSlides(res.slides);
      if (res.slides.length > 0) {
        slidesFoundRef.current = true;
        setIndex((prev) => Math.min(prev, res.slides.length - 1));
      }
      return res.slides.length > 0;
    } catch {
      return false;
    }
  }, [token, projectName]);

  // Initial load when project changes
  useEffect(() => {
    if (!projectName) {
      setSlides([]);
      setIndex(0);
      setEditorUrl(null);
      slidesFoundRef.current = false;
      return;
    }

    slidesFoundRef.current = false;
    setLoading(true);
    loadSlides().then((found) => {
      if (found) slidesFoundRef.current = true;
    }).finally(() => setLoading(false));
  }, [projectName, token, loadSlides]);

  // Auto-refresh: keep polling as long as a project is open.
  // During generation (isStreaming) poll every 2s so new pages appear quickly.
  // Otherwise poll every 4s. The moment streaming stops we also do an immediate
  // refresh in the effect below.
  useEffect(() => {
    if (!projectName) return;

    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    async function tick() {
      if (stopped) return;
      await loadSlides();
      if (stopped) return;
      const interval = isStreaming ? 2000 : 4000;
      timer = setTimeout(tick, interval);
    }

    tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [projectName, loadSlides, isStreaming]);

  // When streaming stops, immediately check for slides.
  // This is the most reliable moment — the agent just finished writing files.
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = !!isStreaming;

    if (wasStreaming && !isStreaming && projectName) {
      loadSlides();
    }
  }, [isStreaming, projectName, loadSlides]);

  // Fetch SVG contents, sanitize XML entity errors, and serve them through
  // object URLs so the browser treats them as replaced elements (<img>). This
  // gives us the same scaling behaviour as raster images and isolates the SVG
  // from page-level CSS, while still allowing our defensive sanitizer to run
  // even if a cached URL bypasses the backend fix.
  useEffect(() => {
    if (!apiBase || !token || slides.length === 0) return;

    let cancelled = false;

    function sanitizeSvgXml(text: string): string {
      const XML_BUILTIN = new Set(["amp", "lt", "gt", "quot", "apos"]);
      // 1. Fix well-formed entity references (named/numeric).
      text = text.replace(
        /&([A-Za-z_][A-Za-z0-9_]*|#[0-9]+|#x[0-9A-Fa-f]+);/g,
        (match, ref) => {
          if (XML_BUILTIN.has(ref)) return match;
          if (/^#[0-9]+$/.test(ref) || /^#x[0-9A-Fa-f]+$/i.test(ref)) return match;
          const textarea = document.createElement("textarea");
          textarea.innerHTML = match;
          const expanded = textarea.value;
          if (expanded !== match) return expanded;
          return `&amp;${ref};`;
        },
      );
      // 2. Escape any remaining bare ampersands (e.g. "R&D", "A & B", "&&",
      // malformed numeric refs without a semicolon).
      text = text.replace(
        /&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9A-Fa-f]+;)/g,
        "&amp;",
      );
      // 3. Escape bare '<' in text content (not tag starts).
      text = text.replace(/<(?![A-Za-z/!?])/g, "&lt;");
      // 4. Escape ']]>' sequences.
      text = text.replace(/]]>/g, "]]&gt;");
      return text;
    }

    async function fetchSvgs() {
      for (const slide of slides) {
        if (cancelled) break;
        if (slide.type !== "svg") continue;
        if (svgRequestedRef.current.has(slide.url)) continue;
        svgRequestedRef.current.add(slide.url);
        setSvgLoadStates((prev) => ({ ...prev, [slide.url]: "loading" }));
        try {
          const sep = slide.url.includes("?") ? "&" : "?";
          const url = `${apiBase}${slide.url}${sep}token=${encodeURIComponent(token)}`;
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          let text = await res.text();
          text = sanitizeSvgXml(text);
          const blob = new Blob([text], { type: "image/svg+xml;charset=utf-8" });
          const objectUrl = URL.createObjectURL(blob);
          objectUrlsRef.current.add(objectUrl);
          // Always update state — functional updates are safe even after the
          // effect has been cleaned up (React 18 ignores updates to unmounted
          // components). If we skip these updates, a slide whose fetch
          // completed right after cleanup would be stuck in "loading" forever:
          // svgRequestedRef keeps the URL marked as requested, so fetchSvgs
          // won't retry it on the next run.
          setSvgObjectUrls((prev) => {
            const old = prev[slide.url];
            if (old) URL.revokeObjectURL(old);
            return { ...prev, [slide.url]: objectUrl };
          });
          setSvgLoadStates((prev) => ({ ...prev, [slide.url]: "loaded" }));
        } catch {
          svgRequestedRef.current.delete(slide.url);
          setSvgLoadStates((prev) => ({ ...prev, [slide.url]: "error" }));
        }
      }
    }

    fetchSvgs();

    return () => {
      cancelled = true;
    };
  }, [slides, apiBase, token]);

  // Auto-generate preview when PPTX exists but no slides are found.
  const previewGeneratedRef = useRef(false);
  useEffect(() => {
    if (!projectName || !hasPptxOutput || isStreaming || slides.length > 0) return;
    if (previewGeneratedRef.current) return;

    let cancelled = false;
    previewGeneratedRef.current = true;

    generatePptPreview(token, projectName).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        loadSlides();
      }
    }).catch(() => {
      // Silently ignore — polling will keep trying
    });

    return () => {
      cancelled = true;
    };
  }, [projectName, hasPptxOutput, isStreaming, slides.length, token, loadSlides]);

  // Reset all preview state when project changes so we never render stale
  // slides with empty/mismatched object URLs (which looks like a broken image).
  useEffect(() => {
    previewGeneratedRef.current = false;
    slidesFoundRef.current = false;
    setSlides([]);
    setIndex(0);
    setSvgLoadStates({});
    svgRequestedRef.current.clear();
    setSvgObjectUrls((prev) => {
      for (const url of Object.values(prev)) {
        URL.revokeObjectURL(url);
      }
      return {};
    });
    for (const url of objectUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    objectUrlsRef.current.clear();
  }, [projectName]);

  // Check if Flask editor is running
  useEffect(() => {
    if (!projectName) return;
    let cancelled = false;

    async function check() {
      try {
        const res = await fetchPptPreviewPort(token, projectName!);
        if (!cancelled && res.port) {
          setEditorUrl(`http://localhost:${res.port}`);
        } else if (!cancelled) {
          setEditorUrl(null);
        }
      } catch {
        if (!cancelled) setEditorUrl(null);
      }
    }

    check();
    const timer = setInterval(check, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectName, token]);

  const handleOpenEditor = useCallback(() => {
    if (editorUrl) {
      window.open(editorUrl, "_blank");
    }
  }, [editorUrl]);

  const handleRefresh = useCallback(() => {
    setLoading(true);
    loadSlides().finally(() => setLoading(false));
  }, [loadSlides]);

  const goPrev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(
    () => setIndex((i) => Math.min(slides.length - 1, i + 1)),
    [slides.length],
  );

  // No project selected
  if (!projectName) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        开始生成后将在此展示预览
      </div>
    );
  }

  if (editorUrl) {
    return (
      <div className="flex h-full flex-col">
        <iframe
          src={editorUrl}
          title="PPT 实时预览"
          className="min-h-0 flex-1 border-0 bg-background"
        />
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-border/70 py-1.5 text-[12px] text-muted-foreground">
          <Button variant="ghost" size="sm" onClick={handleRefresh} className="h-6 gap-1 text-[11px]">
            <RefreshCw className="h-3 w-3" />
            刷新
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenEditor}
            className="h-6 gap-1 text-[11px]"
          >
            <ExternalLink className="h-3 w-3" />
            新窗口打开
          </Button>
        </div>
      </div>
    );
  }

  // Loading
  if (loading && slides.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>加载预览中…</span>
      </div>
    );
  }

  // No slides yet
  if (slides.length === 0) {
    // Show visual plan if available
    if (visualPlan.length > 0) {
      const typeLabels: Record<string, string> = {
        text_layout: "文字排版",
        data_chart: "数据图表",
        flowchart: "流程图",
        architecture: "架构图",
        timeline: "时间线",
        matrix: "矩阵图",
        comparison: "对比图",
        ai_image: "AI 配图",
        mixed: "混合",
      };
      const typeColors: Record<string, string> = {
        text_layout: "bg-blue-100 text-blue-700",
        data_chart: "bg-green-100 text-green-700",
        flowchart: "bg-purple-100 text-purple-700",
        architecture: "bg-orange-100 text-orange-700",
        timeline: "bg-teal-100 text-teal-700",
        matrix: "bg-pink-100 text-pink-700",
        comparison: "bg-yellow-100 text-yellow-700",
        ai_image: "bg-rose-100 text-rose-700",
        mixed: "bg-gray-100 text-gray-700",
      };
      return (
        <div className="flex h-full flex-col">
          <div className="shrink-0 border-b border-border/70 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
            页面视觉计划（{visualPlan.length} 页）
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <div className="grid grid-cols-2 gap-2">
              {visualPlan.map((p) => (
                <div
                  key={p.page}
                  className="rounded-lg border border-border/70 bg-background p-2.5"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-medium">{p.title}</span>
                    <span className="text-[9px] text-muted-foreground">{p.page}</span>
                  </div>
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-medium ${
                      typeColors[p.visual_type] ?? "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {typeLabels[p.visual_type] ?? p.visual_type}
                  </span>
                  {p.chart_template && (
                    <span className="ml-1 inline-block rounded bg-green-50 px-1.5 py-0.5 text-[9px] text-green-600">
                      {p.chart_template}
                    </span>
                  )}
                  {p.has_ai_image && (
                    <span className="ml-1 inline-block rounded bg-rose-50 px-1.5 py-0.5 text-[9px] text-rose-600">
                      AI图
                    </span>
                  )}
                  {p.notes && (
                    <p className="mt-1 text-[9px] leading-tight text-muted-foreground">
                      {p.notes}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-center gap-3 border-t border-border/70 py-1.5 text-[12px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>正在生成幻灯片…</span>
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-muted-foreground">
        <span>{isStreaming ? "正在生成幻灯片…" : "正在等待幻灯片就绪…"}</span>
        <Loader2 className="h-4 w-4 animate-spin" />
        <Button variant="ghost" size="sm" onClick={handleRefresh} className="h-6 gap-1 text-[11px]">
          <RefreshCw className="h-3 w-3" />
          刷新
        </Button>
      </div>
    );
  }

  // Render current slide
  const slide = slides[index];
  const sep = slide.url.includes("?") ? "&" : "?";
  const slideUrl = `${apiBase}${slide.url}${sep}token=${encodeURIComponent(token)}`;
  const isImage = slide.type === "image";
  const svgObjectUrl = svgObjectUrls[slide.url];
  const svgLoadState = svgLoadStates[slide.url] ?? "idle";
  const isSvgLoading = !isImage && svgLoadState !== "loaded" && svgLoadState !== "error";
  const isSvgError = !isImage && svgLoadState === "error";

  return (
    <div className="flex h-full flex-col">
      {/* Slide display area */}
      <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4">
        {isImage ? (
          <img
            src={slideUrl}
            alt={slide.name}
            className="max-h-full max-w-full rounded shadow-md"
            draggable={false}
          />
        ) : isSvgLoading ? (
          <div className="flex flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>正在加载幻灯片…</span>
          </div>
        ) : isSvgError || !svgObjectUrl ? (
          <div className="flex flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <span>幻灯片加载失败</span>
            <Button variant="ghost" size="sm" onClick={handleRefresh} className="h-6 gap-1 text-[11px]">
              <RefreshCw className="h-3 w-3" />
              重试
            </Button>
          </div>
        ) : (
          <img
            src={svgObjectUrl}
            alt={slide.name}
            className="max-h-full max-w-full rounded shadow-md"
            draggable={false}
            onError={() => setSvgLoadStates((prev) => ({ ...prev, [slide.url]: "error" }))}
          />
        )}
      </div>

      {/* Navigation bar */}
      <div className="flex shrink-0 items-center justify-center gap-3 border-t border-border/70 py-1.5 text-[12px] text-muted-foreground">
        <button
          onClick={goPrev}
          disabled={index === 0}
          className="rounded p-1 hover:bg-muted disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span>
          {index + 1} / {slides.length}
        </span>
        <button
          onClick={goNext}
          disabled={index === slides.length - 1}
          className="rounded p-1 hover:bg-muted disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" />
        </button>

        <span className="mx-1 text-border">|</span>

        <Button variant="ghost" size="sm" onClick={handleRefresh} className="h-6 gap-1 text-[11px]">
          <RefreshCw className="h-3 w-3" />
          刷新
        </Button>

      </div>
    </div>
  );
}
