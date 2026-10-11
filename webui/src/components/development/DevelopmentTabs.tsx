import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, FileCode2, Globe2, Maximize2, MessageSquare, Minimize2, PanelRightClose, Plus, SquareTerminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { WorkTab } from "./store";
import type { Tab } from "@/hooks/useBrowserTabs";

export const DEVELOPMENT_WORK_TOOLS = [
  { id: "review", title: "审查", icon: FileCode2 },
  { id: "terminal", title: "终端", icon: SquareTerminal },
  { id: "sidechat", title: "辅助对话", icon: MessageSquare },
  { id: "workspace", title: "文件", icon: FileCode2 },
] as const;
const tools = [
  { id: "workspace", title: "文件", icon: FileCode2 },
  { id: "terminal", title: "终端", icon: SquareTerminal },
  { id: "browser", title: "浏览器", icon: Globe2 },
  { id: "review", title: "审查", icon: FileCode2 },
  { id: "sidechat", title: "辅助对话", icon: MessageSquare },
  { id: "subagents", title: "子智能体配置", icon: Bot },
  { id: "agent", title: "子智能体", icon: Bot },
] as const;

function faviconUrl(tab?: Tab | null): string | undefined {
  if (tab?.favicon) return tab.favicon;
  try {
    const url = new URL(tab?.url ?? "");
    return ["http:", "https:"].includes(url.protocol) ? `${url.origin}/favicon.ico` : undefined;
  } catch { return undefined; }
}

export function DevelopmentTabs({ tabs, active, maximized, overviewOpen = true, browserTab, onSelect, onClose, onMaximize, onCollapse, children }: {
  tabs: WorkTab[]; active: WorkTab | "overview"; maximized: boolean;
  overviewOpen?: boolean; browserTab?: Tab | null;
  onSelect: (tab: WorkTab | "overview") => void; onClose: (tab: WorkTab | "overview") => void;
  onMaximize: () => void; onCollapse: () => void; children: ReactNode;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [failedFavicon, setFailedFavicon] = useState("");
  const pageTitle = browserTab?.url ? browserTab.title || browserTab.url : "新标签页";
  const favicon = faviconUrl(browserTab);
  const pageIcon = favicon && favicon !== failedFavicon
    ? <img src={favicon} alt="" className="h-4 w-4 shrink-0 object-contain" onError={() => setFailedFavicon(favicon)} />
    : <Globe2 className="h-4 w-4 shrink-0" />;
  useEffect(() => { strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [active, tabs]);
  return <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/50 px-2">
      <div ref={strip} role="tablist" aria-label="工作区标签页" className="flex min-w-0 shrink items-center gap-1 overflow-x-auto [scrollbar-width:none]"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const targets = Array.from(strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
          const index = targets.indexOf(document.activeElement as HTMLButtonElement);
          if (index < 0 || !targets.length) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? targets.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + targets.length) % targets.length;
          targets[next].focus(); targets[next].click();
        }}>
        {overviewOpen && <div className={cn("group flex h-8 shrink-0 items-center rounded-md", active === "overview" && "bg-muted/60")}>
          <Button type="button" variant="ghost" size="sm" role="tab" aria-selected={active === "overview"} title={pageTitle} onClick={() => onSelect("overview")} className={cn("h-8 max-w-48 shrink-0 gap-2 px-3 text-ui text-muted-foreground hover:bg-muted/50", active === "overview" && "bg-muted/60 font-medium text-foreground hover:bg-muted/60")}>
            {pageIcon}<span className="truncate">{pageTitle}</span>
          </Button>
          <Button variant="ghost" size="icon" className={cn("mx-0.5 h-6 w-6 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100", active === "overview" && "opacity-100")} aria-label={`关闭 ${pageTitle}`} onClick={() => onClose("overview")}><X className="h-3 w-3" /></Button>
        </div>}
        {tabs.map((id) => { const tool = tools.find((item) => item.id === id); if (!tool) return null; const Icon = tool.icon;
          const title = id === "browser" && browserTab?.url ? pageTitle : tool.title;
          return <div key={id} className={cn("group flex h-8 shrink-0 items-center rounded-md", id === active && "bg-muted/60")}>
            <Button type="button" variant="ghost" size="sm" role="tab" aria-selected={id === active} title={title} onClick={() => onSelect(id)} className={cn("h-8 max-w-36 gap-1.5 pl-2 text-ui text-muted-foreground hover:bg-muted/50", id === active && "font-medium text-foreground hover:bg-transparent")}>{id === "browser" ? pageIcon : <Icon className="h-4 w-4 shrink-0" />}<span className="truncate">{title}</span></Button>
            <Button variant="ghost" size="icon" className={cn("mx-0.5 h-6 w-6 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100", id === active && "opacity-100")} aria-label={`关闭 ${title}`} onClick={() => onClose(id)}><X className="h-3 w-3" /></Button>
          </div>;
        })}
      </div>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label="打开工作标签"><Plus className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="start">{DEVELOPMENT_WORK_TOOLS.map((tool) => <DropdownMenuItem key={tool.id} onSelect={() => onSelect(tool.id)}><tool.icon className="mr-2 h-4 w-4" />{tool.title}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
      <div className="min-w-0 flex-1" aria-hidden />
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label={maximized ? "还原侧边栏" : "放大侧边栏"} onClick={onMaximize}>{maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</Button>
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label="收起侧边栏" onClick={onCollapse}><PanelRightClose className="h-4 w-4" /></Button>
    </header>
    <div className="relative min-h-0 min-w-0 flex-1" role="tabpanel" aria-label={active === "overview" || active === "browser" ? pageTitle : tools.find((tool) => tool.id === active)?.title}>{children}</div>
  </div>;
}
