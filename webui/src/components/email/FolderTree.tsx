import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Mail,
  Trash2,
  Download,
  FolderPlus,
  BarChart3,
  Settings,
  MailCheck,
  Trash,
  Loader2,
  BookUser,
  Plus,
  Inbox,
  Send,
  FileText,
  Star,
  Folder,
  Pencil,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { useEmailStore } from "./store/emailStore";
import { EmailStatisticsDialog } from "./EmailStatisticsDialog";
import { NewFolderDialog } from "./NewFolderDialog";
import { AccountSettingsDialog } from "./AccountSettingsDialog";
import { NewAccountDialog } from "./NewAccountDialog";
import { getFolderDisplayName, isSentFolder } from "./lib/folderUtils";
import {
  deleteFolder,
  renameFolder,
} from "./lib/emailApi";
import type { EmailAccount } from "./lib/types";

import sidebarEmailIcon from "@/assets/icons/sidebar-email.png";

interface FolderTreeProps {
  gatewayUrl: string;
  view?: "mail" | "contacts";
  onViewChange?: (view: "mail" | "contacts") => void;
  onOpenEmailExtraction?: () => void;
}

function isJunkFolder(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("junk") || lower.includes("spam") || name.includes("垃圾");
}

function isSystemFolder(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "inbox" ||
    name.includes("收件箱") ||
    lower.includes("sent") ||
    lower.includes("outbox") ||
    name.includes("已发送") ||
    name.includes("已发邮件") ||
    name.includes("发件箱") ||
    lower.includes("draft") ||
    name.includes("草稿") ||
    lower.includes("trash") ||
    lower.includes("junk") ||
    lower.includes("deleted") ||
    name.includes("垃圾") ||
    name.includes("删除") ||
    lower.includes("star") ||
    lower.includes("flag")
  );
}

function isNoSelectFolder(flags: string): boolean {
  return flags.toLowerCase().split(/\s+/).includes("\\noselect");
}

function getFolderIcon(name: string): React.ComponentType<{ className?: string }> {
  const lower = name.toLowerCase();

  // 自定义文件夹统一使用文件夹样式图标
  if (!isSystemFolder(name)) {
    return Folder;
  }

  if (lower === "inbox" || name.includes("收件箱")) {
    return Inbox;
  }
  if (
    lower.includes("sent") ||
    lower.includes("outbox") ||
    name.includes("已发送") ||
    name.includes("已发邮件") ||
    name.includes("发件箱")
  ) {
    return Send;
  }
  if (lower.includes("draft") || name.includes("草稿")) {
    return FileText;
  }
  if (lower.includes("trash") || lower.includes("junk") || lower.includes("deleted") || name.includes("垃圾") || name.includes("删除")) {
    return Trash2;
  }
  if (lower.includes("star") || lower.includes("flag")) {
    return Star;
  }
  return Mail;
}

