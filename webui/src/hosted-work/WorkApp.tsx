import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, LogOut, MessageSquare, Paperclip, Plus, Send, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { login, newRequestId, WorkApiError, WorkClient, type PendingTurn, type SessionDetail,
  type WorkFile, type WorkModel, type WorkRun, type WorkSession } from "./client";

const SESSION_KEY = "mona-hosted-work-v1";
type Saved = { token: string; selected?: string; pending?: PendingTurn | null; creating?: string | null };
function loadSaved(): Saved {
  try {
    const work = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    const website = JSON.parse(sessionStorage.getItem("mona-website-session-v1") || "null");
    if (typeof website?.token === "string" && website.token && typeof website?.user?.id === "string") {
      return work?.token === website.token ? work : { token: website.token };
    }
    return work || { token: "" };
  }
  catch { return { token: "" }; }
}
function save(value: Saved) { sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); }
function active(run?: WorkRun) { return run?.status === "running" || run?.status === "cancelling"; }
const statusText: Record<string, string> = { running: "正在处理", cancelling: "正在停止", completed: "已完成",
  failed: "未完成", cancelled: "已停止", unknown: "结果待核对", interrupted: "已中断" };

export function WorkApp() {
  const [saved, setSaved] = useState<Saved>(loadSaved);
  const [error, setError] = useState("");
  const report = useCallback((value: unknown) => {
    if (value instanceof DOMException && value.name === "AbortError") return;
    setError(value instanceof WorkApiError ? value.message : "操作未能完成，已有内容保留，请稍后重试。");
  }, []);
  const updateSaved = useCallback((patch: Partial<Saved>) => setSaved(previous => {
    const next = { ...previous, ...patch }; save(next); return next;
  }), []);
  async function signOut() {
    await new WorkClient(saved.token).logout();
    sessionStorage.removeItem(SESSION_KEY);
    try {
      const website = JSON.parse(sessionStorage.getItem("mona-website-session-v1") || "null");
      if (website?.token === saved.token) sessionStorage.removeItem("mona-website-session-v1");
    } catch { sessionStorage.removeItem("mona-website-session-v1"); }
    setSaved({ token: "" });
  }
  return <div className="min-h-dvh bg-background text-foreground">
    {saved.token
      ? <Workspace key={saved.token} saved={saved} updateSaved={updateSaved} report={report} signOut={signOut} />
      : <Login onLogin={token => updateSaved({ token, selected: undefined, pending: null, creating: null })} report={report} />}
    <Dialog open={Boolean(error)} onOpenChange={open => !open && setError("")}>
      <DialogContent><DialogHeader><DialogTitle>操作未完成</DialogTitle><DialogDescription>{error}</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setError("")}>知道了</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

function Login({ onLogin, report }: { onLogin: (token: string) => void; report: (error: unknown) => void }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6">
    <div><p className="text-caption font-semibold tracking-widest text-muted-foreground">MONA · WORK</p>
      <h1 className="mt-3 text-title font-semibold">让想法落地</h1>
      <p className="mt-3 text-body text-muted-foreground">登录 Mona 账号，在独立工作区中完成任务。</p></div>
    <form className="flex flex-col gap-4" onSubmit={async event => {
      event.preventDefault(); if (busy) return; setBusy(true);
      try { onLogin(await login(account.trim(), password)); setPassword(""); } catch (err) { report(err); } finally { setBusy(false); }
    }}>
      <label className="grid gap-2 text-caption">账号<Input value={account} onChange={event => setAccount(event.target.value)} autoComplete="username" required disabled={busy} /></label>
      <label className="grid gap-2 text-caption">密码<Input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required disabled={busy} /></label>
      <Button type="submit" disabled={busy}>{busy ? "正在登录…" : "登录并开始"}</Button>
    </form>
    <p className="text-caption text-muted-foreground">模型由平台提供，无需填写 API Key。在线任务不会访问你的电脑或内网。</p>
  </main>;
}

