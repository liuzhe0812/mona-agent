import { useCallback, useEffect } from "react";
import { FileText, FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isTauri } from "@/lib/tauri";

import { MdFileEditor } from "./MdFileEditor";
import { MdReaderTabs } from "./MdReaderTabs";
import { useMdReaderStore } from "./mdReaderStore";
import { useFileOpen } from "./useFileOpen";

interface MdReaderViewProps {
  onBack?: () => void;
}

export function MdReaderView({ onBack }: MdReaderViewProps) {
  const tabs = useMdReaderStore((s) => s.tabs);
  const activeTabId = useMdReaderStore((s) => s.activeTabId);
  const setActiveTab = useMdReaderStore((s) => s.setActiveTab);
  const closeTab = useMdReaderStore((s) => s.closeTab);
  const updateTabContent = useMdReaderStore((s) => s.updateTabContent);
  const updateTabMode = useMdReaderStore((s) => s.updateTabMode);
  const saveActiveTab = useMdReaderStore((s) => s.saveActiveTab);
  const openFile = useMdReaderStore((s) => s.openFile);

  useFileOpen();

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveActiveTab().catch((err) => {
          console.error("Save failed:", err);
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saveActiveTab]);

  const handleOpenFile = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Markdown",
            extensions: ["md", "markdown", "mdx"],
          },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const p of paths) {
        await openFile(p);
      }
    } catch (err) {
      console.error("Failed to open file dialog:", err);
    }
  }, [openFile]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.dirty) {
        const confirmed = window.confirm(
          `"${tab.fileName}" 有未保存的更改，确定关闭吗？`,
        );
        if (!confirmed) return;
      }
      closeTab(tabId);
    },
    [tabs, closeTab],
  );

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-background">
        <FileText className="h-12 w-12 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">打开 Markdown 文件开始阅读或编辑</p>
        <Button variant="outline" onClick={handleOpenFile}>
          <FolderOpen className="mr-2 h-4 w-4" />
          打开文件
        </Button>
        {onBack ? (
          <Button variant="ghost" size="sm" onClick={onBack}>
            返回主界面
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <MdReaderTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={setActiveTab}
        onClose={handleCloseTab}
        onOpenFile={handleOpenFile}
      />
      {activeTab ? (
        <MdFileEditor
          key={activeTab.id}
          tab={activeTab}
          onContentChange={(content) => updateTabContent(activeTab.id, content)}
          onModeChange={(mode) => updateTabMode(activeTab.id, mode)}
        />
      ) : null}
    </div>
  );
}
