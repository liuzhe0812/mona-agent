import { BotMessageSquare } from "lucide-react";
import { useState } from "react";

import { invokeWithTimeout } from "@/lib/tauri";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { MaintenancePanel } from "./MaintenancePanel";
import { OverviewPanel } from "./OverviewPanel";
import { SoftwarePanel } from "./SoftwarePanel";
import { StartupPanel } from "./StartupPanel";
import { StoragePanel } from "./StoragePanel";
import { SystemAssistant } from "./SystemAssistant";
import type { SystemAgentHandoffTask } from "./systemAgentHandoff";
import { SystemOptimizationPanel } from "./SystemOptimizationPanel";
import { systemTabs, type SystemTab } from "./systemTabs";
import { useSoftwareManagement, useStorageScan } from "./useSystemData";

export function SystemView({ initialTab = "overview" }: { initialTab?: SystemTab }) {
  const [activeTab, setActiveTab] = useState<SystemTab>(initialTab);
  const [hasVisitedStorage, setHasVisitedStorage] = useState(initialTab === "storage");
  const [hasVisitedSoftware, setHasVisitedSoftware] = useState(initialTab === "software");
  const [handoffTask, setHandoffTask] = useState<SystemAgentHandoffTask | null>(null);
  const [analysisRequest, setAnalysisRequest] = useState<{ goal: string; nonce: number; channel?: "plan" | "diagnose" } | null>(null);
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
                <span className="absolute inset-x-3 bottom-0 h-px bg-info" />
              ) : null}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={assistantCollapsed ? "展开 Mona 系统管家" : "收起 Mona 系统管家"}
          aria-pressed={!assistantCollapsed}
          onClick={toggleAssistant}
          className="gap-1.5"
        >
          <BotMessageSquare className="h-4 w-4" />
          系统管家
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
                  onAnalyze={(goal) => setAnalysisRequest({ goal, nonce: Date.now(), channel: "diagnose" })}
                />
              </div>
            ) : null}

            {hasVisitedSoftware ? (
              <div hidden={activeTab !== "software"}>
                <SoftwarePanel onHandoff={handleHandoff} />
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
          onNavigate={switchTab}
          collapsed={assistantCollapsed}
          onCollapse={toggleAssistant}
          handoffTask={handoffTask}
          onHandoffTaskHandled={(taskId) =>
            setHandoffTask((current) => (current?.id === taskId ? null : current))
          }
          analysisRequest={analysisRequest}
        />
      </div>
    </div>
  );
}
