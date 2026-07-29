import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  ClipboardList,
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
import { useEmailStore, resolveSenderDisplay } from "./store/emailStore";
import { getFolderDisplayName, sortFolders } from "./lib/folderUtils";
import { moveMessage, getAccountColor } from "./lib/emailApi";
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
  onAddToPlan?: (message: EmailMessage) => void;
}

export function MailListView({ onReply, onReplyAll, onForward, onAddToPlan }: MailListViewProps) {
  const messages = useEmailStore((s) => s.messages);
  const selectedMessage = useEmailStore((s) => s.selectedMessage);
  const selectMessage = useEmailStore((s) => s.selectMessage);
  const loading = useEmailStore((s) => s.loading);
  const error = useEmailStore((s) => s.error);
  const selectedAccountId = useEmailStore((s) => s.selectedAccountId);
  const selectedFolder = useEmailStore((s) => s.selectedFolder);
  const toggleRead = useEmailStore((s) => s.toggleRead);
  const toggleStarred = useEmailStore((s) => s.toggleStarred);
  const deleteMessage = useEmailStore((s) => s.deleteMessage);
  const folders = useEmailStore((s) => s.folders);
  const gatewayUrl = useEmailStore((s) => s.gatewayUrl);
  const runAnalysis = useEmailStore((s) => s.runAnalysis);
  const hasMore = useEmailStore((s) => s.hasMore);
  const loadingMore = useEmailStore((s) => s.loadingMore);
  const loadMore = useEmailStore((s) => s.loadMore);
  const isUnifiedInbox = useEmailStore((s) => s.isUnifiedInbox);
  const accounts = useEmailStore((s) => s.accounts);
  // 多选
  const selectedUids = useEmailStore((s) => s.selectedUids);
  const selectSingle = useEmailStore((s) => s.selectSingle);
  const toggleSelect = useEmailStore((s) => s.toggleSelect);
  const selectRange = useEmailStore((s) => s.selectRange);
  const batchOperate = useEmailStore((s) => s.batchOperate);
  const batchOperating = useEmailStore((s) => s.batchOperating);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [filterKey, setFilterKey] = useState<FilterKey>("all");

  const scrollRef = useRef<HTMLDivElement>(null);

  // 滚动接近底部时自动加载下一页（游标分页）
  // 仅当无搜索/过滤条件时触发（过滤后的子集不能正确反映分页状态）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => {
      if (!hasMore || loadingMore) return;
      // 距离底部 200px 内触发加载
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceToBottom < 200) {
        void loadMore();
      }
    };
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, [hasMore, loadingMore, loadMore]);

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
      // Offline-First：SQLite 不存正文，未打开过的邮件 bodyText 为空，因此本地搜索仅匹配标题/发件人。
      // 全文搜索走顶部工具栏的全局搜索（调用 email_search_messages 命令查询本地数据库索引）。
      result = result.filter(
        (m) =>
          m.subject.toLowerCase().includes(q) ||
          m.fromAddress.toLowerCase().includes(q) ||
          (m.fromName ?? "").toLowerCase().includes(q),
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

  const rowVirtualizer = useVirtualizer({
    count: filteredMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 8,
  });

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
        const { selectedUids, batchOperate } = useEmailStore.getState();
        // 多选模式：批量删除
        if (selectedUids.size > 1 && gatewayUrl) {
          e.preventDefault();
          void batchOperate(gatewayUrl, "delete");
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
    // 乐观更新：先从当前列表移除，UI 立即响应
    const prevMessages = useEmailStore.getState().messages;
    useEmailStore.setState((state) => ({
      messages: state.messages.filter(
        (m) => !(m.uid === message.uid && m.accountId === message.accountId),
      ),
      selectedMessage:
        state.selectedMessage?.uid === message.uid ? null : state.selectedMessage,
      error: null,
    }));
    try {
      await moveMessage(gatewayUrl, account, message.folder, destFolder, message.uid);
      // 后端成功后用本地数据库刷新未读数（不触发 IMAP 同步，避免转圈）
      await useEmailStore.getState().refreshUnreadCounts(account.id);
    } catch (e) {
      // 回滚
      useEmailStore.setState({ messages: prevMessages, error: String(e) });
    }
  };

  return (
    <div className="flex h-full flex-col bg-background" tabIndex={-1}>
      <div className="flex h-10 shrink-0 items-center border-b border-border bg-muted/20 px-3">
        <span className="text-[12px] font-semibold text-foreground">
          {isUnifiedInbox ? "全部收件箱" : getFolderDisplayName(selectedFolder)}
        </span>
        {messages.length > 0 && (
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-hover">
        {!selectedAccountId ? (
          <EmptyHint text="请先选择账号" />
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
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              position: "relative",
              width: "100%",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const message = filteredMessages[virtualRow.index];
              const msgKey = `${message.uid}:${message.accountId}`;
              const isSelected = selectedUids.has(msgKey);
              const isMultiSelectMode = selectedUids.size > 1;
              return (
                <div
                  key={message.uid}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <MailListItem
                    message={message}
                    active={selectedMessage?.uid === message.uid}
                    selected={isSelected}
                    multiSelectMode={isMultiSelectMode}
                    folders={folders}
                    onClick={(e) => {
                      if (e.shiftKey) {
                        selectRange(message, filteredMessages);
                      } else if (e.ctrlKey || e.metaKey) {
                        toggleSelect(message);
                      } else {
                        selectSingle(message);
                      }
                    }}
                    onToggleRead={() => {
                      if (isMultiSelectMode && isSelected) {
                        void batchOperate(gatewayUrl, "mark_read");
                      } else if (gatewayUrl) {
                        void toggleRead(gatewayUrl, message);
                      }
                    }}
                    onToggleStar={() => {
                      if (isMultiSelectMode && isSelected) {
                        void batchOperate(gatewayUrl, "star");
                      } else if (gatewayUrl) {
                        void toggleStarred(gatewayUrl, message);
                      }
                    }}
                    onDelete={() => {
                      if (isMultiSelectMode && isSelected) {
                        void batchOperate(gatewayUrl, "delete");
                      } else if (gatewayUrl) {
                        void deleteMessage(gatewayUrl, message);
                      }
                    }}
                    onMove={(dest) => {
                      if (isMultiSelectMode && isSelected) {
                        void batchOperate(gatewayUrl, "move", dest);
                      } else {
                        void handleMove(message, dest);
                      }
                    }}
                    onBatchMarkRead={() => void batchOperate(gatewayUrl, "mark_read")}
                    onBatchMarkUnread={() => void batchOperate(gatewayUrl, "mark_unread")}
                    onBatchStar={() => void batchOperate(gatewayUrl, "star")}
                    onBatchUnstar={() => void batchOperate(gatewayUrl, "unstar")}
                    onBatchDelete={() => void batchOperate(gatewayUrl, "delete")}
                    onBatchMove={(dest) => void batchOperate(gatewayUrl, "move", dest)}
                    batchOperating={batchOperating}
                    onReply={() => onReply?.(message)}
                    onReplyAll={() => onReplyAll?.(message)}
                    onForward={() => onForward?.(message)}
                    onAnalyze={() => void handleAnalyze(message)}
                    onAddToPlan={onAddToPlan ? () => onAddToPlan(message) : undefined}
                    accountColor={
                      isUnifiedInbox
                        ? getAccountColor(message.accountId, accounts)
                        : undefined
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
        {loadingMore && (
          <div className="flex items-center justify-center gap-2 py-3 text-[11.5px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            加载更多...
          </div>
        )}
      </div>
    </div>
  );
}

interface MailListItemProps {
  message: EmailMessage;
  active: boolean;
  selected: boolean;
  multiSelectMode: boolean;
  folders: { name: string; unreadCount?: number }[];
  onClick: (e: React.MouseEvent) => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onDelete: () => void;
  onMove: (destFolder: string) => void;
  onBatchMarkRead: () => void;
  onBatchMarkUnread: () => void;
  onBatchStar: () => void;
  onBatchUnstar: () => void;
  onBatchDelete: () => void;
  onBatchMove: (destFolder: string) => void;
  batchOperating: boolean;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onAnalyze: () => void;
  onAddToPlan?: () => void;
  // 统一收件箱模式下的账号颜色标识（为空表示非统一模式）
  accountColor?: string;
}

function MailListItem({
  message,
  active,
  selected,
  multiSelectMode,
  folders,
  onClick,
  onToggleRead,
  onToggleStar,
  onDelete,
  onMove,
  onBatchMarkRead,
  onBatchMarkUnread,
  onBatchStar,
  onBatchUnstar,
  onBatchDelete,
  onBatchMove,
  batchOperating,
  onReply,
  onReplyAll,
  onForward,
  onAnalyze,
  onAddToPlan,
  accountColor,
}: MailListItemProps) {
  const moveTargets = sortFolders(
    folders.filter((f) => f.name !== message.folder),
  );
  const contactsByEmail = useEmailStore((s) => s.contactsByEmail);
  const selectedUids = useEmailStore((s) => s.selectedUids);

  // 多选模式下，右键菜单显示批量操作；否则显示单邮件菜单
  const showBatchMenu = multiSelectMode && selected;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "flex cursor-pointer flex-col gap-0.5 border-b border-border/60 border-l-2 px-3 py-2 transition-colors",
            selected
              ? "border-l-blue-500 bg-blue-500/15"
              : active
                ? "border-l-blue-500 bg-blue-500/10"
                : message.isRead
                  ? "border-l-transparent hover:bg-accent"
                  : "border-l-blue-400/60 hover:bg-accent",
          )}
          onClick={onClick}
        >
          <div className="flex items-center gap-2">
            {multiSelectMode && (
              <span
                className={cn(
                  "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                  selected
                    ? "border-blue-500 bg-blue-500 text-white"
                    : "border-muted-foreground/40 bg-transparent",
                )}
              >
                {selected && <Check className="h-2.5 w-2.5" />}
              </span>
            )}
            {!message.isRead && !multiSelectMode && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />
            )}
            {accountColor && (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: accountColor }}
                title={message.accountId}
              />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[12.5px]",
                message.isRead
                  ? "font-normal text-muted-foreground"
                  : "font-semibold text-foreground",
              )}
            >
              {resolveSenderDisplay(message.fromName, message.fromAddress, contactsByEmail)}
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
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        {showBatchMenu ? (
          <>
            <div className="px-2 py-1 text-[11px] text-muted-foreground">
              已选中 {selectedUids.size} 封邮件
            </div>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={onBatchMarkRead}
              disabled={batchOperating}
              className="flex items-center gap-2 text-[12px]"
            >
              <MailOpen className="h-3.5 w-3.5" />
              标为已读
            </ContextMenuItem>
            <ContextMenuItem
              onClick={onBatchMarkUnread}
              disabled={batchOperating}
              className="flex items-center gap-2 text-[12px]"
            >
              <MailOpen className="h-3.5 w-3.5" />
              标为未读
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={onBatchStar}
              disabled={batchOperating}
              className="flex items-center gap-2 text-[12px]"
            >
              <Star className="h-3.5 w-3.5" />
              星标邮件
            </ContextMenuItem>
            <ContextMenuItem
              onClick={onBatchUnstar}
              disabled={batchOperating}
              className="flex items-center gap-2 text-[12px]"
            >
              <Star className="h-3.5 w-3.5" />
              取消星标
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
                      onClick={() => onBatchMove(folder.name)}
                      disabled={batchOperating}
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
              onClick={onBatchDelete}
              disabled={batchOperating}
              className="flex items-center gap-2 text-[12px] text-destructive focus:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </ContextMenuItem>
          </>
        ) : (
          <>
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
            {onAddToPlan && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={onAddToPlan} className="flex items-center gap-2 text-[12px]">
                  <ClipboardList className="h-3.5 w-3.5" />
                  加入计划
                </ContextMenuItem>
              </>
            )}
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
          </>
        )}
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
