import { useEffect, useRef, useState } from "react";
import {
  Inbox,
  PenSquare,
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Sparkles,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getGatewayHttpBase } from "@/lib/api";
import { useEmailStore } from "./store/emailStore";
import { FolderTree } from "./FolderTree";
import { MailListView } from "./MailListView";
import { MailView } from "./MailView";
import { MailAgentPanel } from "./MailAgentPanel";
import { ContactsView } from "./contacts/ContactsView";
import { openComposeWindow } from "./lib/emailApi";
import type { EmailAccount, EmailMessage } from "./lib/types";

const LIST_WIDTH_KEY = "mona:email:listWidth";
const MIN_LIST_WIDTH = 240;
const MAX_LIST_WIDTH = 600;
const FOLDER_TREE_WIDTH = 180;

export function EmailClientView() {
  const loadAccounts = useEmailStore((s) => s.loadAccounts);
  const selectedAccountId = useEmailStore((s) => s.selectedAccountId);
  const selectedMessage = useEmailStore((s) => s.selectedMessage);
  const loadMessages = useEmailStore((s) => s.loadMessages);
  const syncMail = useEmailStore((s) => s.syncMail);
  const deleteMessage = useEmailStore((s) => s.deleteMessage);
  const syncing = useEmailStore((s) => s.syncing);
  const setStoreGatewayUrl = useEmailStore((s) => s.setGatewayUrl);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [agentPanelVisible, setAgentPanelVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState<"mail" | "contacts">("mail");
  const [listWidth, setListWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(LIST_WIDTH_KEY));
      return Number.isFinite(saved) ? Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, saved)) : 300;
    } catch {
      return 300;
    }
  });
  const [resizing, setResizing] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadAccounts();
    void getGatewayHttpBase().then((url) => {
      setGatewayUrl(url);
      setStoreGatewayUrl(url);
    });
  }, [loadAccounts]);

  useEffect(() => {
    if (selectedAccountId) {
      void loadMessages(selectedAccountId);
    }
  }, [selectedAccountId, loadMessages]);

  // 邮件列表与正文之间的拖动调整
  useEffect(() => {
    if (!resizing) return;
    document.body.style.cursor = "col-resize";
    const handleMove = (e: MouseEvent) => {
      if (!mainRef.current) return;
      const rect = mainRef.current.getBoundingClientRect();
      const nextWidth = e.clientX - rect.left - FOLDER_TREE_WIDTH;
      setListWidth(Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, nextWidth)));
    };
    const handleUp = () => {
      setResizing(false);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [resizing]);

  useEffect(() => {
    try {
      localStorage.setItem(LIST_WIDTH_KEY, String(listWidth));
    } catch {
      // ignore
    }
  }, [listWidth]);

  const getCurrentAccount = (): EmailAccount | null => {
    const accounts = useEmailStore.getState().accounts;
    return accounts.find((a) => a.id === selectedAccountId) ?? null;
  };

  const openCompose = () => {
    const account = getCurrentAccount();
    if (!account) return;
    void openComposeWindow({ mode: "compose", accountId: account.id });
  };

  const openReply = (message: EmailMessage, mode: "reply" | "replyAll") => {
    const account = getCurrentAccount();
    if (!account) return;
    void openComposeWindow({ mode, accountId: account.id, baseMessage: message });
  };

  const openForward = (message: EmailMessage) => {
    const account = getCurrentAccount();
    if (!account) return;
    void openComposeWindow({ mode: "forward", accountId: account.id, baseMessage: message });
  };

  const handleDelete = async () => {
    if (!selectedMessage || !gatewayUrl) return;
    setDeleting(true);
    try {
      await deleteMessage(gatewayUrl, selectedMessage);
    } finally {
      setDeleting(false);
    }
  };

  const hasSelection = !!selectedMessage;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Foxmail 风格工具栏 */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b-2 border-border bg-muted/30 px-2">
        <ToolbarButton
          icon={Inbox}
          label="收取"
          variant="primary"
          disabled={!selectedAccountId || syncing || !gatewayUrl}
          onClick={() => void syncMail(gatewayUrl)}
          loading={syncing}
        />
        <ToolbarButton
          icon={PenSquare}
          label="写邮件"
          disabled={!selectedAccountId}
          onClick={openCompose}
        />
        <ToolbarDivider />
        <ToolbarButton
          icon={Reply}
          label="回复"
          disabled={!hasSelection}
          onClick={() => selectedMessage && openReply(selectedMessage, "reply")}
        />
        <ToolbarButton
          icon={ReplyAll}
          label="回复全部"
          disabled={!hasSelection}
          onClick={() => selectedMessage && openReply(selectedMessage, "replyAll")}
        />
        <ToolbarButton
          icon={Forward}
          label="转发"
          disabled={!hasSelection}
          onClick={() => selectedMessage && openForward(selectedMessage)}
        />
        <ToolbarDivider />
        <ToolbarButton
          icon={Trash2}
          label="删除"
          disabled={!hasSelection || deleting}
          onClick={handleDelete}
          loading={deleting}
        />
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 w-8 p-0",
            agentPanelVisible ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setAgentPanelVisible((v) => !v)}
          aria-label={agentPanelVisible ? "隐藏 AI 面板" : "显示 AI 面板"}
          title={agentPanelVisible ? "隐藏 AI 面板" : "显示 AI 面板"}
        >
          <Sparkles className={cn("h-3.5 w-3.5", !agentPanelVisible && "opacity-60")} />
        </Button>
      </div>

      <div ref={mainRef} className="flex min-h-0 flex-1">
        <div style={{ width: FOLDER_TREE_WIDTH }} className="shrink-0">
          <FolderTree
            gatewayUrl={gatewayUrl}
            view={view}
            onViewChange={setView}
          />
        </div>
        {view === "contacts" ? (
          <div className="min-w-0 flex-1 border-l border-border bg-background">
            <ContactsView gatewayUrl={gatewayUrl} />
          </div>
        ) : (
          <>
            <div style={{ width: listWidth }} className="shrink-0 border-l border-border bg-background">
              <MailListView
                onReply={(m) => openReply(m, "reply")}
                onReplyAll={(m) => openReply(m, "replyAll")}
                onForward={(m) => openForward(m)}
              />
            </div>
            <div
              className={cn(
                "w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40 active:bg-primary/60",
                resizing && "bg-primary/60",
              )}
              onMouseDown={() => setResizing(true)}
              title="拖动调整宽度"
            />
            <div className="min-w-0 flex-1 bg-background">
              <MailView />
            </div>
            {agentPanelVisible && (
              <div className="w-[320px] shrink-0 border-l border-border bg-muted/20">
                <MailAgentPanel />
              </div>
            )}
          </>
        )}
      </div>

    </div>
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  disabled,
  onClick,
  loading,
  variant = "default",
}: {
  icon: React.ElementType;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  loading?: boolean;
  variant?: "default" | "primary";
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled || loading}
      onClick={onClick}
      className={cn(
        "h-8 gap-1.5 px-2.5 text-[12px]",
        variant === "primary"
          ? "text-blue-600 hover:bg-blue-500/10 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          : "text-muted-foreground hover:text-foreground",
        disabled && "opacity-50 hover:bg-transparent hover:text-muted-foreground",
      )}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Icon className="h-3.5 w-3.5" />
      )}
      {label}
    </Button>
  );
}

function ToolbarDivider() {
  return <div className="mx-1 h-4 w-px bg-border" />;
}
