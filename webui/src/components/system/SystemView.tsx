import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { cn } from "@/lib/utils";

import { AgentLogo } from "@/components/AgentLogo";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { MaintenancePanel } from "./MaintenancePanel";
import { OverviewPanel } from "./OverviewPanel";
import { SoftwarePanel } from "./SoftwarePanel";
import { StartupPanel } from "./StartupPanel";
import { StoragePanel } from "./StoragePanel";
import { SystemAssistant } from "./SystemAssistant";
import type { SystemAgentHandoffTask } from "./systemAgentHandoff";
import { STORAGE_DIRECTORY_ANALYSIS_PROMPT, STORAGE_FILE_ANALYSIS_PROMPT, type SystemAnalysisRequest } from "./systemAgentApi";
import { SystemOptimizationPanel } from "./SystemOptimizationPanel";
import { systemTabs, type SystemTab } from "./systemTabs";
import { formatStorage, useSoftwareManagement, useStorageScan, useSystemDiagnostics, type CleanupItem, type DirectorySize, type TopFileInfo } from "./useSystemData";

export function SystemView({ initialTab = "overview" }: { initialTab?: SystemTab }) {
  const [activeTab, setActiveTab] = useState<SystemTab>(initialTab);
  const [hasVisitedStorage, setHasVisitedStorage] = useState(initialTab === "storage");
  const [hasVisitedSoftware, setHasVisitedSoftware] = useState(initialTab === "software");
  const [handoffTask, setHandoffTask] = useState<SystemAgentHandoffTask | null>(null);
  const [storageSelection, setStorageSelection] = useState<DirectorySize | null>(null);
  const [analysisRequest, setAnalysisRequest] = useState<SystemAnalysisRequest | null>(null);
  const [analyzingFileId, setAnalyzingFileId] = useState<string | null>(null);
  const analysisNonceRef = useRef(0);
  const [showSoftwareUpdatesRequest, setShowSoftwareUpdatesRequest] = useState(0);
  const [requestedScanDrive, setRequestedScanDrive] = useState<string | null>(null);
  const [cleanupTargets, setCleanupTargets] = useState<CleanupItem[] | null>(null);
  const [cleanupNotice, setCleanupNotice] = useState("");
  const [operationError, setOperationError] = useState<{ title: string; description: string; detail?: string; tab: SystemTab } | null>(null);
  const [assistantCollapsed, setAssistantCollapsed] = useState(
    () => localStorage.getItem("system.assistantCollapsed") === "true",
  );
  const assistantPanelRef = useRef<PanelImperativeHandle | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const storage = useStorageScan();
  const software = useSoftwareManagement();
  const diagnostics = useSystemDiagnostics();

  useEffect(() => {
    if (!requestedScanDrive || storage.selectedDrive !== requestedScanDrive) return;
    setRequestedScanDrive(null);
    void storage.start();
  }, [requestedScanDrive, storage.selectedDrive, storage.start]);

  useLayoutEffect(() => {
    if (assistantCollapsed) assistantPanelRef.current?.collapse();
    else assistantPanelRef.current?.expand();
  }, [assistantCollapsed]);

  const switchTab = (tab: SystemTab) => {
    setActiveTab(tab);
    if (tab === "storage") setHasVisitedStorage(true);
    if (tab === "software") setHasVisitedSoftware(true);
  };

  const toggleAssistant = () => {
    setAssistantCollapsed((previous) => {
      localStorage.setItem("system.assistantCollapsed", String(!previous));
      return !previous;
    });
  };

  const handleAssistantNavigate = (tab: SystemTab) => {
    if (tab === "software") setShowSoftwareUpdatesRequest(Date.now());
    switchTab(tab);
  };

  const handleHandoff = (task: SystemAgentHandoffTask) => {
    setHandoffTask(task);
    if (assistantCollapsed) toggleAssistant();
  };

  const analyzeFile = (file: TopFileInfo) => {
    if (!storage.result || analyzingFileId === file.id) return;
    setAssistantCollapsed(false);
    localStorage.setItem("system.assistantCollapsed", "false");
    setAnalyzingFileId(file.id);
    setAnalysisRequest({ goal: STORAGE_FILE_ANALYSIS_PROMPT, nonce: ++analysisNonceRef.current, channel: "storage", fileId: file.id, scanId: storage.result.scanId });
  };
  const analyzeDirectory = (directory: DirectorySize) => {
    if (!storage.result) return;
    setAssistantCollapsed(false);
    localStorage.setItem("system.assistantCollapsed", "false");
    setStorageSelection(directory);
    setAnalysisRequest({ goal: STORAGE_DIRECTORY_ANALYSIS_PROMPT, nonce: ++analysisNonceRef.current, channel: "storage", directoryId: directory.id, scanId: storage.result.scanId });
  };

  const confirmCleanup = async () => {
    if (!cleanupTargets?.length || storage.cleaning) return;
    const targetIds = cleanupTargets.map((item) => item.id);
    setCleanupTargets(null);
    setCleanupNotice("");
    try {
      const result = await storage.clean(targetIds);
      if (result.failures.length > 0) {
        setOperationError({ title: result.cleanedIds.length > 0 ? "部分清理未完成" : "清理未完成", description: `实际释放 ${formatStorage(result.freedGb)}，${result.failures.length} 项未完成。可查看清理项确认剩余内容。`, detail: result.failures.join("\n"), tab: "storage" });
      } else {
        setCleanupNotice(`清理完成，实际释放 ${formatStorage(result.freedGb)}`);
      }
    } catch (error) {
      setOperationError({ title: "无法确认清理结果", description: "请重新扫描并确认剩余内容后再重试。", detail: String(error), tab: "storage" });
    } finally {
      setCleanupTargets(null);
    }
  };

  const upgradeAll = async () => {
    if (software.workingIds.size > 0 || !software.data?.updates.length) return;
    const result = await software.upgrade(software.data.updates);
    if (result && result.failed + result.uncertain > 0) {
      setOperationError({ title: result.completed > 0 ? "部分软件更新未完成" : "软件更新未完成", description: `${result.summary}。请查看更新列表确认当前状态后再重试。`, detail: result.detail, tab: "software" });
    }
  };

  const updateCount = software.data?.updates.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <ResizablePanelGroup
        direction="horizontal"
        elementRef={layoutRef}
        id="system-layout"
        className="min-h-0 flex-1"
      >
        <ResizablePanel id="system-main" minSize="400px" className="min-h-0 min-w-0">
          <div className="flex h-full min-h-0 flex-col">
            <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border/60 pl-4 pr-3">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none" role="tablist" aria-label="系统模块导航">
                {systemTabs.map((tab) => (
                  <button
                    key={tab.id}
                    role="tab"
                    aria-selected={activeTab === tab.id}
                    onClick={() => switchTab(tab.id)}
                    className={`relative flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-caption transition-colors ${
                      activeTab === tab.id
                        ? "font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {tab.label}
                    {tab.id === "software" && updateCount > 0 ? (
                      <span className="rounded-full bg-warning/15 px-1.5 py-px text-micro font-semibold text-warning">
                        {updateCount}
                      </span>
                    ) : null}
                    {activeTab === tab.id ? (
                      <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-[hsl(var(--brand-red))]" />
                    ) : null}
                  </button>
                ))}
              </div>
              {assistantCollapsed && (
                <Button
                  variant="ghost"
                  size="icon"
                  title="展开 Mona"
                  aria-label="展开 Mona 系统管家"
                  aria-expanded={false}
                  aria-controls="system-assistant-panel"
                  onClick={toggleAssistant}
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                >
                  <AgentLogo state="idle" className="h-4 w-4" />
                </Button>
              )}
            </header>
            <main className="min-h-0 flex-1 overflow-y-auto scrollbar-hover bg-background">
              <div className="mx-auto w-full max-w-7xl p-6">
                {activeTab === "overview" ? (
                  <OverviewPanel
                    diagnostics={diagnostics}
                    storage={storage.result}
                    software={software.data}
                    onRecheckSoftware={software.refresh}
                    onNavigate={switchTab}
                    onClean={() => setCleanupTargets((storage.result?.cleanupItems ?? []).filter((item) => item.cleanable && item.recommended && item.sizeGb > 0))}
                    cleaning={storage.cleaning}
                    cleanupNotice={cleanupNotice}
                    onUpgrade={() => void upgradeAll()}
                    updating={software.workingIds.size > 0}
                    updateNotice={operationError?.tab === "software" ? "" : software.lastAction}
                    storageScanning={storage.status === "scanning"}
                    onStartStorageScan={(drive) => {
                      if (storage.status === "scanning" || storage.cleaning) return;
                      storage.selectDrive(drive);
                      switchTab("storage");
                      setRequestedScanDrive(drive);
                    }}
                  />
                ) : null}

                {hasVisitedStorage ? (
                  <div hidden={activeTab !== "storage"}>
                    <StoragePanel
                      scan={storage}
                      onHandoff={handleHandoff}
                      onSelectionChange={setStorageSelection}
                      onAnalyzeFile={analyzeFile}
                      onAnalyzeDirectory={analyzeDirectory}
                      analyzingFileId={analyzingFileId}
                    />
                  </div>
                ) : null}

                {hasVisitedSoftware ? (
                  <div hidden={activeTab !== "software"}>
                    <SoftwarePanel
                      software={software}
                      onHandoff={handleHandoff}
                      showUpdatesRequest={showSoftwareUpdatesRequest}
                      showStoreDetails={assistantCollapsed}
                    />
                  </div>
                ) : null}

                {activeTab === "startup" ? <StartupPanel onHandoff={handleHandoff} /> : null}
                {activeTab === "optimization" ? <SystemOptimizationPanel /> : null}
                {activeTab === "maintenance" ? <MaintenancePanel onHandoff={handleHandoff} /> : null}
              </div>
            </main>
          </div>
        </ResizablePanel>

        <ResizableHandle
          aria-label="调整系统管家宽度"
          aria-hidden={assistantCollapsed}
          disabled={assistantCollapsed}
          className={cn(assistantCollapsed && "hidden")}
        />
        <ResizablePanel
          id="system-assistant"
          panelRef={assistantPanelRef}
          defaultSize="360px"
          minSize="280px"
          maxSize="600px"
          collapsible
          collapsedSize="0%"
          className="min-h-0 min-w-0 overflow-hidden"
          onResize={(size, _id, previous) => {
            if (!previous || !layoutRef.current?.clientWidth) return;
            const collapsed = size.asPercentage === 0;
            setAssistantCollapsed((current) => {
              if (current !== collapsed) localStorage.setItem("system.assistantCollapsed", String(collapsed));
              return collapsed;
            });
          }}
        >
          <SystemAssistant
            tab={activeTab}
            storage={storage}
            diagnosticChecks={diagnostics.checks}
            onNavigate={handleAssistantNavigate}
            collapsed={assistantCollapsed}
            onCollapse={toggleAssistant}
            handoffTask={handoffTask}
            onHandoffTaskHandled={(taskId) =>
              setHandoffTask((current) => (current?.id === taskId ? null : current))
            }
            analysisRequest={analysisRequest}
            onFileAnalysisChange={setAnalyzingFileId}
            storageSelection={storageSelection}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
      <AlertDialog open={Boolean(cleanupTargets?.length) && !storage.cleaning} onOpenChange={(open) => { if (!open && !storage.cleaning) setCleanupTargets(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认清理</AlertDialogTitle>
            <AlertDialogDescription>将直接删除以下 {cleanupTargets?.length ?? 0} 项，共约 {formatStorage(cleanupTargets?.reduce((total, item) => total + item.sizeGb, 0) ?? 0)}，不经过回收站。正在使用的文件会自动跳过。</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-48 overflow-y-auto space-y-2 text-caption">
            {cleanupTargets?.map((item) => <li key={item.id} className="flex items-center justify-between gap-3"><span>{item.name}</span><span className="text-muted-foreground">{formatStorage(item.sizeGb)}</span></li>)}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={storage.cleaning}>取消</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void confirmCleanup()} disabled={storage.cleaning}>{storage.cleaning ? "正在清理" : "确认清理"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={operationError !== null} onOpenChange={(open) => { if (!open) setOperationError(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{operationError?.title}</AlertDialogTitle>
            <AlertDialogDescription>{operationError?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          {operationError?.detail && <details className="text-caption"><summary>查看详情</summary><pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{operationError.detail}</pre></details>}
          <AlertDialogFooter>
            <AlertDialogCancel>关闭</AlertDialogCancel>
            <Button variant="outline" onClick={() => {
              if (operationError) handleAssistantNavigate(operationError.tab);
              setOperationError(null);
            }}>{operationError?.tab === "software" ? "查看更新" : "查看清理项"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
