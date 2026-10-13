import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SubsectionLabel } from "@/components/ui/page-header";
import { cloudSyncApi, type CloudDraft, type CloudStatus } from "@/lib/cloud-sync";
import { CloudHistoryDialog } from "./CloudHistoryDialog";
import { CloudCleanupDialog } from "./CloudCleanupDialog";

const phases: Record<string, string> = { idle: "已同步", syncing: "同步中", paused: "已暂停", waiting: "等待当前任务结束", pending: "等待继续同步", error: "同步未完成" };
function size(bytes: number) { return `${(bytes / 1_000_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} GB`; }
function message(error: unknown) { return error instanceof Error ? error.message : "操作尚未完成，请稍后重试。"; }

export function CloudSyncSettings({ onUpgrade }: { onUpgrade?: () => void }) {
  const [state, setState] = useState<CloudStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"setup" | "scope" | null>(null);
  const [draft, setDraft] = useState<CloudDraft | null>(null);
  const [recovery, setRecovery] = useState("");
  const [savedKey, setSavedKey] = useState(false);
  const [keys, setKeys] = useState<string[]>([]);
  const [syncNew, setSyncNew] = useState(false);
  const [syncPlanning, setSyncPlanning] = useState(false);
  const [syncNotes, setSyncNotes] = useState(false);
  const generation = useRef(0);
  const mutation = useRef(false);
  const alive = useRef(false);
  const readAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const revision = ++generation.current;
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    try {
      const value = await cloudSyncApi.status(controller.signal);
      if (alive.current && generation.current === revision) setState(value);
    } catch (cause) {
      if (alive.current && generation.current === revision && !(cause instanceof Error && cause.name === "AbortError")) {
        setState({ available: false, enabled: false, phase: "error", problem: { code: "unavailable", message: message(cause) } });
      }
    } finally {
      if (alive.current && generation.current === revision) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; generation.current += 1; readAbort.current?.abort(); };
  }, [refresh]);
  useEffect(() => {
    if (!state?.enabled) return;
    const timer = window.setInterval(() => { if (!mutation.current) void refresh(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh, state?.enabled]);

  const operate = async (action: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true); setError("");
    try { await action(); }
    catch (cause) { if (alive.current) setError(message(cause)); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  const close = () => {
    if (mutation.current) return;
    setView(null); setDraft(null); setRecovery(""); setSavedKey(false); setError("");
  };
  const prepare = () => operate(async () => {
    const value = await cloudSyncApi.prepare(recovery);
    if (!alive.current) return;
    setDraft(value);
    setKeys(state?.space ? [...(state.selected_keys ?? [])] : value.candidates.map((item) => item.key));
    setSyncNew(state?.space ? state.sync_new_conversations === true : true);
    setSyncPlanning(state?.space ? state.sync_planning === true : false);
    setSyncNotes(state?.space ? state.sync_notes === true : false);
  });
  const candidates = draft?.candidates ?? state?.candidates ?? [];
  const space = state?.space;
  const occupied = space ? space.used_bytes + space.reserved_bytes : 0;

  return <section aria-label="云同步">
    <div className="mb-2 flex items-center justify-between gap-3 px-1">
      <SubsectionLabel>云同步</SubsectionLabel>
      <Button variant="ghost" size="sm" disabled={loading || busy} onClick={() => void refresh()} aria-label="刷新云空间">
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />刷新
      </Button>
    </div>
    <div className="rounded-lg border border-border/60 bg-card px-4 py-4 sm:px-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-body font-medium"><Cloud className="h-4 w-4" />个人云空间</div>
          <p className="mt-1 text-caption text-muted-foreground">
            {loading ? "正在读取云空间…" : !state?.available ? state?.problem?.message : state.enabled
              ? (state.phase !== "idle" ? phases[state.phase] ?? "等待同步" : state.last_sync ? "已同步" : "等待首次同步") : "未开启同步"}
          </p>
        </div>
        {!loading && state?.available && (state.plan === "free" && !state.space
          ? <Button size="sm" variant="outline" onClick={onUpgrade}>查看 Pro</Button>
          : <Button size="sm" variant="outline" disabled={busy} onClick={() => {
            if (state.enabled) void operate(async () => { const result = await cloudSyncApi.pause(); if (result.enabled !== false) throw new Error("暂停结果尚未确认。"); await refresh(); });
            else { setView("setup"); setDraft(null); setSavedKey(false); setRecovery(""); }
          }}>{state.enabled ? "暂停同步" : "开启同步"}</Button>)}
      </div>
      {space && <div className="mt-4">
        <div className="mb-1.5 flex justify-between text-caption text-muted-foreground"><span>空间使用</span><span>{size(space.used_bytes)} / {size(space.quota_bytes)}</span></div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="云空间使用量" aria-valuenow={Math.min(100, Math.round(occupied / Math.max(space.quota_bytes, 1) * 100))} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary" style={{ width: `${Math.min(100, occupied / Math.max(space.quota_bytes, 1) * 100)}%` }} />
        </div>
        {space.reserved_bytes > 0 && <p className="mt-1.5 text-caption text-muted-foreground">上传预留 {size(space.reserved_bytes)}</p>}
      </div>}
      {state?.available && <p className="mt-3 text-caption text-muted-foreground">同步工作会话及关联文件，可选笔记、日程与待办；不包含开发会话、项目目录和 AI 自动任务。</p>}
      {state?.enabled && <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || state.phase === "syncing"} onClick={() => void operate(async () => {
          const result = await cloudSyncApi.sync(); if (!result.scheduled) throw new Error("同步请求尚未确认。"); await refresh();
        })}>{state.phase === "syncing" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}立即同步</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setKeys(state.selected_keys ?? []); setSyncNew(state.sync_new_conversations === true); setSyncPlanning(state.sync_planning === true); setSyncNotes(state.sync_notes === true); setView("scope"); }}>同步范围</Button>
        {state.last_sync && <span className="text-caption text-muted-foreground">最近同步 {new Date(state.last_sync * 1000).toLocaleString("zh-CN")}</span>}
      </div>}
      {state?.available && space && <div className="mt-3"><CloudCleanupDialog disabled={busy} onCleaned={() => void refresh()} /></div>}
      {state?.available && !!state.conversations?.some((item) => item.version > 0) && <div className="mt-3">
        <CloudHistoryDialog conversations={state.conversations} candidates={state.candidates ?? []} onRestored={() => void refresh()} />
      </div>}
      {state?.enabled && state.problem && <p className="mt-3 text-caption text-destructive" role="status">{state.problem.message}</p>}
    </div>
    <Dialog open={view !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader><DialogTitle>{view === "scope" ? "同步范围" : "开启云同步"}</DialogTitle>
          <DialogDescription>{view === "scope" ? "选择需要同步的内容。取消选择不会删除本地资料或已有云版本。" : "文件在本机加密后上传。恢复密钥用于在其他设备解密，重置账号密码不能找回丢失的密钥。"}</DialogDescription>
        </DialogHeader>
        {view === "setup" && !draft && <>
          {state?.needs_key && <Input type="password" autoComplete="off" aria-label="云空间恢复密钥" placeholder="粘贴恢复密钥" value={recovery} onChange={(event) => setRecovery(event.target.value)} disabled={busy} />}
          <Button disabled={busy || !!state?.needs_key && !recovery.trim()} onClick={() => void prepare()}>{busy ? "正在核对…" : state?.needs_key ? "核对恢复密钥" : "继续"}</Button>
        </>}
        {draft?.new_space && draft.recovery && <div className="space-y-3">
          <Input readOnly aria-label="请保存恢复密钥" value={draft.recovery} onFocus={(event) => event.currentTarget.select()} />
          <label className="flex items-center gap-2 text-caption"><Checkbox checked={savedKey} onCheckedChange={(value) => setSavedKey(value === true)} disabled={busy} />我已将恢复密钥保存到安全位置</label>
        </div>}
        {(draft || view === "scope") && <div className="space-y-2">
          <label className="flex items-center gap-2 pb-2 text-caption">
            <Checkbox checked={syncNew} disabled={busy} onCheckedChange={(value) => setSyncNew(value === true)} />
            自动同步此后新建的工作会话
          </label>
          <label className="flex items-center gap-2 pb-2 text-caption">
            <Checkbox checked={syncPlanning} disabled={busy} onCheckedChange={(value) => setSyncPlanning(value === true)} />
            同步现有及后续的日程与待办
          </label>
          <label className="flex items-center gap-2 pb-2 text-caption">
            <Checkbox checked={syncNotes} disabled={busy} onCheckedChange={(value) => setSyncNotes(value === true)} />
            同步本机笔记仓库及关联附件
          </label>
          <div className="flex justify-between text-caption"><span>工作会话（{keys.length}）</span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setKeys(keys.length === candidates.length ? [] : candidates.map((item) => item.key))}>{keys.length === candidates.length ? "取消全选" : "全选"}</Button></div>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {candidates.map((item) => <label key={item.key} className="flex items-center gap-2 text-body">
              <Checkbox checked={keys.includes(item.key)} disabled={busy} onCheckedChange={(value) => setKeys((current) => value === true ? [...current, item.key] : current.filter((key) => key !== item.key))} />
              <span className="truncate">{item.title}</span>
            </label>)}
            {!candidates.length && <p className="text-caption text-muted-foreground">本机暂无可同步会话，仍可接收云端已有记录。</p>}
          </div>
        </div>}
        {error && <p className="text-caption text-destructive" role="alert">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={close}>取消</Button>
          {(draft || view === "scope") && <Button disabled={busy || !!draft?.new_space && !savedKey} onClick={() => void operate(async () => {
            if (view === "scope") await cloudSyncApi.scope(keys, syncNew, syncPlanning, syncNotes);
            else if (draft) { const result = await cloudSyncApi.enable(draft.draft_id, keys, syncNew, syncPlanning, syncNotes); if (!result.enabled) throw new Error("尚未确认开启同步。"); }
            if (!alive.current) return;
            setView(null); setDraft(null); setRecovery(""); setSavedKey(false); await refresh();
          })}>{busy ? "保存中…" : view === "scope" ? "保存范围" : "确认开启"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!error && view === null} onOpenChange={(open) => { if (!open) setError(""); }}>
      <DialogContent><DialogHeader><DialogTitle>同步操作未完成</DialogTitle><DialogDescription>{error}</DialogDescription></DialogHeader><DialogFooter><Button onClick={() => setError("")}>关闭</Button></DialogFooter></DialogContent>
    </Dialog>
  </section>;
}
