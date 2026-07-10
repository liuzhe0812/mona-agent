import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";

const PptMakerView = lazy(() =>
  import("@/components/ppt/PptMakerView").then((m) => ({ default: m.PptMakerView })),
);

const VideoMakerView = lazy(() =>
  import("@/components/doc/video/VideoMakerView").then((m) => ({ default: m.VideoMakerView })),
);

const FlowchartMakerView = lazy(() =>
  import("@/components/doc/flowchart/FlowchartMakerView").then((m) => ({ default: m.FlowchartMakerView })),
);

type DocTab = "ppt" | "video" | "flowchart";

const TABS: Array<{ key: DocTab; label: string }> = [
  { key: "ppt", label: "PPT" },
  { key: "video", label: "视频" },
  { key: "flowchart", label: "流程图" },
];

const STORAGE_KEY = "mona.doc.activeTab";

function loadActiveTab(): DocTab {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "ppt" || v === "video" || v === "flowchart") return v;
  } catch {
    // ignore
  }
  return "ppt";
}

export function DocMakerView({ onBack }: { onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<DocTab>(loadActiveTab);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, activeTab);
    } catch {
      // ignore
    }
  }, [activeTab]);

  return (
    <div className="flex h-full flex-col">
      {/* 顶部 tab 栏 */}
      <div className="flex h-10 items-center gap-1 border-b border-border/40 px-3">
        {TABS.map((tab) => (
          <Button
            key={tab.key}
            variant={activeTab === tab.key ? "secondary" : "ghost"}
            size="sm"
            className="h-7 rounded-full px-3 text-[13px]"
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </Button>
        ))}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" className="rounded-full" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          返回对话
        </Button>
      </div>

      {/* tab 内容区 */}
      <div className="relative flex-1 overflow-hidden">
        {activeTab === "ppt" && (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在打开 PPT 制作...</div>}>
            <PptMakerView onBack={onBack} />
          </Suspense>
        )}
        {activeTab === "video" && (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在打开视频制作...</div>}>
            <VideoMakerView onBack={onBack} />
          </Suspense>
        )}
        {activeTab === "flowchart" && (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在打开流程图制作...</div>}>
            <FlowchartMakerView onBack={onBack} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
