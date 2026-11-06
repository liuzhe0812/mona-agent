import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowLeft, LoaderCircle, Plus } from "lucide-react";

import { ChatList } from "@/components/ChatList";
import { DeleteConfirm } from "@/components/DeleteConfirm";
import { RenameChatDialog } from "@/components/RenameChatDialog";
import { ThreadShell } from "@/components/thread/ThreadShell";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
import { ConversationFileContext } from "@/components/deliver/ConversationFileContext";
import { projectRelativePath } from "@/components/markdown/MarkdownContext";
import { useOfficeSessionStore } from "@/components/office/office-session-store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSessions, sessionTitle } from "@/hooks/useSessions";
import { isSessionUnread, markAllSessionsRead, markSessionRead, useSidebarState } from "@/hooks/useSidebarState";
import { fetchSettings, resetApiBase } from "@/lib/api";
import { configureHostedPlatform, downloadHostedFile, getHostedPlatform, HostedPlatformError } from "@/lib/hosted-platform";
import { publishSettingsUpdate } from "@/lib/settings-updates";
import { OfficeClientError } from "@/lib/office-client";
import type { MonaClient } from "@/lib/mona-client";
import type { ConnectionStatus } from "@/lib/types";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { ClientProvider, useClient, type RuntimeStatus } from "@/providers/ClientProvider";
import { login, WorkApiError, type PendingTurn } from "./client";
import { clearHostedClientIdentity, createHostedClient } from "./runtime";

const SESSION_KEY = "mona-hosted-work-v1";
const WEBSITE_SESSION_KEY = "mona-website-session-v1";
type Saved = { token: string; selected?: string; pending?: PendingTurn | null; creating?: string | null };
const validToken = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 8192 && !/[^\x21-\x7e]/.test(value);

function loadSaved(): Saved {
  try {
    const work = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    const website = JSON.parse(sessionStorage.getItem(WEBSITE_SESSION_KEY) || "null");
    if (validToken(website?.token) && typeof website?.user?.id === "string") {
      return work?.token === website.token ? work : { token: website.token };
    }
    return validToken(work?.token) ? work : { token: "" };
  } catch { return { token: "" }; }
}

function clearHostedViewState() {
  useOfficeSessionStore.getState().clear();
  useWorkspaceStore.getState().setWorkspacePath("");
  useFilePreviewStore.getState().close();
  useFilePreviewStore.setState({
    workspaceCollapsed: true, treeCollapsedByOwner: {}, treeExpansionInitializedByOwner: {},
    artifactBaseline: null, viewedArtifactPaths: new Set(), deletedArtifactPaths: new Set(),
  });
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith("mona.office.sessions.v1:")) sessionStorage.removeItem(key);
  }
  resetApiBase();
}

