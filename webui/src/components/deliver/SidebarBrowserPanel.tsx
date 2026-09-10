import { Globe2 } from "lucide-react";

import { BrowserTabView } from "@/components/browser/BrowserTabView";
import type { Tab } from "@/hooks/useBrowserTabs";
import type { ChatSummary } from "@/lib/types";

export interface SidebarBrowserController {
  tab: Tab | null;
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  updateUrl: (url: string) => void;
  openHistory?: () => void;
  openDownloads?: () => void;
  toggleMute?: () => void;
  toggleAdBlock?: () => void;
  toggleDarkMode?: () => void;
  openDevtools?: () => void;
}

export function SidebarBrowserPanel({
  session,
  visible,
  layoutVersion,
  controller,
}: {
  session: ChatSummary | null;
  visible: boolean;
  layoutVersion?: unknown;
  controller?: SidebarBrowserController;
}) {
  if (!controller?.tab) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-caption text-muted-foreground">
        <Globe2 className="h-7 w-7 opacity-35" />
        <span>正在打开浏览器…</span>
      </div>
    );
  }
  return (
    <BrowserTabView
      tab={controller.tab}
      isVisible={visible}
      layoutVersion={layoutVersion}
      session={session}
      onNavigate={controller.navigate}
      onGoBack={controller.goBack}
      onGoForward={controller.goForward}
      onReload={controller.reload}
      onUrlChange={controller.updateUrl}
      onOpenHistory={controller.openHistory}
      onOpenDownloads={controller.openDownloads}
      onToggleMute={controller.toggleMute}
      onToggleAdBlock={controller.toggleAdBlock}
      onToggleDarkMode={controller.toggleDarkMode}
      onOpenDevtools={controller.openDevtools}
    />
  );
}
