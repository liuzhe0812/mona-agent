import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { AgentLogo } from "@/components/AgentLogo";
import sidebarSystemIcon from "@/assets/icons/sidebar-system.png";

import { MaintenancePanel } from "./MaintenancePanel";
import { OverviewPanel } from "./OverviewPanel";
import { SystemOptimizationPanel } from "./SystemOptimizationPanel";
import { SoftwarePanel } from "./SoftwarePanel";
import { StartupPanel } from "./StartupPanel";
import { StoragePanel } from "./StoragePanel";
import { SystemAssistant } from "./SystemAssistant";
import type { SystemAgentHandoffTask } from "./systemAgentHandoff";
import { systemTabs, type SystemTab } from "./mockData";
import { useSoftwareManagement, useStorageScan } from "./useSystemData";

export function SystemView({ initialTab = "overview" }: { initialTab?: SystemTab }) {
  const [activeTab, setActiveTab] = useState<SystemTab>(initialTab);
  const [softwareMounted, setSoftwareMounted] = useState(initialTab === "software");
  const [handoffTask, setHandoffTask] = useState<SystemAgentHandoffTask | null>(null);
  const [analysisRequest, setAnalysisRequest] = useState<{ goal: string; nonce: number } | null>(null);
  const [assistantCollapsed, setAssistantCollapsed] = useState(
    () => localStorage.getItem("system.assistantCollapsed") === "1",
  );
  const storageScan = useStorageScan();
  const { data: softwareData } = useSoftwareManagement();
  const updateCount = softwareData?.updates.length ?? 0;

  const handleTabChange = (tab: SystemTab) => {
    setActiveTab(tab);
    if (tab === "software") setSoftwareMounted(true);
  };

  const ActivePanel = activeTab === "overview"
    ? <OverviewPanel onNavigate={handleTabChange} onStartStorageScan={() => void storageScan.start()} onAcknowledgeStartupItems={() => invoke<void>("system_acknowledge_startup_items")} />
    : activeTab === "startup"
      ? <StartupPanel onHandoff={setHandoffTask} />
      : activeTab === "optimization"
        ? <SystemOptimizationPanel />
      : activeTab === "maintenance"
        ? <MaintenancePanel onHandoff={setHandoffTask} />
        : null;

  const expandAssistant = () => {
    setAssistantCollapsed(false);
    localStorage.setItem("system.assistantCollapsed", "0");
  };

  const collapseAssistant = () => {
    setAssistantCollapsed(true);
    localStorage.setItem("system.assistantCollapsed", "1");
  };

  useEffect(() => {
    const collapseOnNarrowResize = () => {
      setAssistantCollapsed(window.innerWidth < 1280);
    };
    window.addEventListener("resize", collapseOnNarrowResize);
    return () => window.removeEventListener("resize", collapseOnNarrowResize);
  }, []);

  return (
    <section
      data-testid="system-layout"
      className="relative grid h-full min-h-0 overflow-hidden bg-background xl:grid-cols-[minmax(0,1fr)_360px]"
    >
      <div className="flex min-h-0 min-w-0 flex-col">
        <header className="shrink-0 border-b border-border/70 bg-card/70 px-4 pt-4 lg:px-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 p-1.5 shadow-sm"><img src={sidebarSystemIcon} className="h-full w-full object-contain" alt="" draggable={false} /></span>
            <div className="min-w-0"><h1 className="text-xl font-semibold tracking-tight">系统</h1><p className="text-xs text-muted-foreground">管理电脑配置与日常维护</p></div>
            <div className="ml-auto flex items-center gap-2">
              {assistantCollapsed && <button type="button" aria-label="展开 Mona 系统管家" onClick={expandAssistant} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent hover:text-foreground"><AgentLogo state="welcome" className="h-5 w-5" /></button>}
            </div>
          </div>
          <div role="tablist" aria-label="系统功能" className="mt-3 flex gap-1 overflow-x-auto scrollbar-none">
            {systemTabs.map((tab) => {
              const badge = tab.id === "software" && updateCount > 0 ? updateCount : 0;
              return (
                <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => handleTabChange(tab.id)} className={`relative whitespace-nowrap px-3 py-2.5 text-xs font-medium transition ${activeTab === tab.id ? "text-blue-600" : "text-muted-foreground hover:text-foreground"}`}>
                  <span className="inline-flex items-center gap-1.5">
                    {tab.label}
                    {badge > 0 && <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold text-white">{badge}</span>}
                  </span>
                  {activeTab === tab.id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-blue-600" />}
                </button>
              );
            })}
          </div>
        </header>

        <div className="min-h-0 overflow-y-auto p-4 lg:p-5 scrollbar-hover">
          <div className="mx-auto w-full max-w-[1160px]">
            {softwareMounted && (
              <div className={activeTab === "software" ? "" : "hidden"}>
                <SoftwarePanel onHandoff={setHandoffTask} />
              </div>
            )}
            {activeTab === "storage" ? <StoragePanel scan={storageScan} onHandoff={setHandoffTask} onAnalyze={(goal) => setAnalysisRequest({ goal, nonce: Date.now() })} /> : ActivePanel}
          </div>
        </div>
      </div>

      <SystemAssistant
        tab={activeTab}
        requestId={0}
        handoffTask={handoffTask}
        onHandoffTaskHandled={(taskId) => setHandoffTask((current) => current?.id === taskId ? null : current)}
        storage={{ result: storageScan.result, clean: storageScan.clean }}
        onNavigate={setActiveTab}
        collapsed={assistantCollapsed}
        onCollapse={collapseAssistant}
        analysisRequest={analysisRequest}
      />
    </section>
  );
}
