import { useEffect, useId, useLayoutEffect, useRef, useState, type ElementType } from "react";
import { createPortal } from "react-dom";
import { Archive, Folder, FolderOpen, LoaderCircle, Monitor, MoreHorizontal, Pencil, Pin, SquareTerminal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem as ContextItem,
  ContextMenuSeparator,
  ContextMenuSub as ContextSub,
  ContextMenuSubContent as ContextSubContent,
  ContextMenuSubTrigger as ContextSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem as DropdownItem, DropdownMenuSub as DropdownSub,
  DropdownMenuSubContent as DropdownSubContent, DropdownMenuSubTrigger as DropdownSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { executorLabels, isRunActive, type DevProject, type DevSession } from "@/lib/development-api";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { DevelopmentListTitle } from "./DevelopmentListTitle";

type SessionMenuPrimitives = { Item: ElementType; Sub: ElementType; SubContent: ElementType; SubTrigger: ElementType };
const dropdownMenuPrimitives: SessionMenuPrimitives = {
  Item: DropdownItem, Sub: DropdownSub, SubContent: DropdownSubContent, SubTrigger: DropdownSubTrigger,
};
const contextMenuPrimitives: SessionMenuPrimitives = {
  Item: ContextItem, Sub: ContextSub, SubContent: ContextSubContent, SubTrigger: ContextSubTrigger,
};

function age(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时`;
  return `${Math.floor(minutes / 1440)} 天`;
}

export function DevelopmentSessionRow({ project, session, active, visible, onSelect, onRename, onUpdate, onDelete, onOpenTerminal, hoverEnabled = true, onHoverOpen }: {
  project: DevProject;
  session: DevSession;
  active: boolean;
  visible: boolean;
  onSelect: () => void;
  onRename: () => void;
  onUpdate: (changes: Partial<Pick<DevSession, "pinned" | "archived">>) => void;
  onDelete: () => Promise<void>;
  onOpenTerminal: () => void | Promise<void>;
  hoverEnabled?: boolean;
  onHoverOpen?: () => void;
}) {
  const row = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null), actions = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hover, setHover] = useState(false), [menu, setMenu] = useState(false), [contextMenuOpen, setContextMenuOpen] = useState(false), [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const cardId = useId();
  const inspecting = visible && hoverEnabled && hover && !menu && !contextMenuOpen && !confirmDelete;
  const clearTimer = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const closeInfo = () => { clearTimer(); setHover(false); };
  const scheduleOpen = () => { clearTimer(); if (visible && !menu && !contextMenuOpen && !confirmDelete) { onHoverOpen?.(); setHover(true); } };
  const scheduleClose = () => { clearTimer(); timer.current = setTimeout(() => setHover(false), 130); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { if (!visible) { clearTimer(); setHover(false); setMenu(false); setContextMenuOpen(false); } }, [visible]);
  useLayoutEffect(() => {
    if (!inspecting || !row.current || !card.current) return;
    const anchor = row.current.getBoundingClientRect(), popup = card.current.getBoundingClientRect();
    const left = anchor.right + 8 + popup.width <= window.innerWidth - 8
      ? anchor.right + 8 : Math.max(8, anchor.left - popup.width - 8);
    setPosition({ left, top: Math.max(8, Math.min(anchor.top, window.innerHeight - popup.height - 8)) });
  }, [inspecting]);
  useEffect(() => {
    if (!inspecting) return;
    const outside = (event: PointerEvent) => {
      if (!row.current?.contains(event.target as Node) && !card.current?.contains(event.target as Node)) setHover(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setHover(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [inspecting]);

  const openFolder = async () => {
    closeInfo(); setError("");
    if (!isTauri()) { setError("请在 Mona 桌面端打开资源管理器。"); return; }
    try { const { openPath } = await import("@tauri-apps/plugin-opener"); await openPath(project.rootPath); }
    catch { setError("无法打开项目目录，请确认目录仍然存在且可以访问。"); }
  };
  const openTerminal = async () => {
    closeInfo(); setError("");
    try { await onOpenTerminal(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法打开终端，请检查项目目录和系统终端后重试。"); }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try { await onDelete(); setConfirmDelete(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "永久删除失败，原会话仍保留。"); }
    finally { setBusy(false); }
  };
  const renderMenuItems = (primitives: SessionMenuPrimitives) => {
    const { Item, Sub, SubContent, SubTrigger } = primitives;
    return <>
      <Item onSelect={onRename}><Pencil className="h-4 w-4" />重命名</Item>
      <Item onSelect={() => onUpdate({ archived: !session.archived })}><Archive className="h-4 w-4" />{session.archived ? "恢复" : "归档"}</Item>
      <Sub>
        <SubTrigger><FolderOpen className="h-4 w-4" />打开方式</SubTrigger>
        <SubContent className="w-44 rounded-xl p-1.5 shadow-float">
          <Item onSelect={() => void openFolder()}><Folder className="h-4 w-4" />资源管理器</Item>
          <Item onSelect={() => void openTerminal()}><SquareTerminal className="h-4 w-4" />终端</Item>
        </SubContent>
      </Sub>
      <Item className="text-destructive focus:text-destructive" disabled={busy}
        onSelect={() => { setError(""); setConfirmDelete(true); }}><Trash2 className="h-4 w-4" />永久删除</Item>
    </>;
  };
  const statusAge = age(session.updatedAt);
  const model = session.model ? ` · ${session.model}` : "";
  const running = isRunActive(session.latestRun);

  return <>
    <ContextMenu key={visible ? "visible" : "hidden"} onOpenChange={(open) => {
      setContextMenuOpen(open);
      if (open) { closeInfo(); setMenu(false); }
    }}>
      <ContextMenuTrigger asChild disabled={!visible}>
    <div ref={row} data-testid={`development-session-${session.id}`} data-actions-visible={menu || contextMenuOpen}
      className={cn("development-list-row group/task relative flex h-8 items-center rounded-lg px-1", active ? "bg-muted" : "hover:bg-muted/50", (menu || contextMenuOpen || inspecting) && "bg-muted/60")}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") scheduleOpen(); }} onPointerLeave={scheduleClose}
      onBlur={(event) => { if (!row.current?.contains(event.relatedTarget) && !card.current?.contains(event.relatedTarget)) scheduleClose(); }}>
      <button type="button" className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left text-ui outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-current={active ? "page" : undefined} aria-label={`打开开发任务：${session.title}`} aria-describedby={inspecting ? cardId : undefined}
        onClick={() => { closeInfo(); onSelect(); }} onFocus={scheduleOpen}>
        <DevelopmentListTitle text={session.title} actionsRef={actions} />
        {running && <LoaderCircle aria-hidden="true" className={cn("h-3 w-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none group-hover/task:invisible group-focus-within/task:invisible [@media(hover:none)]:invisible", (menu || contextMenuOpen) && "invisible")} />}
      </button>
      <div ref={actions} data-session-actions className={cn("absolute inset-y-0 right-1 z-10 flex items-center gap-0.5 opacity-0 pointer-events-none group-hover/task:opacity-100 group-hover/task:pointer-events-auto group-focus-within/task:opacity-100 group-focus-within/task:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto", (menu || contextMenuOpen) && "opacity-100 pointer-events-auto")}>
        <DropdownMenu open={menu} onOpenChange={(open) => { closeInfo(); if (open) setContextMenuOpen(false); setMenu(open); }}>
          <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" aria-label={`${session.title} 更多操作`}><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52 rounded-xl p-1.5 shadow-float" onCloseAutoFocus={(event) => event.preventDefault()}>
            {renderMenuItems(dropdownMenuPrimitives)}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" aria-label={session.pinned ? "取消置顶任务" : "置顶任务"}
          onClick={() => { closeInfo(); onUpdate({ pinned: !session.pinned }); }}>
          <Pin className={cn("h-3.5 w-3.5", session.pinned && "fill-current")} />
        </Button>
      </div>
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52 rounded-xl p-1.5 shadow-float" onCloseAutoFocus={(event) => event.preventDefault()}>
        <ContextItem onSelect={() => onUpdate({ pinned: !session.pinned })}>
          <Pin className={cn("h-4 w-4", session.pinned && "fill-current")} />{session.pinned ? "取消置顶" : "置顶"}
        </ContextItem>
        <ContextMenuSeparator />
        {renderMenuItems(contextMenuPrimitives)}
      </ContextMenuContent>
    </ContextMenu>
    {inspecting && createPortal(<div ref={card} id={cardId} role="dialog" aria-label={`${session.title} 任务详情`} style={position}
      className="fixed z-50 w-80 max-w-[calc(100vw-1rem)] rounded-2xl border border-border/70 bg-popover p-3 text-popover-foreground shadow-float"
      onPointerEnter={clearTimer} onPointerLeave={scheduleClose} onFocus={clearTimer}>
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-body font-semibold">{session.title}</h3>
        <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
        {statusAge && <span className="shrink-0 text-caption text-muted-foreground">{statusAge}</span>}
      </div>
      <p className="mt-2 truncate text-caption text-muted-foreground">{executorLabels[session.executor]}{model}</p>
      <p className="mt-3 flex items-center gap-2 border-t border-border/60 pt-3 text-ui"><Folder className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate">{project.displayName}</span></p>
    </div>, document.body)}
    <Dialog open={!!error && !confirmDelete} onOpenChange={(open) => { if (!open) setError(""); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>操作未完成</DialogTitle><DialogDescription>{error}</DialogDescription></DialogHeader>
        <DialogFooter><Button onClick={() => setError("")}>知道了</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={confirmDelete} onOpenChange={(open) => { if (!busy) { setConfirmDelete(open); if (!open) setError(""); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>永久删除任务</DialogTitle>
          <DialogDescription>永久删除「{session.title}」的会话记录、执行历史和子智能体会话，并取消关联执行。项目文件保留，此操作无法撤销。</DialogDescription></DialogHeader>
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? "正在删除…" : "永久删除"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
