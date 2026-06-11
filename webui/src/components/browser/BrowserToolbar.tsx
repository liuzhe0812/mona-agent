import { ArrowLeft, ArrowRight, RotateCw, Star, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";

interface BrowserToolbarProps {
  url: string;
  isAiControlled: boolean;
  onNavigate: (url: string) => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
}

export function BrowserToolbar({ url, isAiControlled, onNavigate, onGoBack, onGoForward, onReload }: BrowserToolbarProps) {
  const [inputUrl, setInputUrl] = useState(url);
  const [isFocused, setIsFocused] = useState(false);

  // 当外部 url 变化时同步到输入框（仅未聚焦时）
  useEffect(() => {
    if (!isFocused) {
      setInputUrl(url);
    }
  }, [url, isFocused]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputUrl.trim();
    if (!trimmed) return;
    const finalUrl = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    onNavigate(finalUrl);
  };

  return (
    <div className="flex h-8 items-center gap-1.5 border-b border-border/50 bg-background/95 px-2">
      <Button variant="ghost" size="icon" className="h-6 w-6" title="后退" onClick={onGoBack}>
        <ArrowLeft className="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" className="h-6 w-6" title="前进" onClick={onGoForward}>
        <ArrowRight className="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" className="h-6 w-6" title="刷新" onClick={onReload}>
        <RotateCw className="h-3 w-3" />
      </Button>
      <form onSubmit={handleSubmit} className="flex-1">
        <div className="flex items-center gap-1.5">
          <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
          <Input
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            className="h-6 rounded-full border-0 bg-muted/50 text-[12px] px-2"
            placeholder="输入网址..."
          />
        </div>
      </form>
      <Button variant="ghost" size="icon" className="h-6 w-6" title="收藏">
        <Star className="h-3 w-3" />
      </Button>
      {isAiControlled && (
        <div className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
          </span>
          AI 操作中
        </div>
      )}
    </div>
  );
}
