import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { BrainCircuit, FileSpreadsheet, FileText, Folder, GitBranch, Globe2, LayoutGrid, Maximize2, Minimize2, Plus, Presentation, SquareTerminal, X } from "lucide-react";

import { RightSidebarToggleIcon } from "@/components/notes/RightSidebarToggleIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DeliveredFile } from "@/lib/types";

export interface ArtifactPreviewTab {
  id: string;
  kind?: "file";
  file: DeliveredFile;
}

export interface CanvasSidebarTab {
  id: string;
  kind: "canvas";
  title: string;
  canvasKind: "flowchart" | "mindmap";
}

export interface ToolSidebarTab {
  id: string;
  kind: "tool";
  title: string;
  toolKind: "workspace" | "browser" | "terminal";
  terminalSessionId?: string;
  terminalStatus?: "opening" | "ready" | "error";
  terminalError?: string;
}

export interface OfficeSidebarTab {
  id: string;
  kind: "office";
  title: string;
  sessionId: string;
  officeType: "docs" | "sheets" | "slides";
}

export type ArtifactSidebarTab = ArtifactPreviewTab | CanvasSidebarTab | ToolSidebarTab | OfficeSidebarTab;
export type SidebarNewTabKind =
  | "workspace"
  | "browser"
  | "terminal"
  | "flowchart"
  | "mindmap"
  | "ppt"
  | "word"
  | "excel";