export function WorkApp() {
  const [saved, setSaved] = useState<Saved>(loadSaved);
  const [error, setError] = useState("");
  const report = useCallback((value: unknown) => {
    if (value instanceof DOMException && value.name === "AbortError") return;
    setError(value instanceof WorkApiError || value instanceof HostedPlatformError || value instanceof OfficeClientError
      ? value.message : "操作未能确认，已有内容保留，请核对后重试。");
  }, []);
  const updateSaved = useCallback((patch: Partial<Saved>) => setSaved(previous => {
    const next = { ...previous, ...patch };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    return next;
  }), []);
  const clearAccount = useCallback((token: string) => {
    setSaved(previous => {
      if (previous.token !== token) return previous;
      clearHostedClientIdentity();
      sessionStorage.removeItem(SESSION_KEY);
      try {
        const website = JSON.parse(sessionStorage.getItem(WEBSITE_SESSION_KEY) || "null");
        if (website?.token === token) sessionStorage.removeItem(WEBSITE_SESSION_KEY);
      } catch { sessionStorage.removeItem(WEBSITE_SESSION_KEY); }
      return { token: "" };
    });
  }, []);
  const unauthorized = useCallback((token: string) => {
    clearAccount(token);
    setError("登录已失效，请重新登录 Mona 账号。");
  }, [clearAccount]);
  useEffect(() => {
    const refresh = () => {
      const next = loadSaved();
      setSaved(previous => {
        if (previous.token === next.token) return previous;
        clearHostedClientIdentity();
        return next;
      });
    };
    window.addEventListener("mona-account-changed", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      window.removeEventListener("mona-account-changed", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, []);

  return <div className="h-dvh min-h-0 bg-background text-foreground">
    {saved.token
      ? <HostedRuntime key={saved.token} saved={saved} updateSaved={updateSaved} report={report}
          unauthorized={unauthorized} />
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
    <div><p className="text-caption font-semibold tracking-widest text-muted-foreground">MONA</p>
      <h1 className="mt-3 text-title font-semibold">线上工作台</h1>
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

interface WorkspaceProps {
  saved: Saved;
  updateSaved: (patch: Partial<Saved>) => void;
  report: (error: unknown) => void;
  unauthorized: (token: string) => void;
}

function runtimeStatus(status: ConnectionStatus): RuntimeStatus {
  return status === "open" ? "ready" : status === "error" ? "error" : "connecting";
}

function HostedRuntime(props: WorkspaceProps) {
  const { saved, unauthorized } = props;
  const [client, setClient] = useState<MonaClient | null>(null);
  const [status, setStatus] = useState<RuntimeStatus>("connecting");
  const [modelName, setModelName] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let mounted = true;
    let current: MonaClient | null = null;
    let unsubscribeStatus: (() => void) | undefined;
    let unsubscribeModel: (() => void) | undefined;
    const controller = new AbortController();
    clearHostedViewState();
    const release = configureHostedPlatform({ apiBase: "/api/work/desktop", token: saved.token,
      onUnauthorized: () => unauthorized(saved.token) });
    setStatus("connecting"); setConnectionError(false); setClient(null);
    void createHostedClient(controller.signal).then(value => {
      if (!mounted) { value.close(); return; }
      current = value;
      unsubscribeStatus = value.onStatus(next => { if (mounted) setStatus(runtimeStatus(next)); });
      unsubscribeModel = value.onRuntimeModelUpdate(next => { if (mounted) setModelName(next); });
      setClient(value);
      value.connect();
    }).catch(value => {
      if (!mounted || controller.signal.aborted || value instanceof HostedPlatformError && value.status === 401) return;
      setStatus("error"); setConnectionError(true);
    });
    return () => {
      mounted = false; controller.abort();
      unsubscribeStatus?.(); unsubscribeModel?.(); current?.close();
      release(); clearHostedViewState();
    };
  }, [retry, saved.token, unauthorized]);

  useEffect(() => {
    let disposed = false;
    let loading = false;
    const refresh = async () => {
      if (loading || document.visibilityState === "hidden" || getHostedPlatform()?.token !== saved.token) return;
      loading = true;
      try {
        const settings = await fetchSettings(saved.token);
        if (!disposed && getHostedPlatform()?.token === saved.token) publishSettingsUpdate(saved.token, settings);
      } catch (error) {
        if (!disposed && (error as { status?: number }).status === 401) unauthorized(saved.token);
        else if (!disposed) console.warn("工作台模型设置暂未刷新，将在页面恢复时重试。");
      } finally { loading = false; }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { disposed = true; window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [saved.token, unauthorized]);

  if (!client) return <main className="flex h-full flex-col items-center justify-center gap-4 px-6">
    {connectionError
      ? <><p className="text-body text-muted-foreground">工作台暂时无法连接，请稍后重试。</p>
          <Button variant="outline" onClick={() => setRetry(value => value + 1)}>重试</Button></>
      : <><LoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden /><p className="text-body text-muted-foreground">正在打开线上工作台…</p></>}
  </main>;
  return <ClientProvider client={client} token={saved.token} modelName={modelName} runtimeStatus={status}
    runtimeError={status === "error" ? "连接已中断，正在恢复会话。" : null}>
    <Conversations {...props} onModelNameChange={setModelName} />
  </ClientProvider>;
}

function Conversations({ saved, updateSaved, report, onModelNameChange }: WorkspaceProps & {
  onModelNameChange: (value: string | null) => void;
}) {
  const { runtimeStatus: status } = useClient();
  const { sessions, loading, loaded, error, refresh, createChat, branchChat, deleteChat } = useSessions();
  const { state: sidebar, update: updateSidebar } = useSidebarState(sessions, loaded);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pendingRename, setPendingRename] = useState<{ key: string; label: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ keys: string[]; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const creatingRef = useRef(false);
  const mountedRef = useRef(true);
  const initializedEmptyRef = useRef(false);
  const selectedRef = useRef(saved.selected);
  selectedRef.current = saved.selected;
  const selected = sessions.find(item => item.chatId === saved.selected) ?? null;
  const selectedKey = selected?.key;
  const fileAccess = useMemo(() => selectedKey ? {
    sessionKey: selectedKey,
    scope: "shared" as const,
    onError: report,
    download: async (source: string) => {
      if (getHostedPlatform()?.token !== saved.token) {
        throw new HostedPlatformError("账号已变化，请在原账号中重新下载文件。");
      }
      let path: string;
      try {
        path = projectRelativePath(source, "/workspace");
        if (!path || path.split("/").some(part => part === "..")) throw new Error("invalid path");
      } catch {
        throw new HostedPlatformError("文件位置无效，请从当前会话的交付列表打开。");
      }
      await downloadHostedFile({ path, name: path.split("/").pop()! }, "shared", selectedKey);
    },
  } : null, [selectedKey, saved.token, report]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    try { await action(); } catch (value) { if (mountedRef.current) report(value); }
  }, [report]);
  const select = useCallback((key: string) => {
    if (!mountedRef.current) return;
    const session = sessions.find(item => item.key === key);
    if (!session) return;
    updateSaved({ selected: session.chatId });
    void run(async () => {
      if (!await updateSidebar(previous => markSessionRead(previous, session.key, session.previewAt))) {
        throw new HostedPlatformError("已读状态尚未保存，请稍后核对。");
      }
    });
  }, [run, sessions, updateSaved, updateSidebar]);
  const create = useCallback(async (_workspace?: string | null, beforeActivate?: (chatId: string) => boolean) => {
    if (creatingRef.current) throw new HostedPlatformError("新会话正在创建，请稍后核对。");
    creatingRef.current = true; setCreating(true);
    try {
      const id = await createChat();
      if (mountedRef.current && (!beforeActivate || beforeActivate(id))) updateSaved({ selected: id });
      return id;
    } finally {
      creatingRef.current = false;
      if (mountedRef.current) setCreating(false);
    }
  }, [createChat, updateSaved]);
  const updateKeys = (field: "pinned_keys" | "archived_keys", keys: string[], enabled?: boolean) => void run(async () => {
    const confirmed = await updateSidebar(previous => {
      const values = new Set(previous[field]);
      for (const key of keys) {
        if (enabled ?? !values.has(key)) values.add(key);
        else values.delete(key);
      }
      return { ...previous, [field]: [...values] };
    });
    if (!confirmed) throw new HostedPlatformError("会话设置尚未保存，请刷新后核对。");
  });
  const markAllRead = () => void run(async () => {
    if (!await updateSidebar(previous => markAllSessionsRead(previous, sessions))) {
      throw new HostedPlatformError("已读状态尚未保存，请稍后核对。");
    }
  });

  useEffect(() => {
    if (status !== "ready" || !loaded || loading || error || selected) return;
    if (sessions.length) {
      updateSaved({ selected: sessions[0].chatId });
    } else if (!initializedEmptyRef.current && !creatingRef.current) {
      initializedEmptyRef.current = true;
      const previousSelection = saved.selected;
      void run(() => create(undefined, () => selectedRef.current === previousSelection));
    }
  }, [create, error, loaded, loading, run, saved.selected, selected, sessions, status, updateSaved]);

  return <div className="flex h-full min-h-0 overflow-hidden bg-background">
    {sidebarOpen && <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border/45 bg-sidebar lg:w-[264px] xl:w-[272px]">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/55 px-3">
        <a className="flex min-w-0 items-center gap-2 text-caption font-semibold" href="/"><ArrowLeft className="h-3.5 w-3.5" aria-hidden />返回官网</a>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="新建会话" title="新建会话"
          disabled={creating} onClick={() => void run(() => create())}><Plus className="h-3.5 w-3.5" aria-hidden /></Button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden pb-2 pt-1.5">
        <ChatList sessions={sessions} activeKey={selected?.key ?? null} loading={loading} error={error}
          onRetry={refresh} onSelect={select} pinnedKeys={sidebar.pinned_keys} archivedKeys={sidebar.archived_keys}
          titleOverrides={sidebar.title_overrides} showArchived={sidebar.view.show_archived}
          runningChatIds={sessions.filter(item => item.runStartedAt != null).map(item => item.chatId)}
          unreadKeys={sessions.filter(item => isSessionUnread(item, sidebar.last_read_at_by_key[item.key])).map(item => item.key)}
          onRequestDelete={(key, label) => setPendingDelete({ keys: [key], label })}
          onRequestBatchDelete={keys => setPendingDelete({ keys, label: `${keys.length} 个会话` })}
          onTogglePin={key => updateKeys("pinned_keys", [key])} onBatchPin={(keys, pinned) => updateKeys("pinned_keys", keys, pinned)}
          onToggleArchive={key => updateKeys("archived_keys", [key])} onBatchArchive={(keys, archived) => updateKeys("archived_keys", keys, archived)}
          onRequestRename={(key, label) => setPendingRename({ key, label })} onMarkAllRead={markAllRead} />
      </div>
      <footer className="grid gap-1 border-t border-border/45 p-2">
        <Button variant="ghost" className="justify-start" onClick={() => void run(async () => {
          if (!await updateSidebar(previous => ({ ...previous, view: { ...previous.view, show_archived: !previous.view.show_archived } }))) {
            throw new HostedPlatformError("会话显示设置尚未保存，请刷新后核对。");
          }
        })}><Archive className="mr-2 h-4 w-4" aria-hidden />{sidebar.view.show_archived ? "返回会话" : "已归档"}</Button>
      </footer>
    </aside>}
    <main className="relative isolate flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {selected ? <ConversationFileContext.Provider value={fileAccess}>
        <ThreadShell session={selected} title={sidebar.title_overrides[selected.key] || sessionTitle(selected)}
        onToggleSidebar={() => setSidebarOpen(value => !value)} onCollapseSessionList={() => setSidebarOpen(false)}
        sessionListOpen={sidebarOpen} recentSessions={sessions.filter(item => !sidebar.archived_keys.includes(item.key))}
        onSelectSession={select} onCreateChat={create} onCreateDirectChat={(_agent, workspace, activate) => create(workspace, activate)}
        onBranchChat={async (source, ordinal, task) => {
          const id = await branchChat(source, ordinal, task);
          if (mountedRef.current) updateSaved({ selected: id });
          return id;
        }}
        onTurnEnd={() => void refresh()} onModelNameChange={onModelNameChange} onActionError={report} browserHostVisible={false} />
        </ConversationFileContext.Provider>
        : <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
            {(loading || creating || status === "connecting") && <LoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />}
            <p className="text-body text-muted-foreground">{loading || creating || status === "connecting"
              ? "正在打开会话…" : "选择或新建会话，开始使用线上工作台。"}</p>
          </div>}
    </main>
    <RenameChatDialog open={Boolean(pendingRename)} title={pendingRename?.label ?? ""} onCancel={() => setPendingRename(null)}
      onConfirm={value => void run(async () => {
        if (!pendingRename) return;
        if (!await updateSidebar(previous => ({ ...previous, title_overrides: { ...previous.title_overrides, [pendingRename.key]: value } }))) {
          throw new HostedPlatformError("会话名称尚未保存，请刷新后核对。");
        }
        setPendingRename(null);
      })} />
    <DeleteConfirm open={Boolean(pendingDelete)} title={pendingDelete?.label ?? ""} busy={deleting}
      onCancel={() => { if (!deleting) setPendingDelete(null); }} onConfirm={async () => {
        if (!pendingDelete || deleting) return;
        setDeleting(true);
        try {
          for (const key of pendingDelete.keys) {
            if (!mountedRef.current) return;
            await deleteChat(key);
          }
          if (!mountedRef.current) return;
          if (selected && pendingDelete.keys.includes(selected.key)) updateSaved({ selected: undefined });
          setPendingDelete(null);
        } catch (value) { if (mountedRef.current) report(value); }
        finally { if (mountedRef.current) setDeleting(false); }
      }} />
  </div>;
}