type WorkspaceProps = { saved: Saved; updateSaved: (patch: Partial<Saved>) => void; report: (error: unknown) => void; signOut: () => Promise<void> };
function Workspace({ saved, updateSaved, report, signOut }: WorkspaceProps) {
  const client = useMemo(() => new WorkClient(saved.token), [saved.token]);
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [models, setModels] = useState<WorkModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [draft, setDraft] = useState(saved.pending?.input.text || "");
  const [selectedFiles, setSelectedFiles] = useState<WorkFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryLoad, setRetryLoad] = useState(0);
  const [stream, setStream] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState("");
  const [maxFileBytes, setMaxFileBytes] = useState(0);
  const [failedUpload, setFailedUpload] = useState<{ id: string; file: File; sessionId: string } | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const mutation = useRef(false);
  const selectedRef = useRef(saved.selected);
  selectedRef.current = saved.selected;
  const lastRun = detail?.runs.at(-1);
  const running = active(lastRun);
  const blocked = lastRun?.status === "unknown";
  const pending = saved.pending?.session_id === saved.selected ? saved.pending : null;

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setLoadFailed(false);
    void Promise.all([client.sessions(controller.signal), client.models(controller.signal)]).then(([list, catalog]) => {
      if (controller.signal.aborted) return;
      setSessions(list.sessions); setModels(catalog.models); setMaxFileBytes(catalog.max_file_bytes);
      setModelId(previous => catalog.models.some(model => model.id === previous) ? previous : catalog.models[0]?.id || "");
    }).catch(err => { if (!controller.signal.aborted) { setLoadFailed(true); report(err); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, report, retryLoad]);

  useEffect(() => {
    if (!saved.selected) { setDetail(null); return; }
    const controller = new AbortController(); setDetail(null); setSelectedFiles([]); setPollFailed(false);
    void client.session(saved.selected, controller.signal).then(value => {
      if (!controller.signal.aborted) setDetail(value);
    }).catch(err => { if (!controller.signal.aborted) { setLoadFailed(true); report(err); } });
    return () => controller.abort();
  }, [client, saved.selected, retryLoad, report]);

  useEffect(() => {
    if (!detail || !pending) return;
    const accepted = detail.runs.find(run => run.id === pending.input.request_id);
    if (accepted && JSON.stringify(accepted.input) === JSON.stringify(pending.input)) {
      updateSaved({ pending: null }); setDraft(""); setSelectedFiles([]);
    }
  }, [detail, pending, updateSaved]);

  useEffect(() => {
    if (!lastRun || !active(lastRun) || pollFailed) return;
    const controller = new AbortController(); let cursor = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    let accumulated = "";
    const id = lastRun.id;
    async function poll() {
      try {
        const reply = await client.events(id, cursor, controller.signal);
        if (controller.signal.aborted) return;
        for (const event of reply.events) {
          if (event.seq <= cursor) continue;
          cursor = event.seq;
          if (event.kind === "delta") accumulated += event.data.text || "";
          if (event.kind === "progress") setProgress(event.data.message || "正在处理任务");
        }
        setStream(previous => ({ ...previous, [id]: accumulated }));
        if (reply.has_more || active(reply.run)) {
          if (!reply.has_more) setDetail(previous => previous ? { ...previous,
            runs: previous.runs.map(run => run.id === id ? reply.run : run) } : previous);
          timer = setTimeout(() => void poll(), reply.has_more ? 0 : 700);
        } else if (selectedRef.current === reply.run.session_id) {
          const final = await client.session(reply.run.session_id, controller.signal);
          if (!controller.signal.aborted) { setDetail(final); setProgress(""); }
        }
      } catch (err) {
        if (!controller.signal.aborted) { setPollFailed(true); report(err); }
      }
    }
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [client, lastRun?.id, running, pollFailed, report]);

  async function mutate(action: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true; setBusy(true);
    try { await action(); } catch (err) { report(err); } finally { mutation.current = false; setBusy(false); }
  }
  async function create() {
    await mutate(async () => {
      const id = saved.creating || newRequestId(); updateSaved({ creating: id });
      const session = await client.createSession(id);
      setSessions(previous => [session, ...previous.filter(item => item.id !== session.id)]);
      updateSaved({ selected: session.id, creating: null }); setDraft(""); setSelectedFiles([]); setLoadFailed(false);
    });
  }
  async function send(original?: PendingTurn) {
    if (!saved.selected || !modelId || (!draft.trim() && !original) || running || blocked || !detail) return;
    await mutate(async () => {
      const value = original || { session_id: saved.selected!, input: { request_id: newRequestId(), model_id: modelId,
        text: draft, attachment_ids: selectedFiles.map(file => file.id) } };
      updateSaved({ pending: value });
      const run = await client.submit(value);
      if (selectedRef.current === value.session_id) {
        setDetail(previous => previous ? { ...previous, runs: [...previous.runs.filter(item => item.id !== run.id), run] } : previous);
        setDraft(""); setSelectedFiles([]); setPollFailed(false);
      }
      updateSaved({ pending: null });
    });
  }
  async function upload(value: { id: string; file: File; sessionId: string }) {
    await mutate(async () => {
      setFailedUpload(value);
      const result = await client.upload(value.sessionId, value.id, value.file);
      setFailedUpload(null);
      if (selectedRef.current === value.sessionId) {
        setSelectedFiles(previous => [...previous.filter(file => file.id !== result.id), result]);
        setDetail(previous => previous ? { ...previous, files: [...previous.files.filter(file => file.id !== result.id), result] } : previous);
      }
    });
  }
  async function download(file: WorkFile) {
    if (!saved.selected) return;
    await mutate(async () => {
      const blob = await client.download(saved.selected!, file);
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  return <div className="flex h-dvh min-h-0 overflow-hidden">
    <aside className="flex w-56 shrink-0 flex-col gap-4 border-r border-border bg-sidebar p-4 max-sm:w-36">
      <div className="flex items-center gap-2 text-caption font-semibold"><MessageSquare size={18} />MONA WORK</div>
      <Button variant="outline" onClick={() => void create()} disabled={busy || loading || Boolean(saved.pending) || Boolean(failedUpload)}><Plus size={16} className="mr-2" />新任务</Button>
      <nav aria-label="会话列表" className="min-h-0 flex-1 space-y-1 overflow-auto">
        {loading && <p className="text-caption text-muted-foreground">正在读取会话…</p>}
        {loadFailed && <Button variant="ghost" onClick={() => setRetryLoad(value => value + 1)}>重新读取</Button>}
        {!loading && !loadFailed && sessions.length === 0 && <p className="text-caption text-muted-foreground">还没有会话</p>}
        {sessions.map(session => <Button key={session.id} variant={saved.selected === session.id ? "secondary" : "ghost"}
          className="w-full justify-start truncate" disabled={busy || Boolean(saved.pending) || Boolean(failedUpload)} onClick={() => { updateSaved({ selected: session.id }); setDraft(""); }}>
          <span className="truncate">{session.title}</span></Button>)}
      </nav>
      <Button variant="ghost" disabled={busy} onClick={() => void mutate(signOut)}><LogOut size={16} className="mr-2" />退出登录</Button>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
        <h1 className="truncate text-body font-medium">{detail?.title || "在线工作区"}</h1>
        <label className="flex items-center gap-2 text-caption text-muted-foreground">模型
          <select aria-label="平台模型" className="h-8 max-w-48 rounded-md border border-input bg-background px-2 text-foreground"
            value={modelId} onChange={event => setModelId(event.target.value)} disabled={busy || running || Boolean(saved.pending)}>
            {models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </label>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-6">
        <div className="mx-auto max-w-3xl space-y-6" aria-live="polite">
          {!saved.selected && <div className="py-16"><h2 className="text-title font-semibold">今天想完成什么？</h2>
            <p className="mt-3 text-body text-muted-foreground">新建任务，开始写作、整理资料或处理工作区文件。</p></div>}
          {saved.selected && !detail && <p className="text-caption text-muted-foreground">正在读取会话…</p>}
          {detail?.runs.map(run => <section key={run.id} className="space-y-4">
            <div className="ml-auto max-w-prose whitespace-pre-wrap rounded-lg bg-secondary px-4 py-3 text-body">{run.input.text}</div>
            <div className="prose prose-sm max-w-none break-words text-foreground">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
                img: ({ alt }) => <span>{alt || "图片引用"}</span>,
              }}>{run.result.content || stream[run.id] || (active(run) ? "" : run.result.message || "")}</ReactMarkdown>
            </div>
            <p className="text-caption text-muted-foreground">{statusText[run.status] || "状态待核对"}
              {run.result.message && run.result.content ? ` · ${run.result.message}` : ""}</p>
          </section>)}
          {running && <p role="status" className="text-caption text-muted-foreground">{progress || "正在处理任务…"}</p>}
          {pollFailed && <Button variant="outline" onClick={() => { setPollFailed(false); setRetryLoad(value => value + 1); }}>重新读取任务状态</Button>}
          {detail && detail.files.length > 0 && <section aria-label="工作文件" className="border-t border-border pt-4">
            <h2 className="mb-2 text-caption font-medium">工作文件</h2><div className="flex flex-wrap gap-2">
              {detail.files.map(file => <Button key={file.id} variant="outline" size="sm" disabled={busy || running || blocked}
                onClick={() => void download(file)}><Download size={14} className="mr-2" />{file.name}</Button>)}
            </div>
          </section>}
        </div>
      </div>
      <div className="border-t border-border px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {!loading && !loadFailed && models.length === 0 && <p role="status" className="text-caption text-muted-foreground">在线模型尚未开放，请稍后再试。无需配置 API，也不会使用桌面端额度。</p>}
          {pending && <div className="flex items-center justify-between gap-3 text-caption"><span>上次发送结果待核对，原文和附件已保留。</span>
            <Button variant="outline" size="sm" disabled={busy || running} onClick={() => void send(pending)}>核对原请求</Button></div>}
          {failedUpload && <div className="flex items-center justify-between gap-3 text-caption"><span>文件上传未确认：{failedUpload.file.name}</span>
            <Button variant="outline" size="sm" disabled={busy || running} onClick={() => void upload(failedUpload)}>重试原上传</Button></div>}
          {blocked && <p className="text-caption text-destructive">任务结果待核对，已暂停新的执行；请联系管理员核对，不会自动重跑。</p>}
          <div className="flex flex-wrap gap-2">{selectedFiles.map(file => <span key={file.id} className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-caption">{file.name}
            <button aria-label={`取消附加 ${file.name}`} disabled={busy || Boolean(pending)} onClick={() => setSelectedFiles(previous => previous.filter(item => item.id !== file.id))}><X size={14} /></button></span>)}</div>
          <textarea aria-label="任务内容" value={draft} onChange={event => setDraft(event.target.value)} maxLength={50000} rows={3}
            placeholder={detail ? "描述你要完成的任务…" : "先新建一个任务"} disabled={!detail || Boolean(pending)}
            className="w-full resize-none rounded-md border border-input bg-background p-3 text-body outline-none"
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!pending && !busy) void send(); } }} />
          <div className="flex items-center justify-between gap-3">
            <input ref={uploadInput} type="file" className="hidden" aria-label="上传附件" onChange={event => {
              const file = event.target.files?.[0]; event.target.value = "";
              if (!file || !saved.selected) return;
              if (file.size > maxFileBytes) { report(new WorkApiError("文件超过上传上限。")); return; }
              void upload({ id: newRequestId(), file, sessionId: saved.selected });
            }} />
            <Button variant="ghost" disabled={!detail || busy || running || blocked || Boolean(pending) || selectedFiles.length >= 8 || Boolean(failedUpload)}
              onClick={() => uploadInput.current?.click()}><Paperclip size={16} className="mr-2" />添加附件</Button>
            {running && lastRun
              ? <Button variant="outline" disabled={busy || lastRun.status === "cancelling"} onClick={() => void mutate(async () => {
                const stopped = await client.stop(lastRun.id); setDetail(previous => previous ? { ...previous, runs: previous.runs.map(run => run.id === stopped.id ? stopped : run) } : previous);
              })}><Square size={14} className="mr-2" />{lastRun.status === "cancelling" ? "正在停止" : "停止"}</Button>
              : <Button disabled={!detail || !draft.trim() || !modelId || busy || blocked || Boolean(pending)} onClick={() => void send()}><Send size={15} className="mr-2" />发送</Button>}
          </div>
          <p className="text-micro text-muted-foreground">仅操作你的隔离工作区 · 模型由平台提供 · Shift + Enter 换行</p>
        </div>
      </div>
    </main>
  </div>;
}
