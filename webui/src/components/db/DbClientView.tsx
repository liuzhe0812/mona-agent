import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { RightSidebarToggleIcon } from "@/components/notes/RightSidebarToggleIcon";
import { cn } from "@/lib/utils";
import { useLicense } from "@/hooks/useLicense";
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
import { DbIcon } from "./DbIcon";
import { DbToolButton } from "./DbToolButton";
import { useDbStore } from "./store/dbStore";
import { hasPendingEdits } from "./table-sql";
import type { QueryTab } from "./types";

export function DbClientView({ onOpenSubscribe }: { onOpenSubscribe?: () => void }) {
  const { licenseActive } = useLicense();
  const tabs = useDbStore((s) => s.queryTabs);
  const activeId = useDbStore((s) => s.activeTabId);
  const currentView = useDbStore((s) => s.currentView);
  const objectScope = useDbStore((s) => s.objectScope);
  const tree = useDbStore((s) => s.connectionTree);
  const connections = useDbStore((s) => s.activeConnections);
  const [agentOpen, setAgentOpen] = useState(false);
  const [closeTab, setCloseTab] = useState<QueryTab | null>(null);
  const initialized = useRef(false);
  const tabBar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!initialized.current) { initialized.current = true; void useDbStore.getState().loadSavedConnections(); }
  }, []);
  useEffect(() => {
    if (objectScope || currentView !== "objects") return;
    const [connectionId, databases] = Object.entries(tree)[0] ?? [];
    if (connectionId && databases?.[0]) useDbStore.getState().openDatabase(connectionId, databases[0].name);
  }, [tree, objectScope, currentView]);
  useEffect(() => {
    tabBar.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId, currentView]);

  function showList() {
    const state = useDbStore.getState();
    const scope = state.objectScope;
    const tab = state.queryTabs.find((t) => t.id === state.activeTabId);
    if (state.currentView === "table" && tab?.connectionId && tab.database) state.openDatabase(tab.connectionId, tab.database, tab.objectType);
    else if (scope) state.openDatabase(scope.connectionId, scope.database, scope.objectType);
    else state.setCurrentView("objects");
  }
  function requestClose(tab: QueryTab) {
    if (tab.isExecuting || tab.isSaving) return;
    if (hasPendingEdits(tab) || (tab.kind !== "table" && tab.sql.trim())) setCloseTab(tab);
    else useDbStore.getState().removeQueryTab(tab.id);
  }
  const adminViews = { dashboard: DashboardView, users: UsersView, variables: VariablesView,
    processes: ProcessesView, "slow-queries": SlowQueryView, replication: ReplicationView, backup: BackupView };
  const AdminView = currentView !== "table" && currentView !== "objects" ? adminViews[currentView] : null;

  return <TooltipProvider delayDuration={250}>
    <div className="flex h-full min-h-0 overflow-hidden bg-background text-foreground">
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel id="db-connections" defaultSize="240px" minSize="180px" maxSize="420px">
          <ConnectionTree />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="db-content" minSize="400px">
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            <div className="flex h-9 shrink-0 items-center border-b border-border">
              <div ref={tabBar} role="tablist" aria-label="数据库工作标签" className="flex min-w-0 flex-1 overflow-x-auto scrollbar-none">
                <Button role="tab" aria-selected={currentView === "objects"} variant="ghost"
                  className={cn("h-9 shrink-0 gap-2 rounded-none border-b-2 px-3 text-caption", currentView === "objects" ? "border-info bg-muted/20" : "border-transparent")}
                  onClick={showList}><DbIcon name="table" className="h-4 w-4" />表清单</Button>
                {tabs.map((tab) => <div key={tab.id} className={cn("group flex h-9 shrink-0 items-center border-b-2 border-r border-r-border", currentView === "table" && activeId === tab.id ? "border-b-info bg-muted/20" : "border-b-transparent")}>
                  <Button role="tab" aria-selected={currentView === "table" && activeId === tab.id} variant="ghost" title={`${tab.connectionId ? useDbStore.getState().activeConnections.find((c) => c.id === tab.connectionId)?.config.name ?? "" : ""} / ${tab.database ?? ""} / ${tab.title}`}
                    className={cn("h-8 gap-2 rounded-none px-3 text-caption font-normal", tab.preview && "italic")}
                    onClick={() => useDbStore.getState().setActiveTab(tab.id)} onDoubleClick={() => useDbStore.getState().pinTab(tab.id)}>
                    <DbIcon name={tab.kind === "table" ? tab.objectType === "view" ? "view" : "table" : "query"} className="h-4 w-4" />
                    <span className="max-w-44 truncate">{tab.title}</span>
                    {hasPendingEdits(tab) && <span className="text-warning" aria-label="有未保存的修改">●</span>}
                  </Button>
                  <DbToolButton icon="close" label={`关闭 ${tab.title}`} className="mr-1 h-6 w-6" disabled={tab.isExecuting || tab.isSaving} onClick={() => requestClose(tab)} />
                </div>)}
                <DbToolButton icon="add" label="新建查询" onClick={() => useDbStore.getState().addQueryTab()} />
              </div>
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label={agentOpen ? "收起 Mona" : "展开 Mona"} onClick={() => licenseActive ? setAgentOpen((open) => !open) : onOpenSubscribe?.()}>
                <RightSidebarToggleIcon open={agentOpen} className="h-4 w-4" />
              </Button></TooltipTrigger><TooltipContent>{agentOpen ? "收起 Mona" : "展开 Mona"}</TooltipContent></Tooltip>
            </div>
            <div className="relative min-h-0 flex-1">
              <div className={cn("absolute inset-0", currentView !== "objects" && "hidden")}>
                <TableListView connectionId={connections.some((c) => c.id === objectScope?.connectionId) ? objectScope?.connectionId ?? null : null} database={objectScope?.database ?? null} objectType={objectScope?.objectType}
                  onOpenTable={(name, pinned, objectType) => { if (objectScope) void useDbStore.getState().selectTable(objectScope.connectionId, objectScope.database, name, pinned, objectType); }}
                  onNewQuery={() => {
                    if (objectScope) { useDbStore.getState().setSelectedConnectionId(objectScope.connectionId); useDbStore.getState().setSelectedDatabase(objectScope.database); }
                    useDbStore.getState().addQueryTab(objectScope?.connectionId, objectScope?.database);
                  }} />
              </div>
              {tabs.map((tab) => <div key={tab.id} className={cn("absolute inset-0", (currentView !== "table" || activeId !== tab.id) && "hidden")}>
                {tab.kind === "table" ? <TableBrowser tab={tab} /> : <QueryWorkspace tab={tab} />}
              </div>)}
              {AdminView && <div className="absolute inset-0 overflow-auto"><AdminView /></div>}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      {licenseActive && <DbAgentPanel collapsed={!agentOpen} width={320} />}
      <NewConnectionDialog /><EditConnectionDialog />
    </div>
    <AlertDialog open={!!closeTab} onOpenChange={(open) => !open && setCloseTab(null)}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>关闭“{closeTab?.title}”？</AlertDialogTitle>
        <AlertDialogDescription>{closeTab?.kind === "table" ? "此标签还有未保存的数据修改。关闭会放弃这些修改。" : "此查询包含 SQL 草稿，请先保存需要保留的内容。关闭后将丢弃草稿。"}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => { if (closeTab) { useDbStore.getState().revertAllEdits(closeTab.id); useDbStore.getState().removeQueryTab(closeTab.id); } setCloseTab(null); }}>放弃并关闭</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </TooltipProvider>;
}
