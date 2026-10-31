import { createPortal } from "react-dom";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, ChevronDown, Copy, MessageSquarePlus, MoreHorizontal, PanelLeft, Pencil, Pin, PinOff, Settings2, SquarePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FileSystemIcon } from "@/components/ui/file-system-icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { DevExecutor, DevProject, DevSession } from "@/lib/development-api";
import { getFileIconAssetSource } from "@/lib/file-icons";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { DevelopmentLoading } from "./DevelopmentLoading";
import { EMPTY_SIDE, useDevelopmentStore, type WorkTab } from "./store";

const DevelopmentOverview = lazy(() => import("./DevelopmentOverview").then((module) => ({ default: module.DevelopmentOverview })));

function HeaderTooltip({ label, children, contentClassName }: { label: string; children: ReactNode; contentClassName?: string }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="bottom" className={contentClassName}>{label}</TooltipContent>
  </Tooltip>;
}

export function DevelopmentHeader({ project, session, executors, visible, onToggleProjects, onRename, onUpdate, onOpenStatus, hasStatus, needsAttention,
  overviewOpen, onOverviewOpenChange, overviewContainer, overviewDocked }: {
  project: DevProject; session: DevSession; executors: DevExecutor[]; visible: boolean; onToggleProjects?: () => void;
  onRename?: (session: DevSession) => void;
  onUpdate?: (session: DevSession, changes: Partial<Pick<DevSession, "pinned" | "archived">>) => void;
  onOpenStatus?: () => void;
  hasStatus?: boolean; needsAttention?: boolean;
  overviewOpen: boolean; onOverviewOpenChange: (open: boolean) => void; overviewContainer: HTMLElement | null; overviewDocked: boolean;
}) {
  const side = useDevelopmentStore((s) => s.sides[session.id] ?? EMPTY_SIDE);
  const [notice, setNotice] = useState("");
  const [copyError, setCopyError] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const overview = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const onOverviewOpenChangeRef = useRef(onOverviewOpenChange);
  onOverviewOpenChangeRef.current = onOverviewOpenChange;
  useEffect(() => { onOverviewOpenChangeRef.current(false); }, [visible, side.expanded, side.tab, side.agentSessionId]);
  useEffect(() => {
    if (!overviewOpen) return;
    const pointer = (event: PointerEvent) => {
      if (overviewDocked || !(event.target instanceof Element)) return;
      const target = event.target;
      if (!overview.current?.contains(target) && !trigger.current?.contains(target)
        && !target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) onOverviewOpenChangeRef.current(false);
    };
    const key = (event: KeyboardEvent) => {
      if (overview.current?.querySelector('[aria-label="Git 工具浮层"]') || document.querySelector('[role="dialog"][data-state="open"]')) return;
      // Header tooltips may consume Escape before the summary.
      if (event.key === "Escape" && (!event.defaultPrevented || document.activeElement === close.current || document.activeElement === trigger.current)) { onOverviewOpenChangeRef.current(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); };
  }, [overviewOpen, overviewDocked]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  const openTool = (tab: WorkTab) => {
    onOverviewOpenChange(false);
    trigger.current?.focus();
    useDevelopmentStore.getState().setSide(session.id, { tab, expanded: true });
  };
  const toggleOverview = () => {
    const next = !overviewOpen;
    onOverviewOpenChange(next);
    if (!next) trigger.current?.focus();
  };
  const copy = async (text: string) => {
    setCopyError("");
    try { await navigator.clipboard.writeText(text); setNotice("已复制"); }
    catch { setCopyError("复制失败，请重试。"); }
  };
  const openProject = async (target: "explorer" | "terminal") => {
    if (opening) return;
    if (!isTauri()) { setOpenError("请在 Mona 桌面端打开项目的资源管理器或系统终端。"); return; }
    setOpening(true); setOpenError("");
    try {
      if (target === "explorer") {
        const { openPath } = await import("@tauri-apps/plugin-opener");
        try { await openPath(project.rootPath); }
        catch {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("system_open_in_explorer", { path: project.rootPath });
        }
      } else {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("system_open_in_terminal", { path: project.rootPath });
      }
    } catch {
      setOpenError(target === "explorer" ? "无法打开项目目录，请确认目录仍然存在且可以访问。"
        : "无法打开系统终端，请确认项目目录仍然存在且可以访问，并检查系统终端是否可用。");
    } finally { setOpening(false); }
  };
  const overviewCard = overviewOpen && overviewContainer ? createPortal(
    <div ref={overview} id={`development-overview-${session.id}`} role="region" aria-label="任务概览浮卡" className="relative pointer-events-auto w-full max-h-full overflow-y-auto rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-float">
      <HeaderTooltip label="关闭摘要">
        <Button ref={close} variant="ghost" size="icon" className="absolute right-2 top-2 h-7 w-7 text-muted-foreground" aria-label="关闭任务概览" onClick={() => { onOverviewOpenChange(false); trigger.current?.focus(); }}><X className="h-3.5 w-3.5" /></Button>
      </HeaderTooltip>
      <Suspense fallback={<DevelopmentLoading label="正在读取任务概览…" variant="list" />}><DevelopmentOverview project={project} session={session} executors={executors} onOpenTool={openTool} /></Suspense>
    </div>, overviewContainer,
  ) : null;
  return <TooltipProvider delayDuration={250}><>
    <header className="relative flex h-12 shrink-0 items-center gap-2 px-4" aria-label="开发会话标题栏">
      {onToggleProjects && <HeaderTooltip label="切换项目列表"><Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground" aria-label="切换项目列表" onClick={onToggleProjects}><PanelLeft className="h-4 w-4" /></Button></HeaderTooltip>}
      <HeaderTooltip label={session.title} contentClassName="max-w-sm break-words"><h2 className="min-w-0 flex-1 truncate text-ui font-medium">{session.title}</h2></HeaderTooltip>
      {(notice || copyError) && <span role={copyError ? "alert" : "status"} className={cn("text-caption", copyError ? "text-destructive" : "text-muted-foreground")}>{copyError || notice}</span>}
      <div className="flex shrink-0 items-center gap-1">
        <div role="group" aria-label="打开当前项目" className="flex h-8 items-center rounded-lg border border-border bg-background">
          <HeaderTooltip label="在资源管理器中打开项目"><Button variant="ghost" size="icon" className="h-7 w-8 rounded-r-none" aria-label="在资源管理器中打开项目"
            disabled={opening} onClick={() => void openProject("explorer")}><FileSystemIcon name="" isDirectory className="h-5 w-5" /></Button></HeaderTooltip>
          <DropdownMenu onOpenChange={(open) => { if (open) onOverviewOpenChange(false); }}>
            <HeaderTooltip label="打开方式"><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-6 rounded-l-none text-muted-foreground"
              disabled={opening} aria-label="选择项目打开方式"><ChevronDown className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger></HeaderTooltip>
            <DropdownMenuContent align="end" sideOffset={8} className="w-44 rounded-xl p-2 shadow-float">
              <DropdownMenuItem disabled={opening} onSelect={() => void openProject("explorer")}><FileSystemIcon name="" isDirectory />资源管理器</DropdownMenuItem>
              <DropdownMenuItem disabled={opening} onSelect={() => void openProject("terminal")}>
                <img src={getFileIconAssetSource("powershell")} alt="" aria-hidden="true" className="h-4 w-4 shrink-0 object-contain" />终端
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <DropdownMenu onOpenChange={(open) => { if (open) onOverviewOpenChange(false); }}>
          <HeaderTooltip label="更多操作"><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground" aria-label="会话更多操作"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger></HeaderTooltip>
          <DropdownMenuContent align="end" sideOffset={8} className="w-56 rounded-xl p-2 shadow-float">
            {onRename && <DropdownMenuItem onSelect={() => onRename(session)}><Pencil className="h-4 w-4" />重命名</DropdownMenuItem>}
            {onUpdate && <><DropdownMenuItem onSelect={() => onUpdate(session, { pinned: !session.pinned })}>{session.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}{session.pinned ? "取消置顶" : "置顶"}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onUpdate(session, { archived: !session.archived })}><Archive className="h-4 w-4" />{session.archived ? "恢复会话" : "归档会话"}</DropdownMenuItem></>}
            {hasStatus && onOpenStatus && <DropdownMenuItem onSelect={onOpenStatus}>待处理事项</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuSub><DropdownMenuSubTrigger><Copy className="h-4 w-4" />复制</DropdownMenuSubTrigger><DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => void copy(session.title)}>会话标题</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copy(project.rootPath)}>项目路径</DropdownMenuItem>
            </DropdownMenuSubContent></DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openTool("sidechat")}><MessageSquarePlus className="h-4 w-4" />打开侧边聊天</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <HeaderTooltip label="切换摘要"><Button ref={trigger} variant="ghost" size="icon" className={cn("relative h-8 w-8 text-muted-foreground", overviewOpen && "bg-muted text-foreground")} aria-label="任务概览" aria-description={needsAttention ? "有待处理事项" : undefined} aria-expanded={overviewOpen} aria-controls={`development-overview-${session.id}`} onClick={toggleOverview}><Settings2 className="h-4 w-4" />{needsAttention && <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warning" />}</Button></HeaderTooltip>
        {!side.expanded && <>
          <div className="mx-1 h-4 border-l border-border/60" aria-hidden />
          <HeaderTooltip label="打开工作侧栏"><Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" aria-label="打开工作侧栏" aria-expanded={false} onClick={() => { onOverviewOpenChange(false); trigger.current?.focus(); useDevelopmentStore.getState().setSide(session.id, { expanded: true, maximized: false }); }}><SquarePlus className="h-4 w-4" /></Button></HeaderTooltip>
        </>}
      </div>
    </header>
    {overviewCard}
    <Dialog open={!!openError} onOpenChange={(open) => { if (!open) setOpenError(""); }}><DialogContent>
      <DialogHeader><DialogTitle>操作未完成</DialogTitle><DialogDescription>{openError}</DialogDescription></DialogHeader>
      <DialogFooter><Button onClick={() => setOpenError("")}>知道了</Button></DialogFooter>
    </DialogContent></Dialog>
  </></TooltipProvider>;
}