export function FolderTree({ gatewayUrl, view = "mail", onViewChange, onOpenEmailExtraction }: FolderTreeProps) {
  const accounts = useEmailStore((s) => s.accounts);
  const selectedAccountId = useEmailStore((s) => s.selectedAccountId);
  const foldersByAccount = useEmailStore((s) => s.foldersByAccount);
  const foldersLoading = useEmailStore((s) => s.foldersLoading);
  const foldersError = useEmailStore((s) => s.foldersError);
  const selectedFolder = useEmailStore((s) => s.selectedFolder);
  const isUnifiedInbox = useEmailStore((s) => s.isUnifiedInbox);
  const selectAccount = useEmailStore((s) => s.selectAccount);
  const selectFolder = useEmailStore((s) => s.selectFolder);
  const selectUnifiedInbox = useEmailStore((s) => s.selectUnifiedInbox);
  const loadFolders = useEmailStore((s) => s.loadFolders);
  const loadMessages = useEmailStore((s) => s.loadMessages);
  const reorderAccounts = useEmailStore((s) => s.reorderAccounts);
  const syncMail = useEmailStore((s) => s.syncMail);
  const markAllReadAction = useEmailStore((s) => s.markAllRead);
  const emptyFolderAction = useEmailStore((s) => s.emptyFolder);
  const removeAccount = useEmailStore((s) => s.removeAccount);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedFolderGroups, setCollapsedFolderGroups] = useState<Set<string>>(new Set());
  const [contextAccount, setContextAccount] = useState<EmailAccount | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newAccountOpen, setNewAccountOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const activeActionRef = useRef<string | null>(null);
  const [actionError, setActionError] = useState<{ title: string; message: string } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const actionLoading = activeAction !== null;

  const runAction = async (actionKey: string, action: () => Promise<void>) => {
    if (activeActionRef.current) return;
    activeActionRef.current = actionKey;
    setActiveAction(actionKey);
    try {
      await action();
    } finally {
      activeActionRef.current = null;
      setActiveAction(null);
    }
  };

  const showActionError = (action: string, error: unknown) => {
    console.error(`[email] ${action} failed`);
    const errorName = error instanceof Error ? error.name : "";
    const resultUnknown = ["EmailFolderMutationTimeoutError", "AbortError", "TypeError"].includes(errorName);
    const message = resultUnknown
      ? errorName === "EmailFolderMutationTimeoutError"
        ? `${action}等待超时，操作结果未确认。请刷新文件夹列表核对后再操作。`
        : `${action}结果未确认，请刷新后核对再操作。`
      : `${action}失败，请检查邮箱连接后重试。`;
    setActionError({ title: `${action}失败`, message });
  };

  const actionKey = (action: string, accountId: string, folderName = "") =>
    JSON.stringify([action, accountId, folderName]);

  const toggleFolderGroup = (accountId: string, folderName: string) => {
    const key = actionKey("folder-group", accountId, folderName);
    setCollapsedFolderGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 默认展开所有邮箱账号（仅在首次加载账号列表时触发一次）
  const autoExpandedRef = useRef(false);
  useEffect(() => {
    if (autoExpandedRef.current || accounts.length === 0) return;
    autoExpandedRef.current = true;
    setExpanded(new Set(accounts.map((a) => a.id)));
  }, [accounts]);

  // 账号和 gateway 就绪后，自动加载所有账号的文件夹（从本地缓存，不阻塞 UI）
  useEffect(() => {
    if (!gatewayUrl || accounts.length === 0) return;
    for (const account of accounts) {
      void loadFolders(gatewayUrl, account.id);
    }
  }, [accounts, gatewayUrl, loadFolders]);

  const handleAccountClick = async (accountId: string) => {
    const isCurrentlyExpanded = expanded.has(accountId);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
    // 展开时选中账号并立即显示本地缓存，后台同步 IMAP 最新列表
    if (!isCurrentlyExpanded) {
      selectAccount(accountId);
      void loadFolders(gatewayUrl, accountId);
      void loadMessages(accountId, "INBOX");
    }
  };

  const handleFolderClick = (accountId: string, folderName: string) => {
    // 显式切换到被点击的账号，避免 selectedAccountId 仍是旧账号
    if (accountId !== selectedAccountId) {
      selectAccount(accountId);
    }
    selectFolder(folderName);
    // loadMessages 由 EmailClientView 的 useEffect 监听 selectedFolder 变化统一触发，
    // 这里不再手动调用，避免双重 loadMessages 导致空文件夹触发两次 syncEmail 争抢锁
  };

  const handleMarkAllRead = async (accountId: string, folderName: string) => {
    await runAction(actionKey("mark-all-read", accountId, folderName), async () => {
      try {
        await markAllReadAction(gatewayUrl, accountId, folderName);
      } catch (e) {
        showActionError("全部标为已读", e);
      }
    });
  };

  const handleEmptyFolder = async (accountId: string, folderName: string) => {
    if (!window.confirm(`确定要清空「${getFolderDisplayName(folderName)}」中的所有邮件吗？此操作不可恢复。`)) return;
    await runAction(actionKey("empty-folder", accountId, folderName), async () => {
      try {
        await emptyFolderAction(gatewayUrl, accountId, folderName);
      } catch (e) {
        showActionError("清空文件夹", e);
      }
    });
  };

  const handleStartRename = (folderName: string) => {
    setRenamingFolder(folderName);
    setRenameValue(folderName);
  };

  const handleRenameCancel = () => {
    setRenamingFolder(null);
    setRenameValue("");
  };

  const handleRenameSubmit = async (account: EmailAccount, oldName: string) => {
    const newName = renameValue.trim();
    if (!newName || newName === oldName) {
      handleRenameCancel();
      return;
    }
    await runAction(actionKey("rename-folder", account.id, oldName), async () => {
      try {
        await renameFolder(gatewayUrl, account, oldName, newName);
        setRenamingFolder(null);
        setRenameValue("");
        await loadFolders(gatewayUrl, account.id);
      } catch (e) {
        showActionError("重命名文件夹", e);
      }
    });
  };

  const handleDeleteFolder = async (account: EmailAccount, folderName: string) => {
    if (!window.confirm(`确定要删除文件夹「${getFolderDisplayName(folderName)}」吗？其中的邮件也会被删除，此操作不可恢复。`)) return;
    await runAction(actionKey("delete-folder", account.id, folderName), async () => {
      try {
        await deleteFolder(gatewayUrl, account, folderName);
        await loadFolders(gatewayUrl, account.id);
      } catch (e) {
        showActionError("删除文件夹", e);
      }
    });
  };

  const handleMoveAccount = async (accountId: string, direction: -1 | 1) => {
    const index = accounts.findIndex((account) => account.id === accountId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= accounts.length) return;
    const next = [...accounts];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    await runAction(actionKey("reorder-account", accountId), async () => {
      try {
        await reorderAccounts(next.map((account) => account.id));
      } catch (e) {
        showActionError("调整邮箱顺序", e);
      }
    });
  };

  const handleSyncAccount = async (accountId: string) => {
    await runAction(actionKey("sync-account", accountId), async () => {
      try {
        selectAccount(accountId);
        await syncMail(gatewayUrl);
      } catch (e) {
        showActionError("收取邮件", e);
      }
    });
  };

  const handleRemoveAccount = async (account: EmailAccount) => {
    if (!window.confirm(`确定要删除邮箱「${account.displayName}」吗？本地缓存的邮件也会被清除。`)) return;
    await runAction(actionKey("remove-account", account.id), async () => {
      try {
        await removeAccount(account.id);
      } catch (e) {
        showActionError("删除邮箱", e);
      }
    });
  };

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-card px-3">
        <span className="text-caption font-semibold text-foreground">邮箱</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 w-5 p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
          disabled={actionLoading}
          onClick={() => setNewAccountOpen(true)}
          aria-label="添加邮箱"
          title="添加邮箱"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-hover">
        {accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-8 text-center">
            <Mail className="h-6 w-6 text-muted-foreground/50" />
            <p className="text-caption text-muted-foreground">
              还没有邮箱账号
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1 rounded-full px-2.5 text-caption text-muted-foreground"
              disabled={actionLoading}
              onClick={() => setNewAccountOpen(true)}
            >
              <Plus className="h-3 w-3" />
              添加邮箱
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {/* 统一收件箱：聚合所有账号 INBOX，按日期降序，账号颜色标识 */}
            <div
              className={cn(
                "group flex items-center gap-1.5 rounded-md px-1.5 py-1.5 cursor-pointer",
                isUnifiedInbox
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              onClick={() => void selectUnifiedInbox()}
              title="聚合所有账号收件箱"
            >
              <Inbox className="h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-caption font-medium">
                  全部收件箱
                </div>
              </div>
              {accounts.length > 1 && (
                <div className="flex shrink-0 items-center gap-0.5">
                  {accounts.slice(0, 4).map((a, idx) => (
                    <span
                      key={a.id}
                      className="h-1.5 w-1.5 rounded-full"
                      style={{
                        backgroundColor: [
                          "#3b82f6", "#10b981", "#f59e0b", "#ef4444",
                          "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
                        ][idx % 8],
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="mx-1.5 my-0.5 border-t border-border/50" />
            {accounts.map((account, accountIndex) => {
              const isExpanded = expanded.has(account.id);
              const isSelected = account.id === selectedAccountId;
              const Chevron = isExpanded ? ChevronDown : ChevronRight;
              const accountFolders = foldersByAccount[account.id] ?? [];
              const folderIsHidden = (folder: (typeof accountFolders)[number]) =>
                accountFolders.some((parent) => {
                  if (
                    !parent.hasChildren ||
                    !isNoSelectFolder(parent.flags) ||
                    !parent.delimiter ||
                    !collapsedFolderGroups.has(actionKey("folder-group", account.id, parent.name))
                  ) {
                    return false;
                  }
                  return folder.name !== parent.name &&
                    folder.name.startsWith(`${parent.name}${parent.delimiter}`);
                });
              return (
                <div key={account.id} className="flex flex-col">
                  <ContextMenu
                    onOpenChange={(open) => {
                      if (open) setContextAccount(account);
                    }}
                  >
                    <ContextMenuTrigger asChild>
                      <div
                        className={cn(
                          "group flex items-center gap-1.5 rounded-md px-1.5 py-1.5 cursor-pointer",
                          "text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                        onClick={() => handleAccountClick(account.id)}
                      >
                        <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <img src={sidebarEmailIcon} className="h-3.5 w-3.5 shrink-0 object-contain" alt="" draggable={false} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-caption font-medium">
                            {account.displayName}
                          </div>
                        </div>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-40">
                      <ContextMenuItem
                        className="text-caption"
                        disabled={actionLoading || !gatewayUrl}
                        onClick={() => void handleSyncAccount(account.id)}
                      >
                        {activeAction === actionKey("sync-account", account.id) ? (
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="mr-2 h-3.5 w-3.5" />
                        )}
                        收取
                      </ContextMenuItem>
                      <ContextMenuItem
                        className="text-caption"
                        disabled={actionLoading || accountIndex === 0}
                        onClick={() => void handleMoveAccount(account.id, -1)}
                      >
                        <ArrowUp className="mr-2 h-3.5 w-3.5" />
                        上移
                      </ContextMenuItem>
                      <ContextMenuItem
                        className="text-caption"
                        disabled={actionLoading || accountIndex === accounts.length - 1}
                        onClick={() => void handleMoveAccount(account.id, 1)}
                      >
                        <ArrowDown className="mr-2 h-3.5 w-3.5" />
                        下移
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        className="text-caption"
                        disabled={actionLoading || !gatewayUrl}
                        onClick={() => {
                          setContextAccount(account);
                          selectAccount(account.id);
                          setNewFolderOpen(true);
                        }}
                      >
                        <FolderPlus className="mr-2 h-3.5 w-3.5" />
                        新建文件夹...
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        className="text-caption"
                        disabled={actionLoading}
                        onClick={() => {
                          setContextAccount(account);
                          setStatsOpen(true);
                        }}
                      >
                        <BarChart3 className="mr-2 h-3.5 w-3.5" />
                        邮件统计...
                      </ContextMenuItem>
                      <ContextMenuItem
                        className="text-caption"
                        disabled={actionLoading}
                        onClick={() => {
                          setContextAccount(account);
                          setSettingsOpen(true);
                        }}
                      >
                        <Settings className="mr-2 h-3.5 w-3.5" />
                        设置...
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        className="text-caption text-destructive focus:text-destructive"
                        disabled={actionLoading}
                        onClick={() => {
                          void handleRemoveAccount(account);
                        }}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                        删除账号
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  {isExpanded && (
                    <div className="ml-3 flex flex-col gap-0.5 border-l border-border/60 pl-1.5">
                      {isSelected && foldersLoading && accountFolders.length === 0 ? (
                        <div className="px-2 py-1 text-micro text-muted-foreground">
                          加载中...
                        </div>
                      ) : isSelected && foldersError && accountFolders.length === 0 ? (
                        <div className="px-2 py-1 text-micro text-destructive">
                          {foldersError}
                        </div>
                      ) : accountFolders.length === 0 ? (
                        <div className="px-2 py-1 text-micro text-muted-foreground">
                          没有文件夹
                        </div>
                      ) : (
                        accountFolders.map((folder) => {
                          if (folderIsHidden(folder)) return null;
                          const decodedName = folder.name;
                          const FolderIcon = getFolderIcon(decodedName);
                          const isFolderSelected =
                            isSelected && folder.name === selectedFolder;
                          const isJunk = isJunkFolder(decodedName);
                          const isSystem = isSystemFolder(decodedName);
                          const isNoSelect = isNoSelectFolder(folder.flags);
                          const folderGroupKey = actionKey("folder-group", account.id, folder.name);
                          const isGroupExpanded = !collapsedFolderGroups.has(folderGroupKey);
                          const isRenaming = renamingFolder === folder.name;
                          const markAllReadKey = actionKey("mark-all-read", account.id, folder.name);
                          const emptyFolderKey = actionKey("empty-folder", account.id, folder.name);
                          const renameFolderKey = actionKey("rename-folder", account.id, folder.name);
                          const deleteFolderKey = actionKey("delete-folder", account.id, folder.name);
                          return (
                            <ContextMenu key={folder.name}>
                              <ContextMenuTrigger asChild>
                                <div
                                  className={cn(
                                    "flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer",
                                    isFolderSelected
                                      ? "bg-info/10 text-foreground"
                                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                                  )}
                                  onClick={() => {
                                    if (isRenaming) return;
                                    if (isNoSelect) {
                                      if (folder.hasChildren) toggleFolderGroup(account.id, folder.name);
                                      return;
                                    }
                                    handleFolderClick(account.id, folder.name);
                                  }}
                                >
                                  {isNoSelect && folder.hasChildren ? (
                                    isGroupExpanded ? (
                                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                    ) : (
                                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                    )
                                  ) : (
                                    <FolderIcon className="h-3.5 w-3.5 shrink-0" />
                                  )}
                                  {isRenaming ? (
                                    <Input
                                      className="h-6 flex-1 rounded-xs px-1 py-0 text-caption"
                                      value={renameValue}
                                      autoFocus
                                      disabled={actionLoading}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => setRenameValue(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                          e.preventDefault();
                                          void handleRenameSubmit(account, folder.name);
                                        } else if (e.key === "Escape") {
                                          e.preventDefault();
                                          handleRenameCancel();
                                        }
                                      }}
                                      onBlur={() => {
                                        if (renamingFolder === folder.name) {
                                          void handleRenameSubmit(account, folder.name);
                                        }
                                      }}
                                    />
                                  ) : (
                                    <span className="min-w-0 flex-1 truncate text-caption">
                                      {getFolderDisplayName(decodedName)}
                                    </span>
                                  )}
                                  {!isRenaming && folder.unreadCount && folder.unreadCount > 0 ? (
                                    <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-[hsl(var(--brand-red))] px-1 text-[10px] font-medium text-white">
                                      {folder.unreadCount > 99 ? "99+" : folder.unreadCount}
                                    </span>
                                  ) : null}
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent className="w-44">
                                {!isSentFolder(folder.name) && (
                                  <>
                                    <ContextMenuItem
                                      className="text-caption"
                                      disabled={actionLoading || !gatewayUrl || isNoSelect}
                                      onClick={() => void handleMarkAllRead(account.id, folder.name)}
                                    >
                                      {activeAction === markAllReadKey ? (
                                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        <MailCheck className="mr-2 h-3.5 w-3.5" />
                                      )}
                                      全部标为已读
                                    </ContextMenuItem>
                                    <ContextMenuSeparator />
                                  </>
                                )}
                                <ContextMenuItem
                                  className="text-caption"
                                  disabled={actionLoading || !gatewayUrl || isSystem}
                                  onClick={() => handleStartRename(folder.name)}
                                >
                                  {activeAction === renameFolderKey ? (
                                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Pencil className="mr-2 h-3.5 w-3.5" />
                                  )}
                                  重命名
                                </ContextMenuItem>
                                {isJunk && (
                                  <>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem
                                      className="text-caption text-destructive focus:text-destructive"
                                      disabled={actionLoading || !gatewayUrl || isNoSelect}
                                      onClick={() => void handleEmptyFolder(account.id, folder.name)}
                                    >
                                      {activeAction === emptyFolderKey ? (
                                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        <Trash className="mr-2 h-3.5 w-3.5" />
                                      )}
                                      清空垃圾邮件
                                    </ContextMenuItem>
                                  </>
                                )}
                                <ContextMenuSeparator />
                                <ContextMenuItem
                                  className="text-caption text-destructive focus:text-destructive"
                                  disabled={actionLoading || !gatewayUrl || isSystem}
                                  onClick={() => void handleDeleteFolder(account, folder.name)}
                                >
                                  {activeAction === deleteFolderKey ? (
                                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                                  )}
                                  删除文件夹
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 底部导航：通讯录入口 */}
      {onViewChange && (
        <div className="shrink-0 border-t border-border bg-card p-1.5">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onViewChange(view === "contacts" ? "mail" : "contacts")}
            className={cn(
              "h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-caption font-normal transition-colors",
              view === "contacts"
                ? "bg-info/10 text-info-strong hover:bg-info/15 hover:text-info-strong"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            title={view === "contacts" ? "返回邮件" : "通讯录"}
          >
            {view === "contacts" ? (
              <Mail className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <BookUser className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="flex-1 text-left">
              {view === "contacts" ? "返回邮件" : "通讯录"}
            </span>
          </Button>
        </div>
      )}

      <EmailStatisticsDialog
        open={statsOpen}
        onOpenChange={setStatsOpen}
        account={contextAccount}
      />
      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        account={contextAccount}
        gatewayUrl={gatewayUrl}
        onCreated={(acc) => {
          selectAccount(acc.id);
          // 后端已把新文件夹写入本地缓存，仅读本地缓存即可显示，
          // 跳过 IMAP LIST 同步避免与 create_folder 的 IMAP 连接竞争锁
          void loadFolders(gatewayUrl, acc.id, true);
        }}
      />
      <AccountSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        account={contextAccount}
        onOpenEmailExtraction={onOpenEmailExtraction}
      />
      <NewAccountDialog
        open={newAccountOpen}
        onOpenChange={setNewAccountOpen}
        editAccount={null}
        gatewayUrl={gatewayUrl}
      />
      <AlertDialog
        open={actionError !== null}
        onOpenChange={(open) => {
          if (!open) setActionError(null);
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{actionError?.title}</AlertDialogTitle>
            <AlertDialogDescription className="text-ui">
              {actionError?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction className="h-8 text-caption">知道了</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
