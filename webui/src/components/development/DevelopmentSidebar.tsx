import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { DevelopmentTabs, DEVELOPMENT_WORK_TOOLS } from "./DevelopmentTabs";
import { DevelopmentPreview, openDevelopmentPreview } from "./DevelopmentPreview";
import { DevelopmentLocalTerminal } from "./DevelopmentLocalTerminal";
import { startDevelopmentTerminal, stopDevelopmentTerminal } from "./terminal-lifecycle";
import { Button } from "@/components/ui/button";
import { DevelopmentSubagents } from "./DevelopmentSubagents";
import { subagentApi, type SubagentSettings } from "./workspace-api";
import { refreshDevelopmentSession } from "./useDevelopmentSession";
import type { Tab } from "@/hooks/useBrowserTabs";
import { developmentApi, type DevExecutor, type DevProject, type DevSession } from "@/lib/development-api";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { DevelopmentFiles } from "./DevelopmentFiles";
import { DevelopmentStreamPreview } from "./DevelopmentStreamPreview";
import { DevelopmentPane } from "./DevelopmentPane";
import { DevelopmentReview } from "./DevelopmentReview";
import { DevelopmentActivity } from "./DevelopmentActivity";
import { DevelopmentCommandOutput } from "./DevelopmentCommandOutput";
import { DevelopmentSubagentTasks } from "./DevelopmentSubagentTasks";
import { DevelopmentSubagentDetail } from "./DevelopmentSubagentDetail";
import { EMPTY_SIDE, useDevelopmentStore, type WorkTab } from "./store";

export interface DevelopmentBrowserHost {
  tabs: Tab[];
  create: () => string;
  retain?: (id: string) => void;
  navigate: (id: string, url: string) => void;
  goBack: (id: string) => void;
  goForward: (id: string) => void;
  reload: (id: string) => void;
  updateUrl: (id: string, url: string) => void;
  openDevtools: (id: string) => void;
  setVisible: (id: string | null) => void;
}

