import { useState } from "react";

import { invokeWithTimeout } from "@/lib/tauri";
import { cn } from "@/lib/utils";

import { AgentLogo } from "@/components/AgentLogo";
import { Button } from "@/components/ui/button";
import { RightSidebarToggleIcon } from "@/components/notes/RightSidebarToggleIcon";
import { MaintenancePanel } from "./MaintenancePanel";
import { OverviewPanel } from "./OverviewPanel";
import { SoftwarePanel } from "./SoftwarePanel";
import { StartupPanel } from "./StartupPanel";
import { StoragePanel } from "./StoragePanel";
import { SystemAssistant } from "./SystemAssistant";
import type { SystemAgentHandoffTask } from "./systemAgentHandoff";
import { SystemOptimizationPanel } from "./SystemOptimizationPanel";
import { systemTabs, type SystemTab } from "./systemTabs";
import { useSoftwareManagement, useStorageScan, type DirectorySize } from "./useSystemData";

export function SystemView({ initialTab = "overview" }: { initialTab?: SystemTab }) {
  const [activeTab, setActiveTab] = useState<SystemTab>(initialTab);
  const [hasVisitedStorage, setHasVisitedStorage] = useState(initialTab === "storage");
  const [hasVisitedSoftware, setHasVisitedSoftware] = useState(initialTab === "software");
  const [handoffTask, setHandoffTask] = useState<SystemAgentHandoffTask | null>(null);
  const [analysisRequest, setAnalysisRequest] = useState<{ goal: string; nonce: number; channel?: "plan" | "diagnose" | "storage" } | null>(null);
  const [storageSelection, setStorageSelection] = useState<DirectorySize | null>(null);
  const [showSoftwareUpdatesRequest, setShowSoftwareUpdatesRequest] = useState(0);
  const [assistantCollapsed, setAssistantCollapsed] = useState(
    () => localStorage.getItem("system.assistantCollapsed") === "true",
  );
  const storage = useStorageScan();
  const software = useSoftwareManagement();

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

  const openAssistant = () => {
    if (!assistantCollapsed) return;
    localStorage.setItem("system.assistantCollapsed", "false");
    setAssistantCollapsed(false);
  };

  const handleAssistantNavigate = (tab: SystemTab) => {
    if (tab === "software") setShowSoftwareUpdatesRequest(Date.now());
    switchTab(tab);
  };

  const handleHandoff = (task: SystemAgentHandoffTask) => {
    setHandoffTask(task);
    if (assistantCollapsed) toggleAssistant();
  };

  const updateCount = software.data?.updates.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
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
        <Button
          variant="ghost"
          size="icon"
          title={assistantCollapsed ? "展开系统管家" : "收起系统管家"}
          aria-label={assistantCollapsed ? "展开 Mona 系统管家" : "收起 Mona 系统管家"}
          aria-expanded={!assistantCollapsed}
          aria-controls="system-assistant-panel"
          onClick={toggleAssistant}
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
        >
          {assistantCollapsed ? (
            <AgentLogo state="idle" className="h-4 w-4" />
          ) : (
            <RightSidebarToggleIcon open className="h-3.5 w-3.5" />
          )}
        </Button>
      </header>

      <div
        data-testid="system-layout"
        className={cn(
          "grid min-h-0 flex-1",
          assistantCollapsed
            ? "grid-cols-[minmax(0,1fr)]"
            : "grid-cols-[minmax(0,1fr)_360px]",
        )}
      >
        <main className="min-h-0 overflow-y-auto scrollbar-hover bg-background">
          <div className="mx-auto w-full max-w-7xl p-6">
            {activeTab === "overview" ? (
              <OverviewPanel
                onNavigate={switchTab}
                onStartStorageScan={() => void storage.start()}
                onAcknowledgeStartupItems={() => invokeWithTimeout<void>("system_acknowledge_startup_items", {}, 10_000)}
              />
            ) : null}

            {hasVisitedStorage ? (
              <div hidden={activeTab !== "storage"}>
                <StoragePanel
                  scan={storage}
                  onHandoff={handleHandoff}
                  onAnalyzeScope={(directory) => {
                    setStorageSelection(directory);
                    openAssistant();
                    setAnalysisRequest({
                      goal: "分析当前存储范围的主要占用、长期未修改大文件和可处理方向",
                      nonce: Date.now(),
                      channel: "storage",
                    });
                  }}
                  onPlanCleanup={() => {
                    openAssistant();
                    setAnalysisRequest({
                      goal: "释放磁盘可安全清理空间",
                      nonce: Date.now(),
                      channel: "plan",
                    });
                  }}
                  onSelectionChange={setStorageSelection}
                />
              </div>
            ) : null}

            {hasVisitedSoftware ? (
              <div hidden={activeTab !== "software"}>
                <SoftwarePanel
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

        <SystemAssistant
          tab={activeTab}
          storage={storage}
          software={software.data}
          onNavigate={handleAssistantNavigate}
          collapsed={assistantCollapsed}
          onCollapse={toggleAssistant}
          handoffTask={handoffTask}
          onHandoffTaskHandled={(taskId) =>
            setHandoffTask((current) => (current?.id === taskId ? null : current))
          }
          analysisRequest={analysisRequest}
          storageSelection={storageSelection}
        />
      </div>
    </div>
  );
}
