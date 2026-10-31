import { useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { AgentLogo } from "@/components/AgentLogo";
import { cn } from "@/lib/utils";
import { ConnectionTree } from "./ConnectionTree";
import { DbAgentPanel } from "./DbAgentPanel";
import { DashboardView } from "./DashboardView";
import { UsersView } from "./UsersView";
import { VariablesView } from "./VariablesView";
import { ProcessesView } from "./ProcessesView";
import { SlowQueryView } from "./SlowQueryView";
import { ReplicationView } from "./ReplicationView";
import { BackupView } from "./BackupView";
import { NewConnectionDialog } from "./NewConnectionDialog";
import { EditConnectionDialog } from "./EditConnectionDialog";
import { TableBrowser } from "./TableBrowser";
import { TableListView } from "./TableListView";
import { QueryWorkspace } from "./QueryWorkspace";
import { TableStructureEditor } from "./TableStructureEditor";
import { DbIcon } from "./DbIcon";
import { DbToolButton } from "./DbToolButton";
import { useDbStore } from "./store/dbStore";
import { hasPendingEdits } from "./table-sql";
import type { QueryTab } from "./types";
import { getQueryDraft } from "./query-draft";
import { TerminalView } from "../terminal/TerminalView";
import { SessionTabBar } from "../terminal/SessionTabBar";
import { useTerminalStore } from "../terminal/store/terminalStore";
import { OperationsConnectionList } from "../operations/OperationsConnectionList";
import { OperationsCreateMenu } from "../operations/OperationsCreateMenu";

export function DbClientView({ onOpenSubscribe, visible = true, preferTerminal = false }: {
  onOpenSubscribe?: () => void; visible?: boolean; preferTerminal?: boolean;
}) {
  const tabs = useDbStore((s) => s.queryTabs);
  const activeId = useDbStore((s) => s.activeTabId);
  const currentView = useDbStore((s) => s.currentView);
  const objectScope = useDbStore((s) => s.objectScope);
  const connections = useDbStore((s) => s.activeConnections);
  const [agentOpen, setAgentOpen] = useState(false);
  const [terminalActive, setTerminalActive] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(true);
  const connectionsPanel = useRef<PanelImperativeHandle | null>(null);
  const connectionsGroup = useRef<HTMLDivElement | null>(null);
  const terminalId = useTerminalStore((s) => s.activeSessionId);
  const terminalAgentOpen = useTerminalStore((s) => s.aiPanelVisible);
  const activeTerminal = useTerminalStore((s) => s.sessions.find((session) => session.id === s.activeSessionId));
  const batchActive = terminalActive && activeTerminal?.type === "batch";
  const terminalAgentAvailable = !!activeTerminal && !["batch", "desktop", "docker"].includes(activeTerminal.type);
  const currentAgentOpen = terminalActive ? terminalAgentOpen : agentOpen;
  const selectedDatabaseConnected = !!objectScope && connections.some((connection) => connection.id === objectScope.connectionId);
  const queryTarget = terminalActive ? null : currentView === "table" ? tabs.find((tab) => tab.id === activeId) : objectScope;
  const [closeTab, setCloseTab] = useState<QueryTab | null>(null);
  const initialized = useRef(false);
  const tabBar = useRef<HTMLDivElement>(null);

  useEffect(() => { setConnectionsOpen(!batchActive); }, [batchActive]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      const panel = connectionsPanel.current;
      if (!panel || !connectionsGroup.current?.clientWidth) return;
      if (!connectionsOpen) panel.collapse();
      else if (panel.getSize().inPixels === 0) panel.resize("240px");
    });
    return () => cancelAnimationFrame(frame);
  }, [connectionsOpen, visible]);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void useDbStore.getState().loadSavedConnections();
      void useTerminalStore.getState().loadSavedConnections().catch(() => console.warn("Saved host list could not be loaded."));
    }
  }, []);
  useEffect(() => {
    tabBar.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId, currentView, terminalId, terminalActive]);

  useEffect(() => useTerminalStore.subscribe((state, previous) => {
    if (!state.activeSessionId) setTerminalActive(false);
    else if (state.sessions.length > previous.sessions.length) setTerminalActive(true);
  }), []);
  useEffect(() => useDbStore.subscribe((state, previous) => {
    if (state.queryTabs.length >= previous.queryTabs.length && (state.activeTabId !== previous.activeTabId || state.currentView !== previous.currentView)) setTerminalActive(false);
  }), []);
  useEffect(() => {
    if (preferTerminal && useTerminalStore.getState().activeSessionId) setTerminalActive(true);
  }, [preferTerminal]);

  function showList() {
    setTerminalActive(false);
    useDbStore.getState().setCurrentView("objects");
  }
  function requestClose(tab: QueryTab) {
    if (tab.isExecuting || tab.isSaving) return;
    const sql = (tab.kind ?? "query") === "query" ? getQueryDraft(tab.id, tab.sql) : tab.sql;
    if ((tab.kind ?? "query") === "query" && sql !== tab.sql) useDbStore.getState().updateTabSql(tab.id, sql);
    const queryDirty = (tab.kind ?? "query") === "query" && (tab.savedQueryId
      ? sql !== tab.savedSql || tab.database !== tab.savedDatabase
      : Boolean(sql.trim()));
    if (hasPendingEdits(tab) || queryDirty) setCloseTab({ ...tab, sql });
    else useDbStore.getState().removeQueryTab(tab.id);
  }
  const adminViews = { dashboard: DashboardView, users: UsersView, variables: VariablesView,
    processes: ProcessesView, "slow-queries": SlowQueryView, replication: ReplicationView, backup: BackupView };
  const AdminView = currentView !== "table" && currentView !== "objects" ? adminViews[currentView] : null;

  return <TooltipProvider delayDuration={250}>
    <div className="flex h-full min-h-0 overflow-hidden bg-background text-foreground">
      <ResizablePanelGroup direction="horizontal" elementRef={connectionsGroup}>
        <ResizablePanel id="db-connections" panelRef={connectionsPanel} collapsible collapsedSize="0px" defaultSize="240px" minSize="180px" maxSize="420px"
          onResize={(size, _id, previous) => {
            if (previous && visible && connectionsGroup.current?.clientWidth) setConnectionsOpen(size.inPixels > 0);
          }}>
          <div className="h-full overflow-hidden" aria-hidden={!connectionsOpen} inert={!connectionsOpen}>
            <ConnectionTree terminalActive={terminalActive} onOpenTerminal={() => setTerminalActive(true)} onActivateDatabase={() => setTerminalActive(false)} />
          </div>
        </ResizablePanel>
        <ResizableHandle disabled={!connectionsOpen} className={cn(!connectionsOpen && "invisible pointer-events-none")} />
        <ResizablePanel id="db-content" minSize="400px" className="min-h-0 min-w-0 overflow-hidden">
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            <div className="flex h-8 shrink-0 items-center border-b border-border">
              <Tooltip><TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0"
                  aria-label={connectionsOpen ? "收起连接列表" : "展开连接列表"} aria-expanded={connectionsOpen} aria-controls="db-connections"
                  onClick={() => setConnectionsOpen(!connectionsOpen)}>
                  {connectionsOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
                </Button>
              </TooltipTrigger><TooltipContent>{connectionsOpen ? "收起连接列表" : "展开连接列表"}</TooltipContent></Tooltip>
              <div ref={tabBar} role="tablist" aria-label="运维工作标签" className="flex min-w-0 flex-1 overflow-x-auto scrollbar-none">
                <Button role="tab" aria-selected={!terminalActive && currentView === "objects"} variant="ghost"
                  className={cn("h-8 shrink-0 gap-2 rounded-none border-b-2 px-3 text-caption", !terminalActive && currentView === "objects" ? "border-info bg-muted/20" : "border-transparent")}
                  onClick={showList}><DbIcon name="table" className="h-4 w-4" />列表</Button>
                {tabs.map((tab) => <div key={tab.id} className={cn("group relative flex h-8 shrink-0 items-center border-b-2 border-r border-r-border", !terminalActive && currentView === "table" && activeId === tab.id ? "border-b-info bg-muted/20" : "border-b-transparent hover:bg-accent/50")}>
                  <Button role="tab" aria-selected={!terminalActive && currentView === "table" && activeId === tab.id} variant="ghost" title={`${tab.connectionId ? useDbStore.getState().activeConnections.find((c) => c.id === tab.connectionId)?.config.name ?? "" : ""} / ${tab.database ?? ""} / ${tab.title}`}
                    className={cn("h-8 gap-2 rounded-none px-3 pr-8 text-caption font-normal hover:bg-transparent", tab.preview && "italic")}
                    onClick={() => { setTerminalActive(false); useDbStore.getState().setActiveTab(tab.id); }} onDoubleClick={() => useDbStore.getState().pinTab(tab.id)}>
                    <DbIcon name={tab.kind === "structure" ? "structure" : tab.kind === "table" ? tab.objectType === "view" ? "view" : "table" : "query"} className="h-4 w-4" />
                    <span className="max-w-44 truncate">{tab.title}</span>
                    {hasPendingEdits(tab) && <span className="text-warning" aria-label="有未保存的修改">●</span>}
                  </Button>
                  <DbToolButton icon="close" label={`关闭 ${tab.title}`} className="absolute right-1 top-1/2 z-10 h-6 w-6 -translate-y-1/2 rounded-sm bg-background/90 opacity-0 pointer-events-none shadow-none transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100" disabled={tab.isExecuting || tab.isSaving} onClick={() => requestClose(tab)} />
                </div>)}
                <SessionTabBar embedded active={terminalActive} onActivate={() => setTerminalActive(true)} />
                <OperationsCreateMenu onOpenTerminal={() => setTerminalActive(true)} queryConnectionId={queryTarget?.connectionId}
                  onNewQuery={(connectionId) => {
                    const state = useDbStore.getState();
                    if (!state.activeConnections.some((connection) => connection.id === connectionId && connection.status === "connected")) return;
                    state.addQueryTab(connectionId, queryTarget?.connectionId === connectionId ? queryTarget.database : null);
                    setTerminalActive(false);
                  }} />
              </div>
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label={currentAgentOpen ? "收起 Mona" : "展开 Mona"} disabled={terminalActive && !terminalAgentAvailable} onClick={() => { if (terminalActive) useTerminalStore.getState().toggleAIPanel(); else setAgentOpen((open) => !open); }}>
                <AgentLogo state="idle" className="h-5 w-5" />
              </Button></TooltipTrigger><TooltipContent>{currentAgentOpen ? "收起 Mona" : "展开 Mona"}</TooltipContent></Tooltip>
            </div>
            <div className="relative min-h-0 flex-1">
              <div className={cn("absolute inset-0 overflow-hidden", (terminalActive || currentView !== "objects") && "hidden")}>
                {selectedDatabaseConnected ? (
                  <TableListView active={visible && !terminalActive && currentView === "objects"} connectionId={objectScope!.connectionId} database={objectScope!.database} objectType={objectScope!.objectType}
                    onOpenTable={(name, pinned, objectType) => { if (objectScope) void useDbStore.getState().selectTable(objectScope.connectionId, objectScope.database, name, pinned, objectType); }}
                    onNewQuery={() => {
                      if (objectScope) { useDbStore.getState().setSelectedConnectionId(objectScope.connectionId); useDbStore.getState().setSelectedDatabase(objectScope.database); }
                      useDbStore.getState().addQueryTab(objectScope?.connectionId, objectScope?.database);
                    }} />
                ) : (
                  <OperationsConnectionList onOpenTerminal={() => setTerminalActive(true)} />
                )}
              </div>
              {tabs.map((tab) => <div key={tab.id} className={cn("absolute inset-0", (terminalActive || currentView !== "table" || activeId !== tab.id) && "hidden")}>
                {tab.kind === "structure" ? <TableStructureEditor tab={tab} /> : tab.kind === "table" ? <TableBrowser tab={tab} /> : <QueryWorkspace tab={tab} />}
              </div>)}
              {AdminView && <div className={cn("absolute inset-0 overflow-auto", terminalActive && "hidden")}><AdminView /></div>}
              <div className={cn("absolute inset-0", !terminalActive && "invisible pointer-events-none")} aria-hidden={!terminalActive} inert={!terminalActive}>
                <TerminalView embedded visible={visible && terminalActive} onOpenSubscribe={onOpenSubscribe} />
              </div>
            </div>
          </div>
        </ResizablePanel>
        {agentOpen && !terminalActive && <>
          <ResizableHandle aria-label="调整 Mona 侧栏宽度" />
          <ResizablePanel id="db-agent" defaultSize="320px" minSize="260px" maxSize="600px" className="min-h-0 min-w-0 overflow-hidden">
            <DbAgentPanel />
          </ResizablePanel>
        </>}
      </ResizablePanelGroup>
      <NewConnectionDialog /><EditConnectionDialog />
    </div>
    <AlertDialog open={!!closeTab} onOpenChange={(open) => !open && setCloseTab(null)}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>关闭“{closeTab?.title}”？</AlertDialogTitle>
        <AlertDialogDescription>{closeTab?.kind === "structure" ? "此标签还有未应用的结构修改。关闭会放弃这些修改。" : closeTab?.kind === "table" ? "此标签还有未保存的数据修改。关闭会放弃这些修改。" : "此查询包含 SQL 草稿，请先保存需要保留的内容。关闭后将丢弃草稿。"}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => { if (closeTab) { useDbStore.getState().revertAllEdits(closeTab.id); useDbStore.getState().removeQueryTab(closeTab.id); } setCloseTab(null); }}>放弃并关闭</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </TooltipProvider>;
}
