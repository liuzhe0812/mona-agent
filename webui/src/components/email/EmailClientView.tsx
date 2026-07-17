import { useEffect, useRef, useState } from "react";
import {
  Inbox,
  PenSquare,
  Reply,
  ReplyAll,
  Forward,
  Loader2,
  LockKeyhole,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentLogo } from "@/components/AgentLogo";
import { cn } from "@/lib/utils";
import { useLicense } from "@/hooks/useLicense";
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

export function EmailClientView({ onOpenSubscribe }: { onOpenSubscribe?: () => void }) {
  const { licenseActive } = useLicense();
  const loadAccounts = useEmailStore((s) => s.loadAccounts);
  const selectedAccountId = useEmailStore((s) => s.selectedAccountId);
  const selectedFolder = useEmailStore((s) => s.selectedFolder);
  const selectedMessage = useEmailStore((s) => s.selectedMessage);
  const messages = useEmailStore((s) => s.messages);
  const selectMessage = useEmailStore((s) => s.selectMessage);
  const toggleRead = useEmailStore((s) => s.toggleRead);
  const toggleStarred = useEmailStore((s) => s.toggleStarred);
  const loadMessages = useEmailStore((s) => s.loadMessages);
  const syncMail = useEmailStore((s) => s.syncMail);
  const syncAllAccounts = useEmailStore((s) => s.syncAllAccounts);
  const isUnifiedInbox = useEmailStore((s) => s.isUnifiedInbox);
  const syncing = useEmailStore((s) => s.syncing);
  const backgroundSyncing = useEmailStore((s) => s.backgroundSyncing);
  const isOnline = useEmailStore((s) => s.isOnline);
  const checkGatewayHealth = useEmailStore((s) => s.checkGatewayHealth);
  const setStoreGatewayUrl = useEmailStore((s) => s.setGatewayUrl);
  const loadContacts = useEmailStore((s) => s.loadContacts);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [agentPanelVisible, setAgentPanelVisible] = useState(false);
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
    void loadContacts();
    void getGatewayHttpBase().then((url) => {
      setGatewayUrl(url);
      setStoreGatewayUrl(url);
    });
  }, [loadAccounts, loadContacts]);

  // 离线模式：定期检测 gateway 健康状态（每 30 秒）
  useEffect(() => {
    if (!gatewayUrl) return;
    void checkGatewayHealth(gatewayUrl);
    const timer = window.setInterval(() => {
      void checkGatewayHealth(gatewayUrl);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [gatewayUrl, checkGatewayHealth]);

  // 定时处理 outbox 中到期的延迟发送邮件（每 60 秒检查一次，仅在线时执行）
  useEffect(() => {
    if (!gatewayUrl || !isOnline) return;
    const check = () => {
      import("./lib/emailApi").then(({ outboxProcess }) => {
        outboxProcess(gatewayUrl).catch(() => {
          // ignore
        });
      });
    };
    check(); // 启动时立即检查一次
    const timer = window.setInterval(check, 60_000);
    return () => window.clearInterval(timer);
  }, [gatewayUrl, isOnline]);

  useEffect(() => {
    if (selectedAccountId) {
      void loadMessages(selectedAccountId, selectedFolder);
    }
  }, [selectedAccountId, selectedFolder, loadMessages]);

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

  // 键盘快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 输入框/文本域/富文本聚焦时不触发导航快捷键
      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // Ctrl/Cmd+N: 新邮件（即使输入框聚焦也生效）
      if ((e.ctrlKey || e.metaKey) && e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        openCompose();
        return;
      }

      if (isInputFocused) return;

      // Ctrl/Cmd+R: 回复
      if ((e.ctrlKey || e.metaKey) && e.key === "r" && !e.shiftKey) {
        e.preventDefault();
        if (selectedMessage) openReply(selectedMessage, "reply");
        return;
      }
      // Ctrl/Cmd+Shift+R: 回复全部
      if ((e.ctrlKey || e.metaKey) && e.key === "R" && e.shiftKey) {
        e.preventDefault();
        if (selectedMessage) openReply(selectedMessage, "replyAll");
        return;
      }
      // Ctrl/Cmd+F: 转发
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        if (selectedMessage) openForward(selectedMessage);
        return;
      }
      // J / ↓: 下一封
      if ((e.key === "j" || e.key === "ArrowDown") && selectedMessage) {
        e.preventDefault();
        const idx = messages.findIndex((m) => m.uid === selectedMessage.uid);
        if (idx >= 0 && idx < messages.length - 1) {
          selectMessage(messages[idx + 1]);
        }
        return;
      }
      // K / ↑: 上一封
      if ((e.key === "k" || e.key === "ArrowUp") && selectedMessage) {
        e.preventDefault();
        const idx = messages.findIndex((m) => m.uid === selectedMessage.uid);
        if (idx > 0) {
          selectMessage(messages[idx - 1]);
        }
        return;
      }
      // S: 切换星标
      if (e.key === "s" && selectedMessage && gatewayUrl) {
        e.preventDefault();
        void toggleStarred(gatewayUrl, selectedMessage);
        return;
      }
      // R: 切换已读/未读（无 Ctrl 时）
      if (e.key === "r" && !e.ctrlKey && !e.metaKey && selectedMessage && gatewayUrl) {
        e.preventDefault();
        void toggleRead(gatewayUrl, selectedMessage);
        return;
      }
      // Esc: 多选时清空多选，否则取消选中
      if (e.key === "Escape") {
        e.preventDefault();
        const { selectedUids, clearSelection } = useEmailStore.getState();
        if (selectedUids.size > 1) {
          clearSelection();
        } else {
          selectMessage(null);
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedMessage, messages, gatewayUrl, selectMessage, toggleRead, toggleStarred]);

  const hasSelection = !!selectedMessage;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Foxmail 风格工具栏 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2">
        <ToolbarButton
          icon={Inbox}
          label="收取"
          variant="primary"
          disabled={(!selectedAccountId && !isUnifiedInbox) || syncing || backgroundSyncing || !gatewayUrl || !isOnline}
          onClick={() => {
            // 统一收件箱模式：同步所有账号；单账号模式：仅同步当前账号
            if (isUnifiedInbox) {
              void syncAllAccounts(gatewayUrl);
            } else {
              void syncMail(gatewayUrl);
            }
          }}
          loading={syncing || backgroundSyncing}
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
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 w-7 p-0",
            agentPanelVisible ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={licenseActive ? () => setAgentPanelVisible((v) => !v) : onOpenSubscribe}
          aria-label={licenseActive ? (agentPanelVisible ? "隐藏 AI 面板" : "显示 AI 面板") : "升级 Pro 解锁邮件 AI"}
          title={licenseActive ? (agentPanelVisible ? "隐藏 AI 面板" : "显示 AI 面板") : "升级 Pro 解锁邮件 AI"}
        >
          {licenseActive ? <AgentLogo state="idle" className="h-5 w-5" /> : <LockKeyhole className="h-4 w-4" />}
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
            {licenseActive && agentPanelVisible && (
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
        "h-7 gap-1.5 px-2.5 text-[12px]",
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
