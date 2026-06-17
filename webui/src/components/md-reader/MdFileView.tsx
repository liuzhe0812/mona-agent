import { useEffect } from "react";

import { MarkdownEditor } from "@/components/common/MarkdownEditor";
import { useMdReaderStore } from "./mdReaderStore";

interface MdFileViewProps {
  filePath: string;
}

export function MdFileView({ filePath }: MdFileViewProps) {
  const tabs = useMdReaderStore((s) => s.tabs);
  const openFile = useMdReaderStore((s) => s.openFile);
  const updateTabContent = useMdReaderStore((s) => s.updateTabContent);
  const updateTabMode = useMdReaderStore((s) => s.updateTabMode);
  const saveTab = useMdReaderStore((s) => s.saveTab);

  const normalized = filePath.replace(/\\/g, "/");
  const tab = tabs.find((t) => t.filePath.replace(/\\/g, "/") === normalized);

  useEffect(() => {
    if (!tab) {
      openFile(filePath);
    }
  }, [filePath, tab, openFile]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (tab) {
          saveTab(tab.id).catch((err) => {
            console.error("Save failed:", err);
          });
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tab, saveTab]);

  if (!tab) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        正在加载...
      </div>
    );
  }

  if (tab.loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        正在加载 {tab.fileName}...
      </div>
    );
  }

  if (tab.error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <p className="text-sm font-medium text-destructive">加载失败</p>
        <p className="text-[12px] text-muted-foreground">{tab.error}</p>
      </div>
    );
  }

  return (
    <MarkdownEditor
      content={tab.content}
      mode={tab.mode}
      onModeChange={(mode) => updateTabMode(tab.id, mode)}
      onContentChange={(next) => updateTabContent(tab.id, next.contentMarkdown)}
      placeholder="Markdown 文档内容..."
      showStats
      statsExtra={
        tab.dirty ? (
          <span className="text-[#eba45d]">未保存</span>
        ) : (
          <span>已保存</span>
        )
      }
      className="min-h-0 flex-1"
    />
  );
}