interface ArtifactSidebarProps {
  tabs: ArtifactSidebarTab[];
  activeTabId: string;
  maximized: boolean;
  onSelectOverview: () => void;
  onSelectTab: (tab: ArtifactSidebarTab) => void;
  onCloseTab: (id: string) => void;
  onCreateTab?: (kind: SidebarNewTabKind) => void;
  onToggleMaximized: () => void;
  onCollapse: () => void;
  toolbarSlotRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

export const OVERVIEW_TAB_ID = "overview";
const APP_PICKER_SPRITE = "/brand/sidebar-app-picker-icons.png";

export function ArtifactSidebar({
  tabs,
  activeTabId,
  maximized,
  onSelectOverview,
  onSelectTab,
  onCloseTab,
  onCreateTab,
  onToggleMaximized,
  onCollapse,
  toolbarSlotRef,
  children,
}: ArtifactSidebarProps) {
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const overviewButtonRef = useRef<HTMLButtonElement>(null);
  const expandedOverviewWidthRef = useRef(0);
  const [overviewCompact, setOverviewCompact] = useState(false);
  useEffect(() => {
    const scrollActiveTabIntoView = () => {
      tabRefs.current[activeTabId]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    const syncOverviewCompact = () => {
      const tabList = tabListRef.current;
      const overviewButton = overviewButtonRef.current;
      if (!tabList || !overviewButton) return;
      if (!overviewCompact) {
        expandedOverviewWidthRef.current = overviewButton.offsetWidth;
        setOverviewCompact(tabList.scrollWidth > tabList.clientWidth);
        return;
      }
      const widthNeededToExpand = expandedOverviewWidthRef.current - overviewButton.offsetWidth;
      setOverviewCompact(tabList.scrollWidth + widthNeededToExpand > tabList.clientWidth - 8);
    };
    const syncLayout = () => {
      syncOverviewCompact();
      scrollActiveTabIntoView();
    };
    syncLayout();
    if (typeof ResizeObserver === "undefined" || !tabListRef.current) return;
    const observer = new ResizeObserver(syncLayout);
    observer.observe(tabListRef.current);
    return () => observer.disconnect();
  }, [activeTabId, overviewCompact, tabs]);

  const newTabItems = [
    { kind: "workspace" as const, label: "工作区", spritePosition: "-5px -12px" },
    { kind: "browser" as const, label: "浏览器", spritePosition: "-41px -12px" },
    { kind: "terminal" as const, label: "终端", spritePosition: "-77px -12px" },
    { kind: "flowchart" as const, label: "流程图", spritePosition: "-114px -12px" },
    { kind: "mindmap" as const, label: "思维导图", spritePosition: "-5px -50px" },
    { kind: "ppt" as const, label: "PPT", spritePosition: "-41px -50px" },
    { kind: "word" as const, label: "Word", spritePosition: "-77px -50px" },
    { kind: "excel" as const, label: "Excel", spritePosition: "-114px -50px" },
  ];
  return (
    <div className="flex h-full min-w-0 flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5">
        <button
          ref={overviewButtonRef}
          type="button"
          aria-current={activeTabId === OVERVIEW_TAB_ID ? "page" : undefined}
          aria-label="概览"
          title="概览"
          onClick={onSelectOverview}
          className={cn(
            "flex h-7 shrink-0 items-center rounded-md text-ui text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            overviewCompact ? "w-7 justify-center px-0" : "gap-1 px-2",
            activeTabId === OVERVIEW_TAB_ID && "bg-muted/60 text-foreground",
          )}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          {!overviewCompact ? <span>概览</span> : null}
        </button>
        <div
          ref={tabListRef}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label="工作区标签页"
        >
          {tabs.map((tab) => {
            const active = activeTabId === tab.id;
            const isCanvas = tab.kind === "canvas";
            const isTool = tab.kind === "tool";
            const isOffice = tab.kind === "office";
            const label = isCanvas || isTool || isOffice ? tab.title : tab.file.name;
            const TabIcon = isCanvas
              ? tab.canvasKind === "flowchart" ? GitBranch : BrainCircuit
              : isOffice
                ? tab.officeType === "sheets" ? FileSpreadsheet : tab.officeType === "slides" ? Presentation : FileText
              : isTool
                ? tab.toolKind === "workspace"
                  ? Folder
                  : tab.toolKind === "browser"
                    ? Globe2
                    : SquareTerminal
                : FileText;
            return (
              <div
                key={tab.id}
                ref={(element) => { tabRefs.current[tab.id] = element; }}
                className={cn(
                  "group flex h-7 max-w-32 shrink-0 items-center rounded-md",
                  active && "bg-muted/60",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={label}
                  onClick={() => onSelectTab(tab)}
                  className={cn(
                    "flex h-7 min-w-0 flex-1 items-center gap-1 pl-2 text-ui text-muted-foreground hover:text-foreground",
                    active && "text-foreground",
                  )}
                >
                  <TabIcon className="h-3 w-3 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  title={`关闭 ${label}`}
                  aria-label={`关闭 ${label}`}
                  onClick={() => onCloseTab(tab.id)}
                  className="mr-0.5 h-5 w-5 shrink-0 rounded-sm p-0 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-70 focus-visible:opacity-100"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            );
          })}
          {onCreateTab ? (
            <TooltipProvider delayDuration={300}>
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label="新建标签页"
                        className="h-6 w-6 shrink-0 rounded-sm p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">新建标签页</TooltipContent>
                </Tooltip>
                <DropdownMenuContent
                  align="start"
                  sideOffset={6}
                  className="grid min-w-0 grid-cols-4 gap-1.5 rounded-lg border-border/70 bg-popover p-2 shadow-float"
                >
                  {newTabItems.map((item) => {
                    return (
                      <Tooltip key={item.kind}>
                        <TooltipTrigger asChild>
                          <DropdownMenuItem
                            aria-label={item.label}
                            onSelect={() => onCreateTab(item.kind)}
                            className="h-10 w-10 justify-center p-0 hover:bg-muted focus:bg-muted"
                          >
                            <span
                              aria-hidden
                              className="h-8 w-8 rounded-md bg-no-repeat"
                              style={{
                                backgroundImage: `url(${APP_PICKER_SPRITE})`,
                                backgroundPosition: item.spritePosition,
                                backgroundSize: "150px 100px",
                              }}
                            />
                          </DropdownMenuItem>
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={6}>{item.label}</TooltipContent>
                      </Tooltip>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </TooltipProvider>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <div ref={toolbarSlotRef} className="flex shrink-0 items-center" />
          <Button
            type="button"
            variant="ghost"
            onClick={onToggleMaximized}
            title={maximized ? "还原侧边栏" : "最大化侧边栏"}
            aria-label={maximized ? "还原侧边栏" : "最大化侧边栏"}
            aria-pressed={maximized}
            className="h-6 w-6 rounded-sm p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onCollapse}
            title="收起侧边栏"
            aria-label="收起侧边栏"
            className="h-6 w-6 rounded-sm p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RightSidebarToggleIcon open className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
