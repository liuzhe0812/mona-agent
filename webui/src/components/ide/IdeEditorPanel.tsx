import { X, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IdeEditor } from "./IdeEditor";
import { useIdeStore } from "./useIdeStore";

export function IdeEditorPanel() {
  const tabs = useIdeStore((s) => s.tabs);
  const activeTabId = useIdeStore((s) => s.activeTabId);
  const setActiveTab = useIdeStore((s) => s.setActiveTab);
  const closeTab = useIdeStore((s) => s.closeTab);
  const setTabContent = useIdeStore((s) => s.setTabContent);
  const hideIdePanel = useIdeStore((s) => s.hideIdePanel);
  const saveFile = useIdeStore((s) => s.saveFile);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  const handleCloseTab = (tabId: string) => {
    const tab = useIdeStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.isDirty) {
      const ok = confirm(`文件 "${tab.name}" 有未保存修改，确认关闭？`);
      if (!ok) return;
      setTabContent(tabId, tab.originalContent);
    }
    closeTab(tabId);
  };

  const handleSave = () => {
    if (!activeTabId) return;
    saveFile(activeTabId).catch(console.error);
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Tab bar */}
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-muted/40 px-1">
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`group relative flex h-6 max-w-[160px] shrink-0 items-center gap-1 pl-2.5 pr-1 text-xs transition-colors ${
                  index > 0 ? "border-l border-border" : ""
                } ${
                  isActive
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                {isActive && (
                  <span
                    className="absolute bottom-0 left-0 right-0 h-0.5"
                    style={{ backgroundColor: "hsl(var(--theme))" }}
                  />
                )}
                <span className="truncate">{tab.name}</span>
                {tab.isDirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />}
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseTab(tab.id);
                  }}
                  className="ml-1 shrink-0 rounded p-0.5 hover:bg-accent"
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 ml-1">
          {activeTab?.isDirty && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              onClick={handleSave}
              title="保存 (Ctrl+S)"
            >
              <Save className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={hideIdePanel}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Editor */}
      <div className="relative flex-1 overflow-hidden">
        {activeTab ? (
          <IdeEditor
            key={activeTab.id}
            content={activeTab.content}
            language={activeTab.language}
            onChange={(value) => setTabContent(activeTab.id, value)}
            onSave={handleSave}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            选择一个文件开始编辑
          </div>
        )}
      </div>
    </div>
  );
}
