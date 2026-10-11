import { useEffect, useRef, useState } from "react";
import { GitBranch, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { developmentApi, executorLabels, type DevProject, type DevReviewSource, type DevSession, type DevExecutor, type GitSummary } from "@/lib/development-api";
import { cn } from "@/lib/utils";
import { DevelopmentDiff } from "./DevelopmentDiff";
import { DevelopmentGitUnavailable } from "./DevelopmentGitUnavailable";
import type { SubagentPreset } from "./workspace-api";
import { dispatchCollaboration, PendingCollaborationNotice } from "./collaboration-requests";
import { refreshDevelopmentSession } from "./useDevelopmentSession";

export function DevelopmentReview({ project, session, executors, presets, onOpenAgent, onConfigure, presetsError, onRetryPresets }: {
  project: DevProject; session: DevSession; executors: DevExecutor[]; presets: SubagentPreset[]; onOpenAgent: (id: string) => void;
  onConfigure?: () => void; presetsError?: string; onRetryPresets?: () => void;
}) {
  const [summary, setSummary] = useState<GitSummary | null>(null);
  const [diff, setDiff] = useState("");
  const [source, setSource] = useState<DevReviewSource | null>(null);
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [presetId, setPresetId] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const [childId, setChildId] = useState<string | null>(null);
  const mounted = useRef(true);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [diffError, setDiffError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const refresh = async (force = false) => {
    const request = ++generation.current;
    setBusy(true); setError(""); setDiffError("");
    try {
      const value = await developmentApi.git(project.id, force);
      if (request === generation.current) {
        setSummary(value);
        if (!value.available) { setDiff(""); setSource(null); setConfirm(false); }
      }
    }
    catch (e) { if (request === generation.current) { setSummary(null); setDiff(""); setSource(null); setConfirm(false); setError(e instanceof Error ? e.message : "变更读取失败"); } }
    finally { if (request === generation.current) setBusy(false); }
  };
  useEffect(() => {
    mounted.current = true; setSummary(null); setDiff(""); setSource(null); setPath(""); setChildId(null); setConfirm(false); setDispatching(false);
    void refresh();
    return () => { mounted.current = false; generation.current += 1; };
  }, [project.id, session.id]);
  const readDiff = async (file: string) => {
    const request = ++generation.current;
    setBusy(true); setError(""); setDiffError(""); setPath(file); setDiff(""); setSource(null); setChildId(null);
    try { const value = await developmentApi.reviewDiff(project.id, file); if (request === generation.current) { setDiff(value.diff); setSource(value.source); } }
    catch (e) { if (request === generation.current) setDiffError(e instanceof Error ? e.message : "差异读取失败"); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const dispatch = async () => {
    if (dispatching || busy || !summary?.available || !source || !diff) return;
    const chosen = presets.find((p) => p.id === presetId);
    if (!chosen?.enabled || !chosen.readonly || !available(chosen)) { setError("请选择可用的只读子智能体配置。"); return; }
    if (diff.length > 16000) { setError("差异超出单次审查范围，请选择具体文件后审查；没有截断差异或启动任务。"); return; }
    setDispatching(true); setError("");
    const request = generation.current;
    try {
      const result = await dispatchCollaboration(session.id, "review", {
        executor: executorForPreset(chosen), presetId: chosen.id,
        goal: `审查 ${source.path || "当前项目差异"}`, reviewSource: source,
        expectedOutput: "按严重程度报告文件、行号和问题；只审查所给版本。", readonly: true,
      }, async () => {
        const latest = await developmentApi.reviewDiff(project.id, path);
        if (!mounted.current || request !== generation.current) throw new Error("审查视图已变化，尚未派发新任务。");
        if (latest.source.version !== source.version || latest.source.path !== source.path) {
          setConfirm(false);
          throw new Error("代码已变化。请重新读取差异，再确认审查；原审查没有重复派发。");
        }
      });
      refreshDevelopmentSession(session.id);
      if (mounted.current && request === generation.current) { setChildId(result.childSessionId); setConfirm(false); }
    } catch (cause) { if (mounted.current && request === generation.current) setError(cause instanceof Error ? cause.message : "审查派发结果待核对，重试将使用同一请求。"); }
    finally { if (mounted.current && request === generation.current) setDispatching(false); }
  };
  const choices = presets.filter((preset) => preset.enabled && preset.readonly);
  const executorForPreset = (preset: SubagentPreset) => preset.inheritModel ? session.executor : preset.executor;
  const available = (preset: SubagentPreset) => executors.some((e) => e.id === executorForPreset(preset) && e.available);
  const chosen = choices.find((preset) => preset.id === presetId);
  return <div className="flex h-full min-h-0 flex-col bg-background">
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-caption">
      <GitBranch className="h-3.5 w-3.5" /><span className="min-w-0 flex-1 truncate">{summary?.branch || "工作区变更"}</span>
      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="刷新工作区变更" disabled={busy || dispatching} onClick={() => void refresh(true)}><RefreshCw className="h-3.5 w-3.5" /></Button>
    </div>
    <p className="shrink-0 px-4 py-3 text-caption text-muted-foreground">工作区变更 · 包含人工和其他会话的修改</p>
    {error && !confirm && <p role="alert" className="px-3 py-2 text-caption text-destructive">{error}</p>}
    <PendingCollaborationNotice sessionId={session.id} surface="review" onResolved={(record) => { setChildId(record.childSessionId); setConfirm(false); setError(""); }} />
    {summary && !summary.available && <div className="p-4"><DevelopmentGitUnavailable reasonCode={summary.reasonCode} reason={summary.reason} checking={busy} onRecheck={() => void refresh(true)} /></div>}
    {summary?.available && <>
      <div className="mx-3 mb-2 flex items-center gap-2"><div className="relative min-w-0 flex-1"><Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" /><Input aria-label="筛选变更文件" className="h-8 pl-7 text-caption" placeholder="筛选变更文件" value={query} onChange={(e) => setQuery(e.target.value)} /></div><Button variant="ghost" size="sm" className="h-8 shrink-0" disabled={busy || dispatching || !summary.files.length} aria-pressed={!!source && path === ""} onClick={() => void readDiff("")}>全部变更</Button></div>
      <div className="max-h-48 shrink-0 overflow-auto py-1">
        {!summary.files.length && <p className="px-3 py-3 text-caption text-muted-foreground">工作区没有待提交变更。</p>}
        {summary.files.filter((file) => file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((file) => <button key={file.path} className={cn("flex w-full items-center gap-2 px-4 py-2 text-left text-ui hover:bg-muted/50", file.path === path && "bg-muted")} aria-pressed={file.path === path} disabled={dispatching} onClick={() => void readDiff(file.path)}>
          <span className="w-6 shrink-0 font-mono text-caption text-muted-foreground">{file.status}</span><span className="truncate">{file.path}</span>
        </button>)}
      </div>
      <div className="flex shrink-0 items-center gap-2 px-3 py-2"><span className="min-w-0 flex-1 truncate text-caption" title={path}>{path || (source || diffError ? "全部变更" : "选择文件查看差异")}</span>
        {(path || source || diffError) && (diffError
          ? <Button variant="outline" size="sm" disabled={busy || dispatching} onClick={() => void readDiff(path)}>重试读取差异</Button>
          : <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="重新读取差异" disabled={busy || dispatching} onClick={() => void readDiff(path)}><RefreshCw className="h-3.5 w-3.5" /></Button>)}
        <Button variant="outline" size="sm" disabled={!source || !diff || busy || dispatching} onClick={() => { setError(""); setPresetId(choices.find(available)?.id ?? ""); setConfirm(true); }}><ShieldCheck className="mr-1 h-3.5 w-3.5" />只读审查</Button>
      </div>
      {source && <p className="px-3 pb-2 text-caption text-muted-foreground" title={source.version}>审查资料版本 {source.version.slice(0, 10)}</p>}
      {childId && <div role="status" className="flex items-center gap-2 bg-muted/40 px-3 py-2 text-caption"><span className="flex-1">已找到审查任务，结果以实际执行记录为准。</span><Button variant="ghost" size="sm" onClick={() => onOpenAgent(childId)}>查看审查</Button></div>}
      {busy ? <p role="status" className="p-4 text-caption text-muted-foreground">正在读取…</p> : diffError ? <p role="alert" className="p-4 text-caption text-destructive">差异读取失败：{diffError}</p> : diff ? <DevelopmentDiff value={diff} /> : <p className="p-4 text-caption text-muted-foreground">{source ? "此范围没有可展示的差异。" : "选择一个变更文件查看差异。"}</p>}
    </>}
    <Dialog open={confirm} onOpenChange={(open) => { if (!dispatching) setConfirm(open); }}><DialogContent><DialogHeader><DialogTitle>审查本次差异</DialogTitle><DialogDescription>创建独立只读子会话，传入所显示的差异和版本；不修改文件，不中断主任务。</DialogDescription></DialogHeader>
      <p className="break-all text-ui">{path || "全部变更"}</p>
      {choices.length ? <label className="grid gap-2 text-caption">审查配置<select aria-label="审查子智能体" className="h-9 rounded-md border border-input bg-background px-2" value={presetId} disabled={dispatching} onChange={(e) => setPresetId(e.target.value)}>{!chosen && <option value="" disabled>请选择只读子智能体配置</option>}{choices.map((p) => <option key={p.id} value={p.id} disabled={!available(p)}>{p.name} · {executorLabels[p.executor]}</option>)}</select></label>
        : presetsError ? <div className="space-y-2"><p role="alert" className="text-caption text-destructive">子智能体配置读取失败：{presetsError}</p>{onRetryPresets && <Button variant="outline" onClick={onRetryPresets}>重试读取配置</Button>}</div>
        : <div className="space-y-2"><p className="text-caption text-muted-foreground">尚未配置可用的只读子智能体。</p>{onConfigure && <Button variant="outline" onClick={() => { setConfirm(false); onConfigure(); }}>配置子智能体</Button>}</div>}
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={dispatching} onClick={() => setConfirm(false)}>取消</Button><Button disabled={dispatching || !chosen || !available(chosen)} onClick={() => void dispatch()}>{dispatching ? "正在派发…" : "开始只读审查"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
