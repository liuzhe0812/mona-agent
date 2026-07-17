import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Square, Plus, FolderOpen, Save, Download, Upload, Trash2, PlusCircle, ChevronLeft, ChevronRight, LockKeyhole } from "lucide-react";
import { AgentLogo } from "@/components/AgentLogo";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useLicense } from "@/hooks/useLicense";
import { ConnectionTree } from "./ConnectionTree";
import { SqlEditor } from "./SqlEditor";
import { ResultPanel } from "./ResultPanel";
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
import { useDbStore } from "./store/dbStore";

const LEFT_PANEL_MIN = 180;
const LEFT_PANEL_MAX = 480;
const LEFT_PANEL_DEFAULT = 260;
const RESULT_PANEL_MIN = 120;
const RESULT_PANEL_DEFAULT = 360;
const AGENT_PANEL_MIN = 240;
const AGENT_PANEL_MAX = 480;
const AGENT_PANEL_DEFAULT = 320;

export function DbClientView({ onOpenSubscribe }: { onOpenSubscribe?: () => void }) {
  const { licenseActive } = useLicense();
  const loadSavedConnections = useDbStore((s) => s.loadSavedConnections);
  const queryTabs = useDbStore((s) => s.queryTabs);
  const activeTabId = useDbStore((s) => s.activeTabId);
  const addQueryTab = useDbStore((s) => s.addQueryTab);
  const removeQueryTab = useDbStore((s) => s.removeQueryTab);
  const setActiveTab = useDbStore((s) => s.setActiveTab);
  const executeQuery = useDbStore((s) => s.executeQuery);
  const currentView = useDbStore((s) => s.currentView);
  const selectedConnectionId = useDbStore((s) => s.selectedConnectionId);
  const selectedDatabase = useDbStore((s) => s.selectedDatabase);
  const activeConnections = useDbStore((s) => s.activeConnections);
  const selectedTable = useDbStore((s) => s.selectedTable);
  const serverStats = useDbStore((s) => s.serverStats);
  const agentStreaming = useDbStore((s) => s.agentStreaming);
  const initializedRef = useRef(false);

  const [leftWidth, setLeftWidth] = useState(LEFT_PANEL_DEFAULT);
  const [resultHeight, setResultHeight] = useState(RESULT_PANEL_DEFAULT);
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(false);
  const [agentPanelWidth, setAgentPanelWidth] = useState(AGENT_PANEL_DEFAULT);
  const leftDraggingRef = useRef(false);
  const resultDraggingRef = useRef(false);
  const agentDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startLeftWidthRef = useRef(0);
  const startResultHeightRef = useRef(0);
  const startAgentWidthRef = useRef(0);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    loadSavedConnections();
  }, [loadSavedConnections]);

  const onLeftDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    leftDraggingRef.current = true;
    startXRef.current = e.clientX;
    startLeftWidthRef.current = leftWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [leftWidth]);

  const onResultDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resultDraggingRef.current = true;
    startYRef.current = e.clientY;
    startResultHeightRef.current = resultHeight;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [resultHeight]);

  const onAgentDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    agentDraggingRef.current = true;
    startXRef.current = e.clientX;
    startAgentWidthRef.current = agentPanelWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [agentPanelWidth]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (leftDraggingRef.current) {
        const delta = e.clientX - startXRef.current;
        const next = Math.min(LEFT_PANEL_MAX, Math.max(LEFT_PANEL_MIN, startLeftWidthRef.current + delta));
        setLeftWidth(next);
      }
      if (resultDraggingRef.current) {
        const delta = startYRef.current - e.clientY;
        const next = Math.max(RESULT_PANEL_MIN, startResultHeightRef.current + delta);
        setResultHeight(next);
      }
      if (agentDraggingRef.current) {
        const delta = startXRef.current - e.clientX;
        const next = Math.min(AGENT_PANEL_MAX, Math.max(AGENT_PANEL_MIN, startAgentWidthRef.current + delta));
        setAgentPanelWidth(next);
      }
    };
    const onMouseUp = () => {
      if (leftDraggingRef.current) {
        leftDraggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
      if (resultDraggingRef.current) {
        resultDraggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
      if (agentDraggingRef.current) {
        agentDraggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const activeTab = queryTabs.find((t) => t.id === activeTabId);
  const activeConn = activeConnections.find((c) => c.id === selectedConnectionId);

  return (
    <div className="flex h-full overflow-hidden">
      <div style={{ width: leftWidth }} className="shrink-0">
        <ConnectionTree />
      </div>

      <div
        className="w-[1px] shrink-0 cursor-col-resize bg-border"
        onMouseDown={onLeftDragStart}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {currentView === "table" && (
          <>
            <QueryTabBar
              tabs={queryTabs}
              activeTabId={activeTabId}
              onTabClick={setActiveTab}
              onTabClose={removeQueryTab}
              onAddTab={addQueryTab}
            />

            <TooltipProvider delayDuration={300}>
              <div className="flex items-center gap-2 border-b border-border bg-card px-3.5 py-1.5">
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        className="h-6 gap-1 bg-blue-600 px-2 text-xs text-white hover:bg-blue-700"
                        disabled={!activeTab?.connectionId || activeTab?.isExecuting}
                        onClick={() => activeTabId && executeQuery(activeTabId)}
                      >
                        <Play className="h-2.5 w-2.5" />
                        执行
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>执行查询 (Ctrl+Enter)</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 w-6 px-0" disabled>
                        <Square className="h-2.5 w-2.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>停止查询</TooltipContent>
                  </Tooltip>
                </div>
                <Separator orientation="vertical" className="h-5" />
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 w-6 px-0" onClick={addQueryTab}>
                        <PlusCircle className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>新建查询</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 w-6 px-0" disabled>
                        <FolderOpen className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>打开</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 w-6 px-0" disabled>
                        <Save className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>保存</TooltipContent>
                  </Tooltip>
                </div>
                <Separator orientation="vertical" className="h-5" />
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 w-6 px-0" disabled>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>导入</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 w-6 px-0" disabled>
                        <Upload className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>导出</TooltipContent>
                  </Tooltip>
                </div>
                <Separator orientation="vertical" className="h-5" />
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 w-6 px-0" disabled>
                        <PlusCircle className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>插入行</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 px-0 text-destructive hover:text-destructive"
                        disabled
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>删除行</TooltipContent>
                  </Tooltip>
                </div>
                <div className="flex-1" />
                <span className="text-[11px] text-muted-foreground">
                  {selectedTable?.name}
                </span>
                <>
                  <Separator orientation="vertical" className="h-5" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center justify-center"
                        onClick={licenseActive ? () => setAgentPanelCollapsed((c) => !c) : onOpenSubscribe}
                      >
                        {licenseActive ? (
                          <AgentLogo state={agentStreaming ? "working" : "idle"} className="h-5 w-5" />
                        ) : (
                          <LockKeyhole className="h-4 w-4 text-muted-foreground" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{licenseActive ? (agentPanelCollapsed ? "展开 Mona" : "收起 Mona") : "升级 Pro 解锁数据库 AI"}</TooltipContent>
                  </Tooltip>
                </>
              </div>
            </TooltipProvider>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col">
                <SqlEditor />
              </div>
              <div
                className="h-[1px] shrink-0 cursor-row-resize bg-border"
                onMouseDown={onResultDragStart}
              />
              <div style={{ height: resultHeight }} className="shrink-0">
                <ResultPanel />
              </div>
            </div>
          </>
        )}

        {currentView === "dashboard" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <DashboardView />
          </div>
        )}
        {currentView === "users" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <UsersView />
          </div>
        )}
        {currentView === "variables" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <VariablesView />
          </div>
        )}
        {currentView === "processes" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ProcessesView />
          </div>
        )}
        {currentView === "slow-queries" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <SlowQueryView />
          </div>
        )}
        {currentView === "replication" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ReplicationView />
          </div>
        )}
        {currentView === "backup" && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <BackupView />
          </div>
        )}

        <div className="flex items-center justify-between border-t border-border bg-card px-3.5 py-1 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            {activeConn ? (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                {activeConn.config.name}
                {activeConn.server_version && ` · ${activeConn.server_version}`}
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                未连接
              </span>
            )}
            {selectedDatabase && <span>{selectedDatabase}</span>}
          </div>
          <div className="flex items-center gap-3">
            {activeConn && (
              <>
                <span>{activeConnections.length} 连接</span>
                {serverStats && <span>{serverStats.qps.toLocaleString()} QPS</span>}
                {serverStats?.replication_lag_seconds !== null && serverStats?.replication_lag_seconds !== undefined && (
                  <span>延迟 {serverStats.replication_lag_seconds.toFixed(1)}ms</span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {licenseActive && !agentPanelCollapsed && (
        <div
          className="w-[1px] shrink-0 cursor-col-resize bg-border"
          onMouseDown={onAgentDragStart}
        />
      )}

      {licenseActive && (
        <DbAgentPanel
          collapsed={agentPanelCollapsed}
          width={agentPanelWidth}
        />
      )}

      <NewConnectionDialog />
      <EditConnectionDialog />
    </div>
  );
}

function QueryTabBar({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onAddTab,
}: {
  tabs: { id: string; title: string }[];
  activeTabId: string | null;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  onAddTab: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollState, tabs]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const activeTabEl = el.querySelector('[data-active="true"]');
    if (activeTabEl) {
      activeTabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeTabId]);

  const scroll = useCallback((direction: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.6;
    el.scrollBy({ left: direction === "left" ? -amount : amount, behavior: "smooth" });
  }, []);

  return (
    <div className="flex items-center border-b border-border bg-card">
      {canScrollLeft && (
        <button
          type="button"
          className="flex h-full shrink-0 items-center justify-center px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => scroll("left")}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      )}
      <div
        ref={scrollRef}
        onScroll={updateScrollState}
        onWheel={(e) => {
          if (e.deltaY === 0) return;
          e.preventDefault();
          scrollRef.current?.scrollBy({ left: e.deltaY });
        }}
        className="flex min-w-0 flex-1 overflow-x-auto scrollbar-none"
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            data-active={tab.id === activeTabId}
            className={cn(
              "group flex shrink-0 items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs cursor-pointer relative",
              tab.id === activeTabId
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent",
            )}
            onClick={() => onTabClick(tab.id)}
          >
            {tab.id === activeTabId && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-theme" />
            )}
            <span className="truncate max-w-28">{tab.title}</span>
            <button
              className="ml-1 hidden text-muted-foreground hover:text-foreground group-hover:block"
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {canScrollRight && (
        <button
          type="button"
          className="flex h-full shrink-0 items-center justify-center px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => scroll("right")}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        className="flex shrink-0 items-center justify-center px-2 py-1.5 text-muted-foreground hover:text-foreground hover:bg-accent"
        onClick={onAddTab}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
