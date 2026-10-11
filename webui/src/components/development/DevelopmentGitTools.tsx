import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, FileDiff, GitBranch, GitCommitHorizontal, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { developmentApi, type DevProject, type DevSession, type GitSummary } from "@/lib/development-api";
import { DevelopmentPlan } from "./DevelopmentPlan";
import { DevelopmentGitActions } from "./DevelopmentGitActions";
import { DevelopmentGitBranchPicker } from "./DevelopmentGitBranchPicker";
import { DevelopmentGitUnavailable } from "./DevelopmentGitUnavailable";
import { useGitActionDrafts } from "./git-action-drafts";
import { useDevelopmentStore } from "./store";
import { cn } from "@/lib/utils";

export function DevelopmentGitTools({ project, session, visible, embedded = false, onOpenReview }: { project: DevProject; session: DevSession; visible: boolean; embedded?: boolean; onOpenReview?: () => void }) {
  const [open, setOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [summary, setSummary] = useState<GitSummary | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [checking, setChecking] = useState(false);
  const forceRefresh = useRef(false);
  const recheck = () => { forceRefresh.current = true; setRefresh((n) => n + 1); };
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const latestRunId = useDevelopmentStore((s) => s.snapshots[session.id]?.runs[0]?.id);
  const plan = useDevelopmentStore((s) => s.snapshots[session.id]?.plan);
  useEffect(() => {
    if (!visible) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let keepPolling = true;
      const force = forceRefresh.current; forceRefresh.current = false;
      setChecking(true);
      try {
        const value = await developmentApi.git(project.id, force);
        keepPolling = value.available;
        if (!disposed) { setSummary(value); setError(""); }
      }
      catch (cause) { if (!disposed) { setSummary(null); setError(cause instanceof Error ? cause.message : "无法读取 Git 状态"); } }
      finally { if (!disposed) { setChecking(false); if (keepPolling) timer = setTimeout(poll, open ? 4000 : 10000); } }
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [project.id, visible, open, refresh]);
  useEffect(() => {
    if (!open) return;
    const click = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", click); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", click); document.removeEventListener("keydown", key); };
  }, [open]);
  const openReview = () => { useDevelopmentStore.getState().setSide(session.id, { tab: "review", expanded: true }); setOpen(false); onOpenReview?.(); };
  const showActions = (kind?: "commit" | "push") => {
    if (kind) useGitActionDrafts.getState().update(session.id, { kind });
    setOpen(false); setActionsOpen(true);
  };
  return <div ref={root} className="relative shrink-0">
    {embedded ? <section aria-label="Git 工具" className="space-y-0">
      <button type="button" disabled={!summary?.available || !!error} onClick={openReview}
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui hover:bg-muted/50 disabled:cursor-default disabled:opacity-50">
        <FileDiff className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate">更改</span>
        {summary?.available && !error && <span className="shrink-0 font-mono tabular-nums"><span className="text-success">+{summary.additions ?? "—"}</span>{" "}<span className="text-destructive">-{summary.deletions ?? "—"}</span></span>}
      </button>
      <DevelopmentGitBranchPicker key={session.id} project={project} session={session} branch={summary?.branch} dirtyCount={summary?.count ?? 0}
        disabled={!summary?.available || !!error || session.readonly || session.archived} onChanged={recheck} />
      <button type="button" disabled={!summary?.available || !!error || session.readonly || session.archived || !summary.count && summary.canPush === false} onClick={() => showActions(summary?.count ? "commit" : "push")}
        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui hover:bg-muted/50 disabled:cursor-default disabled:opacity-50">
        <GitCommitHorizontal className="h-4 w-4 shrink-0" /><span>提交或推送</span>
      </button>
      {(error || summary && !summary.available) && <Button variant="ghost" size="sm" className="text-caption" onClick={() => setOpen(true)}>{error ? "Git 状态异常" : summary?.reasonCode === "git_unavailable" ? "未检测到 Git" : "非 Git 仓库"}</Button>}
    </section> : <Button ref={trigger} variant="ghost" size="sm" className="h-9 gap-2 rounded-full border border-border/60 bg-popover px-3 text-caption shadow-float hover:bg-muted" aria-expanded={open} aria-controls={`git-${session.id}`} aria-label="Git 工具" onClick={() => setOpen(!open)}>
      <GitBranch className="h-3.5 w-3.5 shrink-0" /><span>{error ? "Git 状态异常" : summary?.reasonCode === "git_unavailable" ? "未检测到 Git" : summary && !summary.available ? "非 Git 仓库" : "更改"}</span>
      {summary?.available && !error ? <><span className="text-success tabular-nums">+{summary.additions ?? "—"}</span><span className="text-destructive tabular-nums">−{summary.deletions ?? "—"}</span></> : !summary && !error ? <span className="text-muted-foreground">…</span> : null}
    </Button>}
    {open && <div id={`git-${session.id}`} role="region" aria-label="Git 工具浮层" className={cn(embedded ? "mt-2" : "absolute right-0 top-full z-40 mt-2 w-96 max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-float")}>
      <div className="flex h-12 items-center gap-2 px-5"><span className="flex-1 text-ui font-medium">Git 工具</span><Button variant="ghost" size="icon" className="h-6 w-6" aria-label="刷新 Git 状态" disabled={checking} onClick={recheck}><RefreshCw className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" className="h-6 w-6" aria-label="关闭 Git 工具" onClick={() => setOpen(false)}><X className="h-3.5 w-3.5" /></Button></div>
      <div className="max-h-[70vh] space-y-4 overflow-auto px-5 pb-5">
        {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : summary?.available ? <>
          <button type="button" className="flex w-full items-center gap-2 rounded-md py-1 text-ui hover:bg-muted/50" onClick={openReview}><span className="min-w-0 flex-1 text-left">更改</span><span className="text-success tabular-nums">+{summary.additions}</span><span className="text-destructive tabular-nums">−{summary.deletions}</span></button>
          <div className="flex items-center gap-2 text-ui"><GitBranch className="h-4 w-4 text-muted-foreground" /><span className="truncate">{summary.branch}</span></div>
          <p className="text-micro text-muted-foreground">工作区 · {summary.count} 个变更项。行数仅统计已跟踪文本，不代表当前会话独占修改。{summary.untrackedFiles ? `另有 ${summary.untrackedFiles} 个未跟踪项。` : ""}</p>
          <button type="button" className="flex w-full items-center gap-2 rounded-md py-2 text-left text-ui hover:bg-muted disabled:opacity-50" disabled={session.readonly || session.archived} onClick={() => showActions()}><GitCommitHorizontal className="h-4 w-4" /><span className="flex-1">提交或推送</span><ArrowUpRight className="h-3.5 w-3.5" /></button>
          <p className="text-caption text-muted-foreground">选择文件后确认提交；推送单独确认。</p>
          <Button variant="outline" size="sm" className="w-full" onClick={openReview}>查看工作区差异</Button>
        </> : summary ? <><DevelopmentGitUnavailable reasonCode={summary.reasonCode} reason={summary.reason} checking={checking} onRecheck={recheck} /><Button variant="ghost" size="sm" onClick={() => showActions()}>查看 Git 操作记录</Button></> : <p className="text-caption text-muted-foreground">正在读取仓库…</p>}
        {plan?.plan.length ? <div className="border-t border-border/60 pt-4"><DevelopmentPlan value={plan} currentRunId={latestRunId} /></div> : null}
      </div>
    </div>}
    <DevelopmentGitActions key={session.id} project={project} session={session} open={actionsOpen} onOpenChange={setActionsOpen} onChanged={() => setRefresh((value) => value + 1)} />
  </div>;
}
