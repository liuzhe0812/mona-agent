import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Inbox,
  Search,
  Star,
  ArrowDownUp,
  Check,
  Trash2,
  MailOpen,
  Reply,
  ReplyAll,
  Forward,
  FolderInput,
  Sparkles,
  Paperclip,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useEmailStore } from "./store/emailStore";
import { getFolderDisplayName, sortFolders } from "./lib/folderUtils";
import { moveMessage } from "./lib/emailApi";
import type { EmailMessage } from "./lib/types";

type SortKey = "date" | "from" | "subject" | "size" | "starred";
type FilterKey = "all" | "unread" | "starred" | "attachments";

const SORT_LABELS: Record<SortKey, string> = {
  date: "日期",
  from: "发件人",
  subject: "主题",
  size: "大小",
  starred: "星标",
};

const FILTER_LABELS: Record<FilterKey, string> = {
  all: "全部",
  unread: "未读",
  starred: "星标",
  attachments: "附件",
};

interface MailListViewProps {
  onReply?: (message: EmailMessage) => void;
  onReplyAll?: (message: EmailMessage) => void;
  onForward?: (message: EmailMessage) => void;
}

export function MailListView({ onReply, onReplyAll, onForward }: MailListViewProps) {
  const messages = useEmailStore((s) => s.messages);
  const selectedMessage = useEmailStore((s) => s.selectedMessage);
  const selectMessage = useEmailStore((s) => s.selectMessage);
  const loading = useEmailStore((s) => s.loading);
  const syncing = useEmailStore((s) => s.syncing);
  const error = useEmailStore((s) => s.error);
  const selectedAccountId = useEmailStore((s) => s.selectedAccountId);
  const selectedFolder = useEmailStore((s) => s.selectedFolder);
  const toggleRead = useEmailStore((s) => s.toggleRead);
  const toggleStarred = useEmailStore((s) => s.toggleStarred);
  const deleteMessage = useEmailStore((s) => s.deleteMessage);
  const loadMessages = useEmailStore((s) => s.loadMessages);
  const loadFolders = useEmailStore((s) => s.loadFolders);
  const folders = useEmailStore((s) => s.folders);
  const gatewayUrl = useEmailStore((s) => s.gatewayUrl);
  const runAnalysis = useEmailStore((s) => s.runAnalysis);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [filterKey, setFilterKey] = useState<FilterKey>("all");

  const handleAnalyze = async (message: EmailMessage) => {
    // 先选中该邮件，让 MailView 顶部卡片展示分析进度
    selectMessage(message);
    if (!gatewayUrl) return;
    try {
      await runAnalysis(gatewayUrl, message);
    } catch {
      // 错误已存入 store
    }
  };

  const filteredMessages = useMemo(() => {
    let result = messages;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (m) =>
          m.subject.toLowerCase().includes(q) ||
          m.fromAddress.toLowerCase().includes(q) ||
          (m.fromName ?? "").toLowerCase().includes(q) ||
          m.bodyText.toLowerCase().includes(q),
      );
    }
    if (filterKey !== "all") {
      result = result.filter((m) => {
        if (filterKey === "unread") return !m.isRead;
        if (filterKey === "starred") return m.isStarred;
        if (filterKey === "attachments") return m.hasAttachments;
        return true;
      });
    }
    const sorted = [...result];
    sorted.sort((a, b) => {
      if (a.isStarred !== b.isStarred) return a.isStarred ? -1 : 1;
      let cmp = 0;
      switch (sortKey) {
        case "date":
          cmp =
            (new Date(a.date).getTime() || 0) - (new Date(b.date).getTime() || 0);
          return -cmp;
        case "from":
          cmp = a.fromAddress.localeCompare(b.fromAddress);
          return cmp;
        case "subject":
          cmp = (a.subject || "").localeCompare(b.subject || "");
          return cmp;
        case "size":
          cmp = a.rawSize - b.rawSize;
          return -cmp;
        case "starred":
          return (
            (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0)
          );
        default:
          return 0;
      }
    });
    return sorted;
  }, [messages, searchQuery, filterKey, sortKey]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        const target = e.target as HTMLElement;
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
        if (selectedMessage && gatewayUrl) {
          e.preventDefault();
          void deleteMessage(gatewayUrl, selectedMessage);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedMessage, gatewayUrl, deleteMessage]);

  const handleMove = async (message: EmailMessage, destFolder: string) => {
    if (!gatewayUrl) return;
    const account = useEmailStore
      .getState()
      .accounts.find((a) => a.id === message.accountId);
    if (!account) return;
    try {
      await moveMessage(gatewayUrl, account, message.folder, destFolder, message.uid);
      if (message.folder === selectedFolder) {
        await loadMessages(account.id);
      }
      await loadFolders(gatewayUrl, account.id);
    } catch (e) {
      useEmailStore.setState({ error: String(e) });
    }
  };

  return (
    <div className="flex h-full flex-col bg-background" tabIndex={-1}>
      <div className="flex h-10 shrink-0 items-center border-b border-border bg-muted/20 px-3">
        <span className="text-[12px] font-semibold text-foreground">
          {getFolderDisplayName(selectedFolder)}
        </span>
        {syncing && (
          <span className="ml-2 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            收取中...
          </span>
        )}
        {!syncing && messages.length > 0 && (
          <span className="ml-2 text-[11px] text-muted-foreground">
            {filteredMessages.length}/{messages.length} 封
          </span>
        )}
      </div>
      <div className="shrink-0 space-y-1.5 border-b border-border bg-muted/10 px-2 py-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索邮件..."
            className="h-7 rounded-full pl-7 pr-3 text-[12px]"
          />
        </div>
        <div className="flex items-center gap-1">
          <div className="flex flex-1 items-center gap-0.5">
            {(Object.keys(FILTER_LABELS) as FilterKey[]).map((key) => (
              <Button
                key={key}
                type="button"
                variant={filterKey === key ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-2 text-[10.5px]"
                onClick={() => setFilterKey(key)}
              >
                {FILTER_LABELS[key]}
              </Button>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[10.5px]"
              >
                <ArrowDownUp className="h-3 w-3" />
                {SORT_LABELS[sortKey]}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[100px]">
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <DropdownMenuItem
                  key={key}
                  onClick={() => setSortKey(key)}
                  className="flex items-center justify-between gap-2 text-[12px]"
                >
                  {SORT_LABELS[key]}
                  {sortKey === key && <Check className="h-3 w-3" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {error && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-[11.5px] text-destructive">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!selectedAccountId ? (
          <EmptyHint text="请先选择账号" />
        ) : syncing && messages.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在收取邮件...
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            加载中...
          </div>
        ) : filteredMessages.length === 0 ? (
          <EmptyHint
            text={
              searchQuery || filterKey !== "all"
                ? "没有匹配的邮件"
                : "没有邮件，点击工具栏「收取」同步"
            }
            icon={<Inbox className="h-6 w-6 text-muted-foreground/50" />}
          />
        ) : (
          <div className="flex flex-col">
            {filteredMessages.map((message) => (
              <MailListItem
                key={message.uid}
                message={message}
                active={selectedMessage?.uid === message.uid}
                folders={folders}
                onClick={() => selectMessage(message)}
                onToggleRead={() => {
                  if (gatewayUrl) void toggleRead(gatewayUrl, message);
                }}
                onToggleStar={() => {
                  if (gatewayUrl) void toggleStarred(gatewayUrl, message);
                }}
                onDelete={() => {
                  if (gatewayUrl) void deleteMessage(gatewayUrl, message);
                }}
                onMove={(dest) => void handleMove(message, dest)}
                onReply={() => onReply?.(message)}
                onReplyAll={() => onReplyAll?.(message)}
                onForward={() => onForward?.(message)}
                onAnalyze={() => void handleAnalyze(message)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface MailListItemProps {
  message: EmailMessage;
  active: boolean;
  folders: { name: string; unreadCount?: number }[];
  onClick: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onDelete: () => void;
  onMove: (destFolder: string) => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onAnalyze: () => void;
}

function MailListItem({
  message,
  active,
  folders,
  onClick,
  onToggleRead,
  onToggleStar,
  onDelete,
  onMove,
  onReply,
  onReplyAll,
  onForward,
  onAnalyze,
}: MailListItemProps) {
  const moveTargets = sortFolders(
    folders.filter((f) => f.name !== message.folder),
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "flex cursor-pointer flex-col gap-0.5 border-b border-border/60 border-l-2 px-3 py-2 transition-colors",
            active
              ? "border-l-blue-500 bg-blue-500/10"
              : message.isRead
                ? "border-l-transparent hover:bg-accent/60"
                : "border-l-blue-400/60 hover:bg-accent/60",
          )}
          onClick={onClick}
        >
          <div className="flex items-center gap-2">
            {!message.isRead && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[12.5px]",
                message.isRead
                  ? "font-normal text-muted-foreground"
                  : "font-semibold text-foreground",
              )}
            >
              {message.fromName || message.fromAddress}
            </span>
            {message.isStarred && (
              <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
            )}
            {message.hasAttachments && (
              <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="shrink-0 text-[10.5px] text-muted-foreground">
              {formatDate(message.date)}
            </span>
          </div>
          <div
            className={cn(
              "truncate text-[12.5px]",
              message.isRead
                ? "font-normal text-muted-foreground"
                : "font-medium text-foreground",
            )}
          >
            {message.subject || "(无主题)"}
          </div>
          <div className="truncate text-[11.5px] text-muted-foreground/80">
            {message.bodyText.slice(0, 80) || "(无正文)"}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        <ContextMenuItem onClick={onReply} className="flex items-center gap-2 text-[12px]">
          <Reply className="h-3.5 w-3.5" />
          回复
          <span className="ml-auto text-[11px] text-muted-foreground">Ctrl+R</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={onReplyAll} className="flex items-center gap-2 text-[12px]">
          <ReplyAll className="h-3.5 w-3.5" />
          回复全部
          <span className="ml-auto text-[11px] text-muted-foreground">Ctrl+Shift+R</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={onForward} className="flex items-center gap-2 text-[12px]">
          <Forward className="h-3.5 w-3.5" />
          转发
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onAnalyze} className="flex items-center gap-2 text-[12px]">
          <Sparkles className="h-3.5 w-3.5" />
          AI 内容分析
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onToggleRead} className="flex items-center gap-2 text-[12px]">
          <MailOpen className="h-3.5 w-3.5" />
          {message.isRead ? "标为未读" : "标为已读"}
          <span className="ml-auto text-[11px] text-muted-foreground">Ctrl+U</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={onToggleStar} className="flex items-center gap-2 text-[12px]">
          <Star
            className={cn(
              "h-3.5 w-3.5",
              message.isStarred ? "fill-amber-400 text-amber-400" : "",
            )}
          />
          {message.isStarred ? "取消星标" : "星标邮件"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {moveTargets.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger className="flex items-center gap-2 text-[12px]">
              <FolderInput className="h-3.5 w-3.5" />
              移动到
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-[140px]">
              {moveTargets.map((folder) => (
                <ContextMenuItem
                  key={folder.name}
                  onClick={() => onMove(folder.name)}
                  className="flex items-center justify-between gap-2 text-[12px]"
                >
                  <span className="truncate">{getFolderDisplayName(folder.name)}</span>
                  {folder.unreadCount ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {folder.unreadCount}
                    </span>
                  ) : null}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuItem
          onClick={onDelete}
          className="flex items-center gap-2 text-[12px] text-destructive focus:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除
          <span className="ml-auto text-[11px] text-muted-foreground">Delete</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function EmptyHint({ text, icon }: { text: string; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      {icon ?? null}
      <p className="text-[12px] text-muted-foreground">{text}</p>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  } catch {
    return "";
  }
}
