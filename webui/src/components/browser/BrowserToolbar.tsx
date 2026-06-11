import { ArrowLeft, ArrowRight, RotateCw, Star, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentLogo } from "@/components/AgentLogo";
import { useEffect, useState } from "react";

interface BrowserToolbarProps {
  url: string;
  isAiControlled: boolean;
  isAiPanelOpen: boolean;
  onNavigate: (url: string) => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onToggleAiPanel: () => void;
}

export function BrowserToolbar({ url, isAiControlled, isAiPanelOpen, onNavigate, onGoBack, onGoForward, onReload, onToggleAiPanel }: BrowserToolbarProps) {
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
      <button
        type="button"
        onClick={onToggleAiPanel}
        title="Mona"
        className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${isAiPanelOpen ? "bg-primary/15" : "hover:bg-muted/60"}`}
      >
        <AgentLogo
          state={isAiControlled ? "working" : "idle"}
          className="h-5 w-5"
        />
      </button>
    </div>
  );
}
