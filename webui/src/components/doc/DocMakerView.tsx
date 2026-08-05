import { lazy, Suspense, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 文档加工 tab 暂隐藏，对应的 lazy import 一并注释。
// const OfficeWorkbenchView = lazy(() =>
//   import("@/components/doc/office/OfficeWorkbenchView").then((m) => ({ default: m.OfficeWorkbenchView })),
// );

const PptMakerView = lazy(() =>
  import("@/components/ppt/PptMakerView").then((m) => ({ default: m.PptMakerView })),
);

const VideoMakerView = lazy(() =>
  import("@/components/doc/video/VideoMakerView").then((m) => ({ default: m.VideoMakerView })),
);

const ThreeDMakerView = lazy(() =>
  import("@/components/doc/three/ThreeDMakerView").then((m) => ({ default: m.ThreeDMakerView })),
);

type DocTab = "doc" | "ppt" | "video" | "3d";

// 文档加工（doc）tab 暂隐藏：内嵌 Office 协作编辑体验未达预期，
// 待引入 OnlyOffice/Univer 后恢复。TABS 里保留条目仅为类型兼容，
// 实际不渲染。
const VISIBLE_TABS: Array<{ key: DocTab; label: string }> = [
  { key: "ppt", label: "PPT" },
  { key: "video", label: "视频" },
  { key: "3d", label: "3D" },
];

const STORAGE_KEY = "mona.doc.activeTab";

function loadActiveTab(): DocTab {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "ppt" || v === "video" || v === "3d") return v;
  } catch {
    // ignore
  }
  return "ppt";
}

export function DocMakerView() {
  const [activeTab, setActiveTab] = useState<DocTab>(loadActiveTab);

  // 首次进入对应 tab 后保持挂载，切换 tab 时仅隐藏，避免制作过程中断
  const [pptMounted, setPptMounted] = useState(activeTab === "ppt");
  const [videoMounted, setVideoMounted] = useState(activeTab === "video");
  const [threeMounted, setThreeMounted] = useState(activeTab === "3d");
  useEffect(() => {
    if (activeTab === "ppt") setPptMounted(true);
    if (activeTab === "video") setVideoMounted(true);
    if (activeTab === "3d") setThreeMounted(true);
  }, [activeTab]);

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
        {VISIBLE_TABS.map((tab) => (
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
      </div>

      {/* tab 内容区：已挂载的视图保持挂载，切换 tab 时仅隐藏 */}
      <div className="relative isolate flex-1 overflow-hidden">
        {pptMounted && (
          <div className={cn("absolute inset-0 flex flex-col bg-background", activeTab !== "ppt" && "invisible pointer-events-none")}>
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在打开 PPT 制作...</div>}>
              <PptMakerView />
            </Suspense>
          </div>
        )}
        {videoMounted && (
          <div className={cn("absolute inset-0 flex flex-col bg-background", activeTab !== "video" && "invisible pointer-events-none")}>
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在打开视频制作...</div>}>
              <VideoMakerView />
            </Suspense>
          </div>
        )}
        {threeMounted && (
          <div className={cn("absolute inset-0 flex flex-col bg-background", activeTab !== "3d" && "invisible pointer-events-none")}>
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在打开 3D 制作...</div>}>
              <ThreeDMakerView />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
