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

type DocTab = "doc" | "ppt" | "video";

// 文档加工（doc）tab 暂隐藏：内嵌 Office 协作编辑体验未达预期，
// 待引入 OnlyOffice/Univer 后恢复。TABS 里保留条目仅为类型兼容，
// 实际不渲染。
const VISIBLE_TABS: Array<{ key: DocTab; label: string }> = [
  { key: "ppt", label: "PPT" },
  { key: "video", label: "视频" },
];

const STORAGE_KEY = "mona.doc.activeTab";

function loadActiveTab(): DocTab {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "ppt" || v === "video") return v;
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
  useEffect(() => {
    if (activeTab === "ppt") setPptMounted(true);
    if (activeTab === "video") setVideoMounted(true);
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
            variant="ghost"
            size="sm"
            className={cn(
              "relative h-7 rounded-none px-3 text-caption",
              activeTab === tab.key
                ? "text-foreground"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
            {activeTab === tab.key && (
              <span
                aria-hidden="true"
                className="absolute inset-x-2 bottom-0 h-0.5 bg-[hsl(var(--brand-red))]"
              />
            )}
          </Button>
        ))}
      </div>

      {/* tab 内容区：已挂载的视图保持挂载，切换 tab 时仅隐藏 */}
      <div className="relative isolate flex-1 overflow-hidden">
        {pptMounted && (
          <div className={cn("absolute inset-0 flex flex-col bg-background", activeTab !== "ppt" && "invisible pointer-events-none")}>
            <Suspense fallback={<div className="flex h-full items-center justify-center text-body text-muted-foreground">正在打开 PPT 制作...</div>}>
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
      </div>
    </div>
  );
}
