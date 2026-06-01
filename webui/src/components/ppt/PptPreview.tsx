import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

import { fetchPptProjectSlides, getApiBase, type PptSlide } from "@/lib/api";
import { useClient } from "@/providers/ClientProvider";

interface PptPreviewProps {
  projectName: string | null;
}

export function PptPreview({ projectName }: PptPreviewProps) {
  const { token } = useClient();
  const [slides, setSlides] = useState<PptSlide[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const [apiBase, setApiBase] = useState<string>("");

  useEffect(() => {
    getApiBase().then(setApiBase);
  }, []);

  useEffect(() => {
    if (!projectName) {
      setSlides([]);
      setIndex(0);
      setLoading(false);
      setError(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(false);
    setSlides([]);
    setIndex(0);

    fetchPptProjectSlides(token, projectName)
      .then((res) => {
        if (cancelled) return;
        setSlides(res.slides);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectName, token]);

  const goPrev = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const goNext = useCallback(() => {
    setIndex((i) => Math.min(slides.length - 1, i + 1));
  }, [slides.length]);

  if (!projectName) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        开始生成后将在此展示预览
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载预览…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        加载预览失败
      </div>
    );
  }

  if (slides.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        暂无幻灯片
      </div>
    );
  }

  const slide = slides[index];
  const svgUrl = `${apiBase}${slide.url}&token=${encodeURIComponent(token)}`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4">
        <img
          src={svgUrl}
          alt={slide.name}
          className="max-h-full max-w-full rounded shadow-md"
          draggable={false}
        />
      </div>
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
      </div>
    </div>
  );
}
