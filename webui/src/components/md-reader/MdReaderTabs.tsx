import { FileText, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";

import type { MdFileTab } from "./mdReaderStore";

interface MdReaderTabsProps {
  tabs: MdFileTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onOpenFile: () => void;
}

export function MdReaderTabs({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onOpenFile,
}: MdReaderTabsProps) {
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border/75 bg-sidebar/95">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden scrollbar-thin">
        {tabs.map((tab) => (
          <MdTabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onSelect={() => onSelect(tab.id)}
            onClose={() => onClose(tab.id)}
          />
        ))}
        <button
          type="button"
          aria-label="打开文件"
          title="打开 Markdown 文件"
          onClick={onOpenFile}
          className="flex h-9 w-9 shrink-0 items-center justify-center border-r border-border/70 text-muted-foreground transition-colors hover:bg-sidebar-accent/75 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function MdTabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: MdFileTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex h-9 min-w-0 shrink-0 items-center border-r border-border/70 text-[12.5px] font-medium transition-colors w-[152px]",
        active
          ? "bg-background text-foreground shadow-[inset_0_1px_0_hsl(var(--background))]"
          : "bg-sidebar/80 text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left"
      >
        <FileText
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active && "text-[#eba45d]",
          )}
        />
        <span className="min-w-0 truncate">
          {tab.dirty ? `${tab.fileName} ●` : tab.fileName}
        </span>
      </button>
      <button
        type="button"
        aria-label={`关闭 ${tab.fileName}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="mr-2 grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground/55 opacity-70 transition-colors hover:bg-foreground/8 hover:text-foreground group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
