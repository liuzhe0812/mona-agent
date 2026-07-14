import { CheckCircle2, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";

import sidebarSystemIcon from "@/assets/icons/sidebar-system.png";

import { MaintenancePanel } from "./MaintenancePanel";
import { OverviewPanel } from "./OverviewPanel";
import { SoftwarePanel } from "./SoftwarePanel";
import { StartupPanel } from "./StartupPanel";
import { StoragePanel } from "./StoragePanel";
import { SystemAssistant } from "./SystemAssistant";
import { primaryButtonClass, secondaryButtonClass } from "./SystemUi";
import { systemTabs, type SystemTab } from "./mockData";
import { useStorageScan } from "./useSystemData";

const PANELS: Record<Exclude<SystemTab, "storage">, () => JSX.Element> = {
  overview: OverviewPanel,
  software: SoftwarePanel,
  startup: StartupPanel,
  maintenance: MaintenancePanel,
};

export function SystemView({ initialTab = "overview" }: { initialTab?: SystemTab }) {
  const [activeTab, setActiveTab] = useState<SystemTab>(initialTab);
  const [softwareMounted, setSoftwareMounted] = useState(initialTab === "software");
  const [scanNotice, setScanNotice] = useState("");
  const [agentRequest, setAgentRequest] = useState(0);
  const storageScan = useStorageScan();
  const ActivePanel = activeTab === "storage" || activeTab === "software" ? null : PANELS[activeTab];

  const handleTabChange = (tab: SystemTab) => {
    setActiveTab(tab);
    if (tab === "software") setSoftwareMounted(true);
  };

  return (
    <section
      data-testid="system-layout"
      className="relative grid h-full min-h-0 overflow-hidden bg-background min-[1440px]:grid-cols-[minmax(0,1fr)_360px]"
    >
      <div className="flex min-h-0 min-w-0 flex-col">
        <header className="shrink-0 border-b border-border/70 bg-card/70 px-4 pt-4 lg:px-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 p-1.5 shadow-sm"><img src={sidebarSystemIcon} className="h-full w-full object-contain" alt="" draggable={false} /></span>
            <div className="min-w-0"><h1 className="text-xl font-semibold tracking-tight">系统</h1><p className="text-xs text-muted-foreground">查看电脑状态并安全维护</p></div>
            <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" />实时监控中</span>
              <button className={secondaryButtonClass} onClick={() => setScanNotice("数据已刷新") }><RefreshCw className="mr-1.5 h-3.5 w-3.5" />重新扫描</button>
              <button className={primaryButtonClass} onClick={() => setAgentRequest((value) => value + 1)}><Sparkles className="mr-1.5 h-3.5 w-3.5" />让 Mona 检查</button>
            </div>
          </div>
          {scanNotice && <p role="status" className="mt-2 text-right text-[11px] text-emerald-600">{scanNotice}</p>}
          <div role="tablist" aria-label="系统功能" className="mt-3 flex gap-1 overflow-x-auto scrollbar-none">
            {systemTabs.map((tab) => (
              <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => handleTabChange(tab.id)} className={`relative whitespace-nowrap px-3 py-2.5 text-xs font-medium transition ${activeTab === tab.id ? "text-blue-600" : "text-muted-foreground hover:text-foreground"}`}>
                {tab.label}
                {activeTab === tab.id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-blue-600" />}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 overflow-y-auto p-4 lg:p-5 scrollbar-hover">
          <div className="mx-auto w-full max-w-[1160px]">
            {softwareMounted && (
              <div className={activeTab === "software" ? "" : "hidden"}>
                <SoftwarePanel />
              </div>
            )}
            {activeTab === "storage" ? <StoragePanel scan={storageScan} /> : ActivePanel && <ActivePanel />}
          </div>
        </div>
      </div>

      <SystemAssistant
        tab={activeTab}
        requestId={agentRequest}
        storage={{ result: storageScan.result, clean: storageScan.clean }}
        onNavigate={setActiveTab}
      />
    </section>
  );
}
