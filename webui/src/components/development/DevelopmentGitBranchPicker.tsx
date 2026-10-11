import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronDown, GitBranch, GitGraph, LoaderCircle, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DevelopmentApiError, type DevProject, type DevSession } from "@/lib/development-api";
import { cn } from "@/lib/utils";
import { DevelopmentBranchDialog } from "./DevelopmentBranchDialog";
import { DevelopmentGitActions } from "./DevelopmentGitActions";
import { DevelopmentGitGraph } from "./DevelopmentGitGraph";
import { gitActionsApi, type GitAction, type GitBranchContext } from "./git-actions-api";

export function DevelopmentGitBranchPicker({ session, project, branch, dirtyCount, disabled, onChanged,
  triggerClassName, popoverSide = "left", showFooterActions = true, popoverClassName,
}: {
  session: DevSession; project?: DevProject; branch?: string; dirtyCount: number; disabled: boolean; onChanged: () => void;
  triggerClassName?: string; popoverSide?: "top" | "bottom" | "left" | "right";
  showFooterActions?: boolean; popoverClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [context, setContext] = useState<GitBranchContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"create" | "switch" | null>(null);
  const [blockedSwitch, setBlockedSwitch] = useState<GitAction | null>(null);
  const [switchAfterCommit, setSwitchAfterCommit] = useState<string>();
  const [commitOpen, setCommitOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [operation, setOperation] = useState<GitAction | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const switching = useRef(false);
  const changed = useRef(onChanged); changed.current = onChanged;
  useEffect(() => {
    if (!open) { setLoading(false); return; }
    let active = true;
    setQuery(""); setContext(null); setLoading(true);
    void gitActionsApi.branches(session.id).then((value) => {
      if (active) { setContext(value); if (value.pendingAction) { setDialog("switch"); setOpen(false); } }
    }).catch(() => { if (active) { setOpen(false); setError("无法读取分支，请重试。"); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, session.id]);
  useEffect(() => {
    if (operation?.status !== "running") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await gitActionsApi.get(session.id, operation.id); if (active) setOperation(value); }
      catch { if (active) { setOperation(null); setBusy(false); setDialog("switch"); } }
      if (active) timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 500);
    return () => { active = false; clearTimeout(timer); };
  }, [operation?.id, operation?.status, session.id]);
  useEffect(() => {
    if (!operation || operation.status === "running") return;
    setBusy(false);
    if (operation.status === "succeeded") changed.current();
    else if (operation.status === "unknown") setDialog("switch");
    else if (operation.status === "failed" && operation.kind === "switch_branch" && operation.errorCode === "branch_overwrite") setBlockedSwitch(operation);
    else setError(operation.reason || "分支未切换，请重试。");
    setOperation(null);
  }, [operation]);
  const select = async (target: string) => {
    if (switching.current || busy || disabled) return;
    setOpen(false);
    if (target === (context?.branch ?? branch)) return;
    switching.current = true; setBusy(true); setError("");
    let prepared: GitAction | undefined;
    try {
      prepared = await gitActionsApi.prepare(session.id, { requestId: `gitreq_${crypto.randomUUID().replaceAll("-", "")}`,
        kind: "switch_branch", branch: target, paths: [], message: "", remote: "" });
      setOperation(await gitActionsApi.execute(session.id, prepared.id));
    } catch (cause) {
      if (prepared) {
        try {
          const value = await gitActionsApi.get(session.id, prepared.id);
          if (value.status !== "prepared") { setBusy(value.status === "running"); setOperation(value); return; }
        } catch { setBusy(false); setDialog("switch"); return; }
      }
      setBusy(false);
      setError(cause instanceof DevelopmentApiError ? cause.message : "无法确认切换结果，请核对当前分支。");
    } finally { switching.current = false; }
  };
  const choices = (context?.branches ?? []).filter((name) => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <>
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><Button variant="ghost" disabled={disabled || busy} aria-label="切换 Git 分支"
        className={cn("flex h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-2 text-left text-body leading-5 hover:bg-muted/50", triggerClassName)}>
        <GitBranch className="h-4 w-4 shrink-0" /><span className="min-w-0 truncate" title={branch}>{branch || "分支"}</span>
        {busy || loading ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </Button></Popover.Trigger>
      <Popover.Portal><Popover.Content align="start" side={popoverSide} sideOffset={8} className={cn("z-50 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover text-popover-foreground shadow-float", popoverClassName)}>
        <div className="relative border-b border-border p-1"><Search aria-hidden className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="搜索分支" placeholder="搜索分支" className="h-8 rounded-none border-0 bg-transparent pl-8 text-body leading-5 shadow-none focus-visible:ring-0" value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "Enter") { event.preventDefault(); const first = list.current?.querySelector<HTMLButtonElement>("button"); if (event.key === "Enter") first?.click(); else first?.focus(); } }} /></div>
        <div ref={list} role="listbox" aria-label="本地分支" className="max-h-56 overflow-y-auto p-1"
          onKeyDown={(event) => { if (!["ArrowDown", "ArrowUp"].includes(event.key)) return; event.preventDefault(); const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")]; const current = rows.indexOf(document.activeElement as HTMLButtonElement); rows[(current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus(); }}>
          <div className="px-3 py-2 text-body font-medium text-muted-foreground">分支</div>
          {choices.map((name) => { const current = name === (context?.branch ?? branch); return <button key={name} role="option" aria-selected={current} data-branch-current={current ? "true" : undefined} className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-body leading-5 hover:bg-muted/50 focus-visible:bg-muted/50 ${current ? "bg-muted" : ""}`} onClick={() => void select(name)}>
            <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate">{name}</span>{current && dirtyCount > 0 && <span className="mt-1 block text-body leading-5 text-muted-foreground">未提交的更改：{dirtyCount.toLocaleString()} 个文件</span>}</span>{current && <Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
          </button>; })}
          {!choices.length && <p className="px-3 py-2 text-caption text-muted-foreground">{loading ? "正在读取…" : "未找到匹配分支"}</p>}
        </div>
        {showFooterActions && <div className="border-t border-border p-1">
          <Button variant="ghost" disabled={busy || disabled} className="h-9 w-full justify-start gap-2 px-2 text-body" onClick={() => { setOpen(false); setDialog("create"); }}><Plus className="h-4 w-4" />创建并检出新分支…</Button>
          <Button variant="ghost" disabled={busy} className="h-9 w-full justify-start gap-2 px-2 text-body" onClick={() => { setOpen(false); setGraphOpen(true); }}><GitGraph className="h-4 w-4" />Git 图谱</Button>
        </div>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    <DevelopmentBranchDialog session={session} mode={dialog ?? "create"} open={dialog !== null} onOpenChange={(value) => { if (!value) setDialog(null); }} onChanged={onChanged} />
    <Dialog open={!!blockedSwitch} onOpenChange={(value) => { if (!value) setBlockedSwitch(null); }}><DialogContent className="max-w-lg gap-0">
      <DialogHeader><DialogTitle>无法切换分支</DialogTitle><DialogDescription>{blockedSwitch?.reason || `切换到 ${blockedSwitch?.targetBranch || blockedSwitch?.branch} 会覆盖当前未提交的更改。`}</DialogDescription></DialogHeader>
      <div className="space-y-3 py-4"><div className="flex items-center justify-between text-ui"><span>受影响的文件</span><span className="text-muted-foreground">{blockedSwitch?.affectedPaths?.length ?? 0} 个文件</span></div>
        <div className="max-h-56 space-y-1 overflow-y-auto">{(blockedSwitch?.affectedPaths ?? []).map((path) => <div key={path} className="truncate rounded-md bg-muted/40 px-3 py-2 text-ui" title={path}>{path}</div>)}</div>
      </div>
      <DialogFooter><Button variant="outline" onClick={() => setBlockedSwitch(null)}>取消</Button><Button disabled={!project} onClick={() => { setSwitchAfterCommit(blockedSwitch?.targetBranch || blockedSwitch?.branch); setBlockedSwitch(null); setCommitOpen(true); }}>提交并切换分支…</Button></DialogFooter>
    </DialogContent></Dialog>
    {project && commitOpen && <DevelopmentGitActions key={session.id} project={project} session={session} open={commitOpen} onOpenChange={(value) => { setCommitOpen(value); if (!value) setSwitchAfterCommit(undefined); }} onChanged={onChanged} switchAfterCommit={switchAfterCommit} />}
    <DevelopmentGitGraph session={session} open={graphOpen} onOpenChange={setGraphOpen} />
    <Dialog open={!!error} onOpenChange={(value) => { if (!value) setError(""); }}><DialogContent><DialogHeader><DialogTitle>分支操作未完成</DialogTitle><DialogDescription>{error}</DialogDescription></DialogHeader><DialogFooter><Button onClick={() => setError("")}>关闭</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
