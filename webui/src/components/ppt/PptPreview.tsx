import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchPptPreviewPort, fetchPptProjectSlides, getApiBase, type PptSlide } from "@/lib/api";
import { useClient } from "@/providers/ClientProvider";

interface PptPreviewProps {
  projectName: string | null;
  /** Whether the agent is currently streaming. When streaming stops, preview
   *  triggers an immediate refresh — this is the most reliable moment to
   *  check whether SVGs have appeared on disk. */
  isStreaming?: boolean;
}

export function PptPreview({ projectName, isStreaming }: PptPreviewProps) {
  const { token } = useClient();
  const [slides, setSlides] = useState<PptSlide[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editorUrl, setEditorUrl] = useState<string | null>(null);
  const [apiBase, setApiBase] = useState("");
  const slidesFoundRef = useRef(false);

  useEffect(() => {
    getApiBase().then(setApiBase);
  }, []);

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

  // Auto-refresh: keep polling until slides are found.
  // During generation: poll every 4s.
  // After generation (slides still empty): poll every 3s to catch finalize delay.
  // Once slides are found: stop auto-refresh.
  useEffect(() => {
    if (!projectName) return;

    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    function schedule() {
      const interval = slidesFoundRef.current ? 30000 : 4000;
      timer = setTimeout(async () => {
        if (stopped) return;
        const found = await loadSlides();
        if (!stopped && !found) {
          schedule(); // keep trying
        }
        // if found, stop auto-refresh
      }, interval);
    }

    // Start polling if slides haven't been found yet
    if (!slidesFoundRef.current) {
      schedule();
    }

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [projectName, loadSlides]);

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
  const svgUrl = `${apiBase}${slide.url}${sep}token=${encodeURIComponent(token)}`;

  return (
    <div className="flex h-full flex-col">
      {/* SVG display area */}
      <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4">
        <object
          data={svgUrl}
          type="image/svg+xml"
          className="max-h-full max-w-full rounded shadow-md"
        >
          <img
            src={svgUrl}
            alt={slide.name}
            className="max-h-full max-w-full rounded shadow-md"
            draggable={false}
          />
        </object>
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

        {editorUrl && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenEditor}
            className="h-6 gap-1 text-[11px]"
          >
            <ExternalLink className="h-3 w-3" />
            在编辑器中打开
          </Button>
        )}
      </div>
    </div>
  );
}
