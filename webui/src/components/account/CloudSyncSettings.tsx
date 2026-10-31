import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Cloud, Info, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SubsectionLabel } from "@/components/ui/page-header";
import { TooltipButton } from "@/components/ui/tooltip";
import { cloudSyncApi, type CloudDraft, type CloudFileIssue, type CloudStatus } from "@/lib/cloud-sync";
import { CloudCleanupDialog } from "./CloudCleanupDialog";
import { CloudTrashDialog } from "./CloudTrashDialog";

const phases: Record<string, string> = { idle: "已同步", syncing: "同步中", paused: "已暂停", waiting: "等待当前任务结束", pending: "等待继续同步", partial: "部分内容暂未同步", error: "同步未完成" };
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
  const [keys, setKeys] = useState<string[]>([]);
  const [scopeBlockedKeys, setScopeBlockedKeys] = useState<string[]>([]);
  const [scopeBlockedFiles, setScopeBlockedFiles] = useState<Record<string, CloudFileIssue[]>>({});
  const [syncNew, setSyncNew] = useState(false);
  const [syncPlanning, setSyncPlanning] = useState(false);
  const [syncNotes, setSyncNotes] = useState(false);
  const [syncPreferences, setSyncPreferences] = useState(false);
  const [syncOperations, setSyncOperations] = useState(false);
  const [syncOperationsCredentials, setSyncOperationsCredentials] = useState(false);
  const [showManagement, setShowManagement] = useState(false);
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
        setState({ available: false, enabled: false, upload_enabled: false, phase: "error", problem: { code: "unavailable", message: message(cause) } });
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
    setView(null); setDraft(null); setRecovery(""); setError("");
  };
  const prepare = () => operate(async () => {
    const value = await cloudSyncApi.prepare(recovery);
    if (!alive.current) return;
    setDraft(value);
    setKeys(state?.space ? (state.selected_keys ?? []).filter((key) => value.candidates.some((item) => item.key === key)) : value.candidates.map((item) => item.key));
    setSyncNew(state?.space ? state.sync_new_conversations === true : true);
    setSyncPlanning(state?.space ? state.sync_planning === true : false);
    setSyncNotes(state?.space ? state.sync_notes === true : false);
    setSyncPreferences(state?.space ? state.sync_preferences === true : false);
    setSyncOperations(state?.space ? state.sync_operations === true : false);
    setSyncOperationsCredentials(state?.space ? state.sync_operations === true && state.sync_operations_credentials === true : false);
  });
  const openSetup = () => { setView("setup"); setDraft(null); setRecovery(""); setError(""); };
  const openScope = () => {
    if (!state) return;
    setKeys((state.selected_keys ?? []).filter((key) => state.candidates?.some((item) => item.key === key)));
    setScopeBlockedKeys(state.blocked_keys ?? []);
    setScopeBlockedFiles(state.blocked_files ?? {});
    setSyncNew(state.sync_new_conversations === true);
    setSyncPlanning(state.sync_planning === true);
    setSyncNotes(state.sync_notes === true);
    setSyncPreferences(state.sync_preferences === true);
    setSyncOperations(state.sync_operations === true);
    setSyncOperationsCredentials(state.sync_operations === true && state.sync_operations_credentials === true);
    setError("");
    setView("scope");
  };
  const candidates = draft?.candidates ?? state?.candidates ?? [];
  const candidateKeys = new Set(candidates.map((item) => item.key));
  const selectedKeys = keys.filter((key) => candidateKeys.has(key));
  const allSelected = candidates.length > 0 && candidates.every((item) => keys.includes(item.key));
  const blockedKeys = state?.blocked_keys ?? [];
  const scopeBlocked = new Set((view === "scope" ? scopeBlockedKeys : blockedKeys).filter((key) => candidateKeys.has(key)));
  const selectedBlockedCount = selectedKeys.filter((key) => scopeBlocked.has(key)).length;
  const excludedBlockedCount = scopeBlocked.size - selectedBlockedCount;
  const blockedFiles = view === "scope" ? scopeBlockedFiles : state?.blocked_files ?? {};
  const orderedCandidates = view === "scope" ? [
    ...candidates.filter((item) => scopeBlocked.has(item.key)),
    ...candidates.filter((item) => !scopeBlocked.has(item.key)),
  ] : candidates;
  const hasFileIssues = blockedKeys.length > 0
    || (state?.blocked_keys === undefined && state?.problem?.code === "associated_file_unavailable");
  const space = state?.space;
  const uploadEnabled = state?.upload_enabled === true;
  const occupied = space ? space.used_bytes + space.reserved_bytes : 0;
  const statusLabel = loading ? "正在读取云空间…" : !state?.available ? state?.problem?.message : state.enabled
    ? state.phase !== "idle" ? phases[state.phase] ?? "等待同步" : state.last_sync ? "已同步" : "等待首次同步"
    : space ? "云端内容接收已暂停" : "未开启同步";

  return <section aria-label="云同步">
    <div className="mb-2 flex items-center justify-between gap-3 px-1">
      <SubsectionLabel>云同步</SubsectionLabel>
      <TooltipButton variant="ghost" size="xs" title="刷新云空间用量和同步状态" disabled={loading || busy} onClick={() => void refresh()} aria-label="刷新云空间">
        <RefreshCw className="h-3.5 w-3.5" />
      </TooltipButton>
    </div>
    <div className="rounded-lg border border-border/60 bg-card px-4 py-4 sm:px-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-body font-medium"><Cloud className="h-4 w-4" />个人云空间</div>
          <p className="mt-1 text-caption text-muted-foreground">{statusLabel}</p>
          {state?.available && state.enabled && !uploadEnabled && <p className="mt-0.5 text-caption text-muted-foreground">自动接收已开启；上传本机资料需单独确认。</p>}
        </div>
        {!loading && state?.available && (state.plan === "free" && !state.space
          ? <Button size="sm" variant="outline" onClick={onUpgrade}>查看 Pro</Button>
          : <TooltipButton size="xs" variant="ghost" title={state.enabled ? "暂停接收云端内容，保留本机和云端资料" : space ? "恢复接收云端内容，并保留已授权的上传范围" : "选择要上传的本机资料并开启云同步"} aria-label={state.enabled ? "暂停同步" : space ? "恢复同步" : "开启同步"} disabled={busy} onClick={() => {
            if (state.enabled) void operate(async () => { const result = await cloudSyncApi.pause(); if (result.enabled !== false) throw new Error("暂停结果尚未确认。"); await refresh(); });
            else if (space) void operate(async () => { const result = await cloudSyncApi.resume(); if (result.enabled !== true) throw new Error("恢复结果尚未确认。"); await refresh(); });
            else openSetup();
          }}>{state.enabled ? "暂停同步" : space ? "恢复同步" : "开启同步"}</TooltipButton>)}
      </div>
      {space && <div className="mt-4">
        <div className="mb-1.5 flex justify-between text-caption text-muted-foreground"><span>空间使用</span><span>{size(space.used_bytes)} / {size(space.quota_bytes)}</span></div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="云空间使用量" aria-valuenow={Math.min(100, Math.round(occupied / Math.max(space.quota_bytes, 1) * 100))} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary" style={{ width: `${Math.min(100, occupied / Math.max(space.quota_bytes, 1) * 100)}%` }} />
        </div>
        {space.reserved_bytes > 0 && <p className="mt-1.5 text-caption text-muted-foreground">上传预留 {size(space.reserved_bytes)}</p>}
      </div>}
      {state?.available && <p className="mt-3 text-caption text-muted-foreground">可在本机接收云端已有内容。上传本机工作会话、笔记、日程和偏好需单独确认；不包含开发会话、项目目录和 AI 自动任务。</p>}
      {state?.available && (state.enabled || space) && <div role="group" aria-label="云同步操作" className="mt-3 flex items-center gap-1 overflow-x-auto">
        {state.enabled && <>
        <TooltipButton size="xs" title={uploadEnabled ? "检查云端更新并上传已授权内容" : "立即检查并接收云端更新"} aria-label="立即同步" disabled={busy || state.phase === "syncing"} onClick={() => void operate(async () => {
          const result = await cloudSyncApi.sync(); if (!result.scheduled) throw new Error("同步请求尚未确认。"); await refresh();
        })}>{state.phase === "syncing" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}立即同步</TooltipButton>
        {uploadEnabled && <TooltipButton size="xs" variant="ghost" title="选择要上传的本机资料；不影响接收云端已有内容" aria-label="上传范围" disabled={busy} onClick={openScope}>上传范围</TooltipButton>}
        </>}
        {space && state.needs_key && <TooltipButton size="xs" variant="ghost" title="导入旧空间密钥并确认本机上传范围" aria-label="迁移旧云空间" disabled={busy} onClick={openSetup}>迁移旧云空间</TooltipButton>}
        {space && !uploadEnabled && !state.needs_key && <TooltipButton size="xs" variant="ghost" title="选择要上传的本机资料并明确确认" aria-label="上传本机资料" disabled={busy} onClick={openSetup}>上传本机资料</TooltipButton>}
        {space && <TooltipButton size="xs" variant="ghost" title="查看回收站或清理云空间" aria-label="云空间管理" aria-expanded={showManagement} aria-controls="cloud-space-management" onClick={() => setShowManagement((value) => !value)}>
          云空间管理<ChevronDown className={`ml-1.5 h-3.5 w-3.5 ${showManagement ? "rotate-180" : ""}`} />
        </TooltipButton>}
        {state.enabled && uploadEnabled && hasFileIssues && <TooltipButton size="xs" variant="ghost" className="text-muted-foreground" title="查看暂未上传的会话及具体文件问题" aria-label="查看未上传会话" disabled={busy} onClick={openScope}>
          <Info className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />{blockedKeys.length ? `${blockedKeys.length} 个会话暂未上传` : "部分会话暂未上传"} · 查看原因
        </TooltipButton>}
      </div>}
      {state?.enabled && state.last_sync && <p className="mt-2 text-caption text-muted-foreground">最近同步 {new Date(state.last_sync * 1000).toLocaleString("zh-CN")}</p>}
      {state?.available && space && showManagement && <div id="cloud-space-management" role="group" aria-label="云空间管理操作" className="mt-3 flex items-center gap-1 overflow-x-auto">
        <CloudTrashDialog disabled={busy} onChanged={() => void refresh()} />
        <CloudCleanupDialog disabled={busy} onCleaned={() => void refresh()} />
      </div>}
      {state?.enabled && state.problem && state.problem.code !== "associated_file_unavailable" && <p className="mt-3 text-caption text-destructive" role="status">{state.problem.message}</p>}
    </div>
    <Dialog open={view !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader className="shrink-0"><DialogTitle>{view === "scope" ? "上传本机资料范围" : space ? "上传本机资料" : "开启云同步"}</DialogTitle>
          <DialogDescription>{view === "scope" ? "以下选择只决定本机资料上传范围，不影响接收云端已有内容。保存范围不会删除本地资料或已有云版本。" : "选择要从本机上传的资料并明确确认；接收云端已有内容不受这些选项影响。文件加密后上传，密钥由账号服务加密保管。"}</DialogDescription>
        </DialogHeader>
        {view === "setup" && !draft && <>
          {state?.needs_key && <>
            <p className="text-caption text-muted-foreground">此空间使用旧密钥。可在原设备开启账号自动恢复，或在这里输入旧密钥完成一次迁移。</p>
            <Input type="password" autoComplete="off" aria-label="旧云空间恢复密钥" placeholder="输入旧密钥，仅迁移时需要" value={recovery} onChange={(event) => setRecovery(event.target.value)} disabled={busy} />
          </>}
          <Button disabled={busy || !!state?.needs_key && !recovery.trim()} onClick={() => void prepare()}>{busy ? "正在核对…" : state?.needs_key ? "迁移旧云空间" : "选择要上传的内容"}</Button>
        </>}
        {(draft || view === "scope") && <div className="min-h-0 space-y-2 overflow-y-auto scrollbar-thin">
          <label className="flex items-center gap-2 pb-2 text-caption">
            <Checkbox checked={syncNew} disabled={busy} onCheckedChange={(value) => { setSyncNew(value === true); setError(""); }} />
            上传此后新建的工作会话
          </label>
          <label className="flex items-center gap-2 pb-2 text-caption">
            <Checkbox checked={syncPlanning} disabled={busy} onCheckedChange={(value) => { setSyncPlanning(value === true); setError(""); }} />
            上传本机现有及后续的日程与待办
          </label>
          <label className="flex items-center gap-2 pb-2 text-caption">
            <Checkbox checked={syncNotes} disabled={busy} onCheckedChange={(value) => { setSyncNotes(value === true); setError(""); }} />
            上传本机笔记仓库及关联附件
          </label>
          <label className="flex items-center gap-2 pb-2 text-caption">
            <Checkbox checked={syncPreferences} disabled={busy} onCheckedChange={(value) => { setSyncPreferences(value === true); setError(""); }} />
            上传本机侧栏布局、默认页面、发送按键和快捷问答显示模式
          </label>
          <label className="flex items-center gap-2 pb-1 text-caption">
            <Checkbox checked={syncOperations} disabled={busy} onCheckedChange={(value) => {
              const enabled = value === true;
              setSyncOperations(enabled);
              if (!enabled) setSyncOperationsCredentials(false);
              setError("");
            }} />
            运维主机配置
          </label>
          <label className="ml-6 flex items-center gap-2 pb-1 text-caption text-muted-foreground">
            <Checkbox checked={syncOperationsCredentials} disabled={busy || !syncOperations}
              onCheckedChange={(value) => { setSyncOperationsCredentials(value === true); setError(""); }} />
            包含密码和 SSH 私钥
          </label>
          {syncOperations && <p className="ml-6 pb-2 text-caption text-muted-foreground">自动接收的凭据会安全保存，不会自动连接主机。</p>}
          {view === "scope" && scopeBlocked.size > 0 && <div className="space-y-1">
            <p className="text-caption text-muted-foreground">以下 {scopeBlocked.size} 个会话因关联文件问题暂未上传，其他内容继续同步。可保留选择稍后重试，也可排除这些会话；均不影响保存范围。</p>
            {selectedBlockedCount > 0 && <Button variant="ghost" size="xs" disabled={busy} onClick={() => {
              setKeys((current) => current.filter((key) => !scopeBlocked.has(key))); setError("");
            }}>暂不上传这 {selectedBlockedCount} 个会话</Button>}
            {excludedBlockedCount > 0 && <p className="text-caption text-muted-foreground" role="status">已排除 {excludedBlockedCount} 个会话，保存后生效。</p>}
          </div>}
          <div className="flex justify-between text-caption"><span>上传工作会话（已选 {selectedKeys.length} / 共 {candidates.length}）</span>
            <Button variant="ghost" size="sm" disabled={busy || !candidates.length} onClick={() => { setKeys(allSelected ? [] : candidates.map((item) => item.key)); setError(""); }}>{allSelected ? "取消全选" : "全选"}</Button></div>
          {candidates.length > 0 && <p className="text-caption text-muted-foreground">可不选现有会话，不影响其他资料上传。</p>}
          <div className="space-y-2">
            {orderedCandidates.map((item) => <div key={item.key}>
              <label className="flex items-center gap-2 text-body">
              <Checkbox checked={keys.includes(item.key)} disabled={busy} onCheckedChange={(value) => {
                setKeys((current) => value === true ? [...current, item.key] : current.filter((key) => key !== item.key)); setError("");
              }} />
              <span className="min-w-0"><span className="block truncate">{item.title}</span>
                {scopeBlocked.has(item.key) && <span className="block text-caption text-muted-foreground">{keys.includes(item.key) ? "关联文件暂不可上传，不影响保存范围。" : "已排除，保存后不再上传此会话。"}</span>}
              </span>
              </label>
              {scopeBlocked.has(item.key) && blockedFiles[item.key]?.length > 0 && <details className="ml-6 text-caption text-muted-foreground">
                <summary className="cursor-pointer py-1">查看问题文件（{blockedFiles[item.key].length}）</summary>
                <ul className="space-y-2 pb-1">
                  {blockedFiles[item.key].map((file, index) => <li key={index} className="break-all">
                    <p className="font-medium text-foreground">{file.name}</p>
                    <p>{file.reason === "missing" ? "本机找不到该文件。请放回原位置后，点击“立即同步”重试。" : `文件${file.size === undefined ? "" : `为 ${size(file.size)}，`}超过单文件上传上限${file.limit_bytes === undefined ? "" : ` ${size(file.limit_bytes)}`}。请缩减文件后重试，或排除此会话。`}</p>
                    {file.source_path && <p>原位置：{file.source_path}</p>}
                  </li>)}
                </ul>
              </details>}
            </div>)}
            {!candidates.length && <p className="text-caption text-muted-foreground">本机暂无可同步会话，仍可接收云端已有记录。</p>}
          </div>
        </div>}
        {error && <p className="text-caption text-destructive" role="alert">{error}</p>}
        <DialogFooter className="shrink-0"><Button variant="outline" disabled={busy} onClick={close}>取消</Button>
          {(draft || view === "scope") && <Button disabled={busy} onClick={() => void operate(async () => {
            if (view === "scope") await cloudSyncApi.scope(selectedKeys, syncNew, syncPlanning, syncNotes, syncPreferences, syncOperations, syncOperationsCredentials);
            else if (draft) { const result = await cloudSyncApi.enable(draft.draft_id, selectedKeys, syncNew, syncPlanning, syncNotes, syncPreferences, syncOperations, syncOperationsCredentials); if (!result.enabled) throw new Error("尚未确认开启同步。"); }
            if (!alive.current) return;
            setView(null); setDraft(null); setRecovery(""); await refresh();
          })}>{busy ? "保存中…" : view === "scope" ? "保存上传范围" : draft?.new_space ? "确认开启并上传" : "确认上传本机资料"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!error && view === null} onOpenChange={(open) => { if (!open) setError(""); }}>
      <DialogContent><DialogHeader><DialogTitle>同步操作未完成</DialogTitle><DialogDescription>{error}</DialogDescription></DialogHeader><DialogFooter><Button onClick={() => setError("")}>关闭</Button></DialogFooter></DialogContent>
    </Dialog>
  </section>;
}
