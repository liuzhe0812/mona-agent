import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, Folder, FolderGit2, FolderOpen, LoaderCircle, MessageCircle, MoreHorizontal, Pin, PinOff, Settings, SquarePen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import type { DevProject, DevSession } from "@/lib/development-api";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { projectApi, type ProjectInfo } from "./workspace-api";
import { DevelopmentListTitle } from "./DevelopmentListTitle";

interface Props {
  project: DevProject; sessions: DevSession[] | null; sessionsError?: string; expanded: boolean; visible: boolean; creating: boolean;
  onToggle: () => void; onCreate: () => void; onInspect: (open: boolean) => void;
  onChanged: (project: DevProject) => void; onViewArchived: () => void; onReload: () => void;
  hoverEnabled?: boolean; onHoverOpen?: () => void;
}

export function DevelopmentProjectHeader({ project, sessions, sessionsError, expanded, visible, creating, onToggle, onCreate, onInspect, onChanged, onViewArchived, onReload, hoverEnabled = true, onHoverOpen }: Props) {
  const row = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const moreTrigger = useRef<HTMLButtonElement>(null), actions = useRef<HTMLDivElement>(null);
  const skipFocus = useRef(false), pending = useRef(false), keyboard = useRef(false);
  const cardId = useId();
  const [hover, setHover] = useState(false), [menu, setMenu] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [dialog, setDialog] = useState<"edit" | "remove" | "operation" | null>(null);
  const [name, setName] = useState(project.displayName);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [info, setInfo] = useState<ProjectInfo | null>(null), [infoError, setInfoError] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const menusOpen = menu || contextOpen;
  const inspecting = visible && hoverEnabled && hover && !menusOpen && !dialog;
  const mainSessions = sessions?.filter((session) => !session.parentSessionId);
  const clearTimer = () => { clearTimeout(timer.current); };
  const closeInfo = () => { clearTimer(); setHover(false); };
  const scheduleOpen = () => { clearTimer(); if (visible && !menusOpen && !dialog) { onHoverOpen?.(); setHover(true); } };
  const scheduleClose = () => { clearTimer(); timer.current = setTimeout(() => setHover(false), 160); };
  const openDialog = (value: "edit" | "remove") => {
    closeInfo(); setMenu(false); setError(""); setName(project.displayName);
    setDialog(value);
  };
  const closeDialog = () => { if (!busy) { setDialog(null); setError(""); } };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (!visible) { clearTimeout(timer.current); setHover(false); setMenu(false); setContextOpen(false); } }, [visible]);
  useEffect(() => { onInspect(inspecting); return () => onInspect(false); }, [inspecting, onInspect]);
  useEffect(() => {
    if (!inspecting && dialog !== "edit") return;
    let alive = true;
    setInfo(null); setInfoError("");
    void projectApi.info(project.id).then((value) => { if (alive) setInfo(value); })
      .catch(() => { if (alive) setInfoError("仓库信息暂不可用"); });
    return () => { alive = false; };
  }, [inspecting, dialog, project.id]);
  useLayoutEffect(() => {
    if (!inspecting || !row.current || !card.current) return;
    const anchor = row.current.getBoundingClientRect(), popup = card.current.getBoundingClientRect();
    const left = anchor.right + 8 + popup.width <= window.innerWidth - 8
      ? anchor.right + 8 : Math.max(8, anchor.left - popup.width - 8);
    setPosition({ left, top: Math.max(8, Math.min(anchor.top, window.innerHeight - popup.height - 8)) });
    if (keyboard.current) { keyboard.current = false; card.current.querySelector<HTMLButtonElement>("button")?.focus(); }
  }, [inspecting, info, infoError, sessions?.length]);
  useEffect(() => {
    if (!inspecting) return;
    const dismiss = () => setHover(false);
    const outside = (event: PointerEvent) => { if (!row.current?.contains(event.target as Node) && !card.current?.contains(event.target as Node)) dismiss(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); setHover(false);
      if (card.current?.contains(document.activeElement)) { skipFocus.current = true; trigger.current?.focus(); }
    };
    const scroll = (event: Event) => { if (!card.current?.contains(event.target as Node)) dismiss(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", dismiss); window.removeEventListener("scroll", scroll, true);
    };
  }, [inspecting]);

  const update = async (changes: Partial<Pick<DevProject, "displayName" | "pinned" | "removed">>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { const value = await projectApi.update(project, changes); closeInfo(); setDialog(null); onChanged(value); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "项目更新失败，原数据保留。");
      if (!dialog) setDialog("operation");
      onReload();
    }
    finally { pending.current = false; setBusy(false); }
  };
  const openFolder = async () => {
    closeInfo(); setError("");
    if (!isTauri()) { setError("请在 Mona 桌面端打开资源管理器。"); setDialog("operation"); return; }
    try { const { openPath } = await import("@tauri-apps/plugin-opener"); await openPath(project.rootPath); }
    catch { setError("无法打开项目目录，请确认目录仍然存在且可以访问。"); setDialog("operation"); }
  };
  const repository = infoError || (info?.repositoryState === "unavailable" ? "仓库信息暂不可用" : info ? info.repository || "未配置远程仓库" : "正在读取仓库信息…");
  const Icon = expanded ? FolderOpen : Folder;
  const PinIcon = project.pinned ? PinOff : Pin;
  const createTask = () => { closeInfo(); onCreate(); };
  const menuItems = (context = false) => {
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
    return <>
      {context && <><Item disabled={creating} onSelect={createTask}><SquarePen className="h-4 w-4" />新建任务</Item><Separator /></>}
      <Item disabled={busy} onSelect={() => void update({ pinned: !project.pinned })}><PinIcon className="h-4 w-4" />{project.pinned ? "取消置顶" : "置顶"}</Item>
      <Item disabled={busy} onSelect={() => openDialog("edit")}><Settings className="h-4 w-4" />编辑</Item>
      <Separator />
      <Item onSelect={() => void openFolder()}><Folder className="h-4 w-4" />在资源管理器中打开</Item>
      <Separator />
      <Item onSelect={onViewArchived}><Archive className="h-4 w-4" />查看归档任务</Item>
      <Separator />
      <Item disabled={busy || creating} onSelect={() => openDialog("remove")}><X className="h-4 w-4" />移除项目</Item>
    </>;
  };
  return <>
    <ContextMenu key={visible ? "visible" : "hidden"} onOpenChange={(open) => { closeInfo(); setContextOpen(open); if (open) setMenu(false); }}>
    <ContextMenuTrigger asChild disabled={!visible}>
    <div ref={row} data-testid={`project-header-${project.id}`} data-actions-visible={menusOpen || creating} className={cn("development-list-row group/project relative flex h-9 items-center gap-1 rounded-lg px-2 hover:bg-muted/70 focus-within:bg-muted/70", (menusOpen || inspecting) && "bg-muted/70")}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") scheduleOpen(); }} onPointerLeave={scheduleClose}
      onBlur={(event) => { if (!row.current?.contains(event.relatedTarget) && !card.current?.contains(event.relatedTarget)) scheduleClose(); }}>
      <button ref={trigger} type="button" aria-label={project.displayName} aria-expanded={expanded} aria-controls={inspecting ? cardId : undefined}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left text-ui font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => { closeInfo(); onToggle(); }} onFocus={() => { if (skipFocus.current) skipFocus.current = false; else scheduleOpen(); }}
        onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); clearTimer(); keyboard.current = true; onHoverOpen?.(); setHover(true); } }}>
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" /><DevelopmentListTitle text={project.displayName} actionsRef={actions} />
        {project.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="项目已置顶" />}
      </button>
      <div ref={actions} data-project-actions className={cn("absolute inset-y-0 right-2 z-10 flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto", (menusOpen || creating) && "opacity-100 pointer-events-auto")}>
        <DropdownMenu open={menu} onOpenChange={(open) => { closeInfo(); setMenu(open); }}>
          <DropdownMenuTrigger asChild><Button ref={moreTrigger} variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" aria-label={`${project.displayName} 项目操作`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60 rounded-xl p-2 shadow-float" onCloseAutoFocus={(event) => { event.preventDefault(); if (!dialog) moreTrigger.current?.focus(); }}>
            {menuItems()}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" aria-label={`在 ${project.displayName} 新建会话`} disabled={creating}
          onClick={createTask}>{creating ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <SquarePen className="h-4 w-4" />}</Button>
      </div>
    </div>
    </ContextMenuTrigger>
    <ContextMenuContent className="w-60 rounded-xl p-2 shadow-float" onCloseAutoFocus={(event) => event.preventDefault()}>{menuItems(true)}</ContextMenuContent>
    </ContextMenu>
    {inspecting && createPortal(<div ref={card} id={cardId} role="dialog" aria-label={`${project.displayName} 项目信息`} style={position}
      className="fixed z-50 max-h-[calc(100vh-1rem)] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-2xl border border-border/70 bg-popover p-3 text-popover-foreground shadow-float"
      onPointerEnter={clearTimer} onPointerLeave={scheduleClose} onFocus={clearTimer}
      onBlur={(event) => { if (!card.current?.contains(event.relatedTarget) && !row.current?.contains(event.relatedTarget)) scheduleClose(); }}>
      <div className="flex items-center gap-2"><Folder className="h-5 w-5 shrink-0" /><h3 className="min-w-0 flex-1 truncate text-body font-semibold">{project.displayName}</h3><Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" aria-label={project.pinned ? "取消置顶项目" : "置顶项目"} disabled={busy} onClick={() => void update({ pinned: !project.pinned })}><PinIcon className="h-4 w-4" /></Button></div>
      <p className="mt-2 flex items-center gap-2 text-ui"><MessageCircle className="h-4 w-4 text-muted-foreground" />{mainSessions ? `${mainSessions.length} 个任务` : sessionsError ? "聊天数量暂不可用" : "正在读取聊天数量…"}</p>
      <div className="my-3 space-y-2 border-y border-border/60 py-3 text-caption">
        <p className="flex items-start gap-2"><FolderGit2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><span className="break-all">{repository}</span></p>
        <p className="flex items-start gap-2"><Folder className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><span className="break-all">{project.rootPath}</span></p>
      </div>
      <Button variant="ghost" className="h-8 w-full justify-start gap-2 px-1 text-ui" onClick={() => openDialog("edit")}><Settings className="h-4 w-4 text-muted-foreground" />编辑项目</Button>
    </div>, document.body)}
    <Dialog open={!!dialog} onOpenChange={(open) => { if (!open) closeDialog(); }}><DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); skipFocus.current = true; trigger.current?.focus(); }}>
      <DialogHeader><DialogTitle>{dialog === "operation" ? "操作未完成" : dialog === "edit" ? "编辑项目" : "移除项目"}</DialogTitle>
        <DialogDescription>{dialog === "operation" ? "项目操作未完成，请查看错误详情后重新尝试。" : dialog === "edit" ? "修改项目显示名称，不改变本地目录或已有会话。" : `从项目列表移除「${project.displayName}」，不删除本地文件和聊天历史。重新打开此目录可恢复。`}</DialogDescription></DialogHeader>
      {dialog === "edit" && <form id={`${cardId}-edit`} className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void update({ displayName: name.trim() }); }}>
        <label className="grid gap-2 text-caption">项目名称<Input aria-label="项目名称" value={name} maxLength={200} required disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
        <div className="space-y-1 text-caption"><p className="text-muted-foreground">本地目录</p><p className="break-all">{project.rootPath}</p></div>
        <div className="space-y-1 text-caption"><p className="text-muted-foreground">仓库</p><p className="break-all">{repository}</p></div>
      </form>}
      {error && <p role="alert" className="break-words text-caption text-destructive">{error}</p>}
      <DialogFooter>{dialog === "operation" ? <Button onClick={closeDialog}>知道了</Button> : <>
        <Button variant="outline" disabled={busy} onClick={closeDialog}>取消</Button>
        {dialog === "edit" ? <Button type="submit" form={`${cardId}-edit`} disabled={busy || !name.trim()}>保存</Button>
          : <Button disabled={busy} onClick={() => void update({ removed: true })}>{busy ? "处理中…" : "确认移除"}</Button>}
      </>}
      </DialogFooter>
    </DialogContent></Dialog>
  </>;
}