export function DevelopmentSidebar({ project, session, executors, visible, browserHost, onManageModels }: {
  project: DevProject; session: DevSession; executors: DevExecutor[]; visible: boolean; browserHost?: DevelopmentBrowserHost; onManageModels?: () => void;
}) {
  const side = useDevelopmentStore((s) => s.sides[session.id] ?? EMPTY_SIDE);
  const snapshot = useDevelopmentStore((s) => s.snapshots[session.id]);
  const browserId = useDevelopmentStore((s) => s.browserTabs[session.id]);
  const browserTab = browserHost?.tabs.find((tab) => tab.id === (browserId ?? snapshot?.browserBinding?.tabId));
  const snapshotError = useDevelopmentStore((s) => s.errors[session.id]);
  const terminal = useDevelopmentStore((s) => s.terminals[session.id]);
  const streamPreview = useDevelopmentStore((s) => s.streamPreviews[session.id]);
  const childId = useDevelopmentStore((s) => s.sideChats[session.id]);
  const [child, setChild] = useState<DevSession | null>(null);
  const [error, setError] = useState("");
  const [creatingChat, setCreatingChat] = useState(false);
  const sideChatPending = useRef(false);
  const [subagents, setSubagents] = useState<SubagentSettings | null>(null);
  const [subagentError, setSubagentError] = useState("");
  const [presetRevision, setPresetRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    void subagentApi.list(project.id).then((value) => { if (alive) { setSubagents(value); setSubagentError(""); } })
      .catch((cause) => { if (alive) setSubagentError(cause instanceof Error ? cause.message : "子智能体配置读取失败"); });
    return () => { alive = false; };
  }, [project.id, presetRevision]);
  const terminalMode = side.terminalMode ?? "agent";
  const setTerminalMode = (value: "user" | "agent") => useDevelopmentStore.getState().setSide(session.id, { terminalMode: value });
  const run = snapshot?.runs[0];
  useEffect(() => {
    let live = true;
    setChild(null);
    if (childId) void developmentApi.snapshot(childId).then((value) => {
      if (!live) return;
      if (value.session.parentSessionId !== session.id || value.session.projectId !== project.id || !value.session.readonly) throw new Error("侧边会话归属或只读权限不匹配，未打开该会话。");
      setChild(value.session); setError(""); useDevelopmentStore.getState().setSnapshot(childId, value);
    }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "侧边会话读取失败"); });
    return () => { live = false; };
  }, [childId, session.id, project.id]);

  const ensureSideChat = async (prompt?: string) => {
    if (sideChatPending.current) return;
    sideChatPending.current = true; setCreatingChat(true); setError("");
    try {
      const id = useDevelopmentStore.getState().sideChats[session.id];
      const value = id ? (await developmentApi.snapshot(id)).session : await developmentApi.createSession(project.id, {
        title: `${session.title} · 侧边讨论`, executor: "mona", readonly: true, parentSessionId: session.id,
      });
      if (value.parentSessionId !== session.id || value.projectId !== project.id || !value.readonly) throw new Error("侧边会话归属或只读权限不匹配，未创建或替换会话。");
      useDevelopmentStore.getState().setSideChat(session.id, value.id); setChild(value); setError("");
      if (prompt) useDevelopmentStore.getState().appendDraft(value.id, prompt);
    } catch (e) { setError(e instanceof Error ? e.message : "侧边聊天无法打开"); }
    finally { sideChatPending.current = false; setCreatingChat(false); }
  };
  useEffect(() => {
    if (side.tab === "sidechat" && !childId) void ensureSideChat();
  }, [side.tab, childId]);
  const open = (kind: WorkTab) => {
    useDevelopmentStore.getState().setSide(session.id, { tab: kind, expanded: true });
    if (kind === "browser") openDevelopmentPreview(session.id, browserHost);

    if (kind === "terminal") {
      setTerminalMode("user");
      if (isTauri() && !useDevelopmentStore.getState().terminals[session.id]) void startDevelopmentTerminal(session.id, project.rootPath);
    }
  };
  const current = snapshot?.session ?? session;
  const closeTab = (id: WorkTab | "overview") => {
    // Closing a view never stops its process. Use the explicit end-terminal action.
    useDevelopmentStore.getState().closeSideTab(session.id, id);
  };
  return <aside aria-label="开发工作侧栏" className={cn("flex h-full min-h-0 min-w-0 flex-col bg-card", side.maximized ? "absolute inset-0 z-30 w-full" : "w-full")}>
    <DevelopmentTabs tabs={side.openTabs} active={side.tab} maximized={side.maximized}
        overviewOpen={side.overviewOpen !== false} browserTab={browserTab}
        onSelect={(target) => target === "overview" ? useDevelopmentStore.getState().setSide(session.id, { tab: "overview" }) : open(target)} onClose={closeTab}
        onMaximize={() => useDevelopmentStore.getState().setSide(session.id, { maximized: !side.maximized })}
        onCollapse={() => useDevelopmentStore.getState().setSide(session.id, { expanded: false, maximized: false })}>
        <div className="relative h-full min-h-0">
          {side.openTabs.includes("subagents") && <div className={cn("h-full overflow-y-auto", side.tab !== "subagents" && "hidden")}><DevelopmentSubagents key={project.id} projectId={project.id} executors={executors} session={current} onManageModels={onManageModels} onChanged={() => setPresetRevision((n) => n + 1)} /></div>}
          {side.tab === "agent" && <div className="h-full min-h-0">
            <div className={cn("h-full", side.agentSessionId && "hidden")}><DevelopmentSubagentTasks key={session.id} session={session} visible={visible && !side.agentSessionId}
              onSelect={(id) => useDevelopmentStore.getState().setSide(session.id, { agentSessionId: id })} /></div>
            {side.agentSessionId && <DevelopmentSubagentDetail key={side.agentSessionId} parent={session} project={project} childId={side.agentSessionId} visible={visible}
              onBack={() => useDevelopmentStore.getState().setSide(session.id, { agentSessionId: undefined })} />}
          </div>}
          {side.tab === "workspace" && (streamPreview ? <DevelopmentStreamPreview source={streamPreview} sessionId={session.id} /> : <DevelopmentFiles project={project} sessionId={session.id} />)}
          {side.tab === "review" && <DevelopmentReview project={project} session={current} executors={executors} presets={subagents?.presets ?? []} presetsError={subagentError} onRetryPresets={() => setPresetRevision((n) => n + 1)} onConfigure={() => open("subagents")} onOpenAgent={(id) => useDevelopmentStore.getState().setSide(session.id, { tab: "agent", expanded: true, agentSessionId: id })} />}
          <div className={cn("absolute inset-0 flex min-h-0 flex-col", side.tab !== "browser" && side.tab !== "overview" && "hidden")}>
            <DevelopmentPreview session={current} host={browserHost} visible={visible && side.expanded && (side.tab === "browser" || side.tab === "overview")} layoutVersion={`${side.maximized}-${side.expanded}`}>
              <div className="scrollbar-thin h-full overflow-y-auto bg-muted/20 px-5 py-8">
                <h3 className="mb-4 text-ui font-medium">工具</h3>
                <div className="space-y-2">{DEVELOPMENT_WORK_TOOLS.map((tool) => <Button key={tool.id} variant="ghost" className="h-12 w-full justify-start gap-3 rounded-lg bg-background px-3 text-ui" onClick={() => open(tool.id)}><tool.icon className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="flex-1 text-left">{tool.title}</span><ChevronRight className="h-4 w-4 text-muted-foreground" /></Button>)}</div>
              </div>
            </DevelopmentPreview>
          </div>
          <div className={cn("absolute inset-0 flex min-h-0 flex-col", side.tab !== "terminal" && "hidden")}>
            <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
              <Button variant="ghost" size="sm" aria-pressed={terminalMode === "agent"} onClick={() => { setTerminalMode("agent"); useDevelopmentStore.getState().setSide(session.id, { backgroundCommandId: undefined }); }}>执行记录</Button>
              <Button variant="ghost" size="sm" aria-pressed={terminalMode === "user"} onClick={() => setTerminalMode("user")}>手动终端</Button>
              {terminal && terminalMode === "user" && <Button variant="ghost" size="sm" className="ml-auto" disabled={terminal.status === "closing"} onClick={() => void stopDevelopmentTerminal(session.id)}>结束终端</Button>}
            </div>
            <div className={cn("min-h-0 flex-1", side.backgroundCommandId ? "flex flex-col" : "overflow-auto p-3", terminalMode !== "agent" && "hidden")}>
              {side.backgroundCommandId ? <DevelopmentCommandOutput key={`${session.id}:${side.backgroundCommandId}`}
                sessionId={session.id} commandId={side.backgroundCommandId} readonly={current.readonly}
                visible={visible && side.expanded && side.tab === "terminal" && terminalMode === "agent"}
                onBack={() => useDevelopmentStore.getState().setSide(session.id, { backgroundCommandId: undefined })} /> : <>
              {(snapshot?.messages ?? []).filter((m) => m.role === "tool" && ["exec", "write_stdin", "list_exec_sessions"].includes(m.name ?? "")).map((m) => <details key={m.id} open className="mb-3 text-caption"><summary className="cursor-pointer text-muted-foreground">{m.name}</summary><pre className="mt-2 whitespace-pre-wrap break-words font-mono">{m.content}</pre></details>)}
              <DevelopmentActivity events={snapshot?.events ?? []} runId={run?.id} runStatus={run?.status} />
              {snapshotError && <div role="alert" className="space-y-2 text-caption text-destructive"><p>执行记录暂未更新：{snapshotError}</p><Button variant="outline" size="sm" onClick={() => refreshDevelopmentSession(session.id)}>重新读取执行记录</Button></div>}
              {!snapshot && !snapshotError && <p role="status" className="text-caption text-muted-foreground">正在读取执行记录…</p>}
              {snapshot && !snapshotError && !snapshot.messages.some((m) => m.role === "tool" && m.name === "exec") && !snapshot.events.some((e) => e.type === "command.completed" || e.type === "tool.completed") && <p className="text-caption text-muted-foreground">当前会话还没有命令执行结果。</p>}
              </>}
            </div>
            <div className={cn("min-h-0 flex-1", terminalMode !== "user" && "hidden")}>
              <DevelopmentLocalTerminal sessionId={session.id} directory={project.rootPath} visible={visible && side.tab === "terminal" && terminalMode === "user"} />
            </div>
          </div>
          {side.tab === "sidechat" && (child ? <DevelopmentPane session={child} project={project} fileSessionId={session.id} executors={executors} visible={visible} compact onUseAnswer={(text) => useDevelopmentStore.getState().appendDraft(session.id, text)} /> : error ? <div role="alert" className="space-y-2 p-4 text-caption text-destructive"><p>{error}</p><Button variant="outline" size="sm" disabled={creatingChat} onClick={() => void ensureSideChat()}>重试打开侧边聊天</Button></div> : <p role="status" className="p-4 text-ui text-muted-foreground">正在恢复侧边会话…</p>)}
        </div>
      </DevelopmentTabs>
  </aside>;
}
