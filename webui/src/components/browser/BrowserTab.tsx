import { FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tab } from "@/hooks/useBrowserTabs";

function getFaviconUrl(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    if (!hostname) return null;
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=16`;
  } catch {
    return null;
  }
}

interface BrowserTabProps {
  tab: Tab;
  active: boolean;
  onClick: () => void;
  onClose?: () => void;
}

export function BrowserTabItem({ tab, active, onClick, onClose }: BrowserTabProps) {
  const faviconUrl = tab.type === "browser" && tab.url ? getFaviconUrl(tab.url) : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex h-7 max-w-[180px] items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
        active
          ? "bg-primary/15 text-foreground font-medium"
          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
      )}
    >
      {faviconUrl ? (
        <img src={faviconUrl} alt="" className="shrink-0 h-4 w-4 rounded-sm" onError={(e) => { e.currentTarget.style.display = "none"; }} />
      ) : tab.type === "md-reader" ? (
        <FileText className="shrink-0 h-3.5 w-3.5 text-[#eba45d]" />
      ) : tab.type !== "mona" ? (
        <span className="shrink-0 text-[11px]">{tab.isAiControlled ? "🤖" : "🌐"}</span>
      ) : null}
      <span className="truncate">{tab.title}</span>
      {tab.type !== "mona" && onClose && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.stopPropagation(); onClose(); }
          }}
          className="ml-auto shrink-0 flex items-center justify-center w-4 h-4 rounded-sm hover:bg-destructive/20"
        >
          <X className="h-2.5 w-2.5" />
        </span>
      )}
    </button>
  );
}
