import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { EmailAccount, EmailAnalysis, EmailFolder, EmailMessage } from "../lib/types";
import * as api from "../lib/emailApi";
import { sortFolders } from "../lib/folderUtils";

function calcTotalUnread(foldersByAccount: Record<string, EmailFolder[]>): number {
  let total = 0;
  for (const folders of Object.values(foldersByAccount)) {
    for (const f of folders) {
      total += f.unreadCount ?? 0;
    }
  }
  return total;
}

async function setTrayUnreadCount(count: number): Promise<void> {
  try {
    await invoke("set_tray_unread_count", { count });
  } catch {
    // 非桌面环境或命令未注册时静默忽略
  }
}

/** 发送系统级新邮件通知（Rust 侧 Windows Toast），点击后可跳转邮件页面 */
async function notifyNewMail(
  count: number,
  accountDisplayName: string,
  firstMessage: EmailMessage,
): Promise<void> {
  try {
    const title = count === 1 ? "新邮件" : `${count} 封新邮件`;
    const body =
      count === 1
        ? `${firstMessage.fromName || firstMessage.fromAddress}: ${firstMessage.subject || "(无主题)"}`
        : `${accountDisplayName} - 最新: ${firstMessage.subject || "(无主题)"}`;
    await invoke("send_mail_notification", { title, body });
  } catch {
    // 通知不可用时静默忽略
  }
}

interface EmailState {
  accounts: EmailAccount[];
  selectedAccountId: string | null;
  folders: EmailFolder[];
  foldersByAccount: Record<string, EmailFolder[]>;
  foldersLoading: boolean;
  foldersError: string | null;
  selectedFolder: string;
  messages: EmailMessage[];
  selectedMessage: EmailMessage | null;
  loading: boolean;
  syncing: boolean;
  error: string | null;
  gatewayUrl: string;
  // AI 分析结果缓存：key = `${uid}:${accountId}:${folder}`
  analysisCache: Record<string, EmailAnalysis>;
  analysisLoading: boolean;
  analysisError: string | null;
  // AI 对话会话 ID（email agent panel 的对话模式）
  agentChatId: string | null;
  // 所有账号总未读数（用于托盘图标）
  totalUnreadCount: number;

  loadAccounts: () => Promise<void>;
  addAccount: (account: EmailAccount) => Promise<void>;
  updateAccount: (account: EmailAccount) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;
  selectAccount: (accountId: string) => void;
  loadFolders: (gatewayUrl: string, accountId: string, localOnly?: boolean) => Promise<void>;
  selectFolder: (folder: string) => void;
  loadMessages: (accountId: string) => Promise<void>;
  syncMail: (gatewayUrl: string, mailbox?: string) => Promise<void>;
  // 全局同步所有账号 INBOX，返回每个账号的新邮件数；silent 为 true 时不弹通知
  syncAllAccounts: (gatewayUrl: string, silent?: boolean) => Promise<Record<string, number>>;
  // 启动所有账号的 IMAP IDLE 实时监听
  startAllIdle: (gatewayUrl: string) => Promise<void>;
  // 停止所有账号的 IDLE 监听
  stopAllIdle: (gatewayUrl: string) => Promise<void>;
  selectMessage: (message: EmailMessage | null) => void;
  toggleRead: (gatewayUrl: string, message: EmailMessage) => Promise<void>;
  toggleStarred: (gatewayUrl: string, message: EmailMessage) => Promise<void>;
  deleteMessage: (gatewayUrl: string, message: EmailMessage) => Promise<void>;
  markAllRead: (gatewayUrl: string, accountId: string, mailbox: string) => Promise<void>;
  emptyFolder: (gatewayUrl: string, accountId: string, mailbox: string) => Promise<void>;
  setGatewayUrl: (url: string) => void;
  refreshUnreadCounts: (accountId: string) => Promise<void>;
  // 重新计算所有账号总未读数
  recalcTotalUnread: () => Promise<void>;
  // AI 分析：从本地缓存加载（无则返回 null）
  loadAnalysis: (message: EmailMessage) => Promise<EmailAnalysis | null>;
  // AI 分析：调用 LLM 生成分析并存储
  runAnalysis: (gatewayUrl: string, message: EmailMessage) => Promise<EmailAnalysis>;
  // AI 对话会话管理
  setAgentChatId: (chatId: string | null) => void;
}

export const useEmailStore = create<EmailState>((set, get) => ({
  accounts: [],
  selectedAccountId: null,
  folders: [],
  foldersByAccount: {},
  foldersLoading: false,
  foldersError: null,
  selectedFolder: "INBOX",
  messages: [],
  selectedMessage: null,
  loading: false,
  syncing: false,
  error: null,
  gatewayUrl: "",
  analysisCache: {},
  analysisLoading: false,
  analysisError: null,
  agentChatId: null,
  totalUnreadCount: 0,

  setGatewayUrl: (url) => set({ gatewayUrl: url }),

  setAgentChatId: (chatId) => set({ agentChatId: chatId }),

  loadAccounts: async () => {
    set({ loading: true, error: null });
    try {
      const accounts = await api.listAccounts();
      set({ accounts, loading: false });
      const selectedId = get().selectedAccountId;
      if (!selectedId && accounts.length > 0) {
        set({ selectedAccountId: accounts[0].id });
      }
      // 加载账号后刷新总未读数并同步托盘图标
      await get().recalcTotalUnread();
      await setTrayUnreadCount(get().totalUnreadCount);
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  addAccount: async (account) => {
    set({ error: null });
    try {
      await api.addAccount(account);
      const accounts = [...get().accounts, account];
      set({ accounts, selectedAccountId: account.id });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  updateAccount: async (account) => {
    set({ error: null });
    try {
      await api.updateAccount(account);
      const accounts = get().accounts.map((a) => (a.id === account.id ? account : a));
      set({ accounts });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  removeAccount: async (accountId) => {
    set({ error: null });
    try {
      await api.deleteAccount(accountId);
      const accounts = get().accounts.filter((a) => a.id !== accountId);
      const selectedId = get().selectedAccountId;
      const isSelected = selectedId === accountId;
      const nextFoldersByAccount = { ...get().foldersByAccount };
      delete nextFoldersByAccount[accountId];
      const total = calcTotalUnread(nextFoldersByAccount);
      set({
        accounts,
        selectedAccountId: isSelected ? (accounts[0]?.id ?? null) : selectedId,
        folders: isSelected ? [] : get().folders,
        foldersByAccount: nextFoldersByAccount,
        selectedFolder: isSelected ? "INBOX" : get().selectedFolder,
        messages: isSelected ? [] : get().messages,
        selectedMessage: isSelected ? null : get().selectedMessage,
        totalUnreadCount: total,
      });
      await setTrayUnreadCount(total);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  selectAccount: (accountId) => {
    const cached = get().foldersByAccount[accountId] ?? [];
    set({
      selectedAccountId: accountId,
      folders: cached,
      selectedFolder: "INBOX",
      messages: [],
      selectedMessage: null,
    });
  },

  loadFolders: async (gatewayUrl, accountId, localOnly = false) => {
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) return;
    const hasCache = !!get().foldersByAccount[accountId];
    if (!hasCache) {
      set({ foldersLoading: true, foldersError: null });
    }

    // 1. 优先从本地 SQLite 读取缓存并立即显示，不阻塞菜单渲染
    let localFolders: EmailFolder[] = [];
    try {
      localFolders = await api.getFolders(accountId);
      const localCounts = await (async () => {
        try {
          return await api.getUnreadCounts(accountId);
        } catch {
          return {} as Record<string, number>;
        }
      })();
      const merged = sortFolders(
        localFolders.map((f) => ({
          ...f,
          unreadCount: localCounts[f.name] ?? 0,
        })),
      );
      set((state) => {
        const nextFoldersByAccount = {
          ...state.foldersByAccount,
          [accountId]: merged,
        };
        return {
          folders: merged,
          foldersByAccount: nextFoldersByAccount,
          foldersLoading: false,
          foldersError: null,
          totalUnreadCount: calcTotalUnread(nextFoldersByAccount),
        };
      });
      await setTrayUnreadCount(get().totalUnreadCount);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[email] getFolders failed", e);
      if (!hasCache) {
        set({ foldersLoading: false, foldersError: String(e) });
      }
    }

    // 2. 后台连接 IMAP 同步最新文件夹列表，静默更新缓存
    //    localOnly 模式跳过 IMAP 同步，仅用本地缓存（用于新建文件夹后避免锁竞争）
    if (!gatewayUrl || localOnly) return;
    try {
      const synced = await api.syncFolders(gatewayUrl, account);
      const localCounts = await (async () => {
        try {
          return await api.getUnreadCounts(accountId);
        } catch {
          return {} as Record<string, number>;
        }
      })();
      const merged = sortFolders(
        synced.map((f) => ({
          ...f,
          unreadCount: localCounts[f.name] ?? 0,
        })),
      );
      set((state) => {
        const cached = state.foldersByAccount[accountId] ?? [];
        // 防御：若 IMAP 返回空但本地有缓存，保留缓存避免文件夹树被清空
        const effective =
          merged.length === 0 && cached.length > 0 ? cached : merged;
        const nextFoldersByAccount = {
          ...state.foldersByAccount,
          [accountId]: effective,
        };
        return {
          folders:
            state.selectedAccountId === accountId ? effective : state.folders,
          foldersByAccount: nextFoldersByAccount,
          foldersLoading: false,
          foldersError: null,
          totalUnreadCount: calcTotalUnread(nextFoldersByAccount),
        };
      });
      await setTrayUnreadCount(get().totalUnreadCount);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[email] syncFolders failed", e);
    }
  },

  refreshUnreadCounts: async (accountId) => {
    try {
      const localCounts = await api.getUnreadCounts(accountId);
      set((state) => {
        const cached = state.foldersByAccount[accountId] ?? state.folders;
        const merged = cached.map((f) => ({
          ...f,
          unreadCount: localCounts[f.name] ?? 0,
        }));
        const nextFoldersByAccount = { ...state.foldersByAccount, [accountId]: merged };
        const total = calcTotalUnread(nextFoldersByAccount);
        return {
          folders: state.selectedAccountId === accountId ? merged : state.folders,
          foldersByAccount: nextFoldersByAccount,
          totalUnreadCount: total,
        };
      });
    } catch {
      // ignore
    }
  },

  recalcTotalUnread: async () => {
    set((state) => ({ totalUnreadCount: calcTotalUnread(state.foldersByAccount) }));
  },

  selectFolder: (folder) => {
    set({ selectedFolder: folder, messages: [], selectedMessage: null });
  },

  loadMessages: async (accountId) => {
    const folder = get().selectedFolder;
    set({ loading: true, error: null });
    try {
      const messages = await api.getMessages(accountId, folder, 0, 50);
      set({ messages, loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  syncMail: async (gatewayUrl, mailbox) => {
    const account = get().accounts.find((a) => a.id === get().selectedAccountId);
    if (!account) return;
    const targetMailbox = mailbox ?? get().selectedFolder;
    // 记录同步前的 UID 集合，用于检测新邮件
    const prevUids = new Set(get().messages.map((m) => m.uid));
    const hadPrevMessages = prevUids.size > 0;
    set({ syncing: true, error: null });
    try {
      await api.syncEmail(gatewayUrl, account, targetMailbox);
      await get().loadMessages(account.id);
      // 检测新邮件并发系统通知（首次加载不通知）
      const newMessages = get().messages.filter((m) => !prevUids.has(m.uid));
      if (newMessages.length > 0 && hadPrevMessages) {
        await notifyNewMail(newMessages.length, account.displayName, newMessages[0]);
      }
      // 同步后用本地数据库刷新未读数
      await get().refreshUnreadCounts(account.id);
      await setTrayUnreadCount(get().totalUnreadCount);
      set({ syncing: false });
    } catch (e) {
      set({ syncing: false, error: String(e) });
    }
  },

  syncAllAccounts: async (gatewayUrl, silent = false) => {
    const accounts = get().accounts;
    if (accounts.length === 0 || !gatewayUrl) return {};
    const result: Record<string, number> = {};
    set({ syncing: true, error: null });
    try {
      for (const account of accounts) {
        try {
          const newCount = await api.syncEmail(gatewayUrl, account, "INBOX");
          // 用本地数据库刷新未读数
          await get().refreshUnreadCounts(account.id);
          result[account.id] = newCount;
          // 非首次全局同步且检测到新邮件时发系统通知
          if (!silent && newCount > 0) {
            const messages = await api.getMessages(account.id, "INBOX", 0, 50);
            const latest = messages[0];
            if (latest) {
              await notifyNewMail(newCount, account.displayName, latest);
            }
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[email] sync account failed", account.id, e);
        }
      }
      // 全部同步后刷新一次总未读数并同步托盘
      await get().recalcTotalUnread();
      await setTrayUnreadCount(get().totalUnreadCount);
      // 如果当前选中的是 INBOX，刷新邮件列表以便用户看到新邮件
      const selectedAccountId = get().selectedAccountId;
      const selectedFolder = get().selectedFolder;
      if (selectedAccountId && selectedFolder === "INBOX") {
        await get().loadMessages(selectedAccountId);
      }
      set({ syncing: false });
      return result;
    } catch (e) {
      set({ syncing: false, error: String(e) });
      return result;
    }
  },

  startAllIdle: async (gatewayUrl) => {
    const accounts = get().accounts;
    if (accounts.length === 0 || !gatewayUrl) return;
    for (const account of accounts) {
      try {
        await api.startIdle(gatewayUrl, account, "INBOX");
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[email] start IDLE failed", account.id, e);
      }
    }
  },

  stopAllIdle: async (gatewayUrl) => {
    const accounts = get().accounts;
    if (accounts.length === 0 || !gatewayUrl) return;
    for (const account of accounts) {
      try {
        await api.stopIdle(gatewayUrl, account.id);
      } catch {
        // 忽略停止失败
      }
    }
  },

  selectMessage: (message) => {
    set({ selectedMessage: message });
  },

  toggleRead: async (gatewayUrl, message) => {
    const account = get().accounts.find((a) => a.id === message.accountId);
    if (!account) return;
    const next = !message.isRead;
    set((state) => ({
      messages: state.messages.map((m) =>
        m.uid === message.uid ? { ...m, isRead: next } : m,
      ),
      selectedMessage:
        state.selectedMessage?.uid === message.uid
          ? { ...state.selectedMessage, isRead: next }
          : state.selectedMessage,
    }));
    try {
      await api.markRead(gatewayUrl, account, message.folder, message.uid, next);
      // 用本地数据库刷新未读数
      await get().refreshUnreadCounts(account.id);
    } catch (e) {
      // 回滚
      set((state) => ({
        messages: state.messages.map((m) =>
          m.uid === message.uid ? { ...m, isRead: message.isRead } : m,
        ),
        selectedMessage:
          state.selectedMessage?.uid === message.uid
            ? { ...state.selectedMessage, isRead: message.isRead }
            : state.selectedMessage,
      }));
      set({ error: String(e) });
    }
  },

  toggleStarred: async (gatewayUrl, message) => {
    const account = get().accounts.find((a) => a.id === message.accountId);
    if (!account) return;
    const next = !message.isStarred;
    set((state) => ({
      messages: state.messages.map((m) =>
        m.uid === message.uid ? { ...m, isStarred: next } : m,
      ),
      selectedMessage:
        state.selectedMessage?.uid === message.uid
          ? { ...state.selectedMessage, isStarred: next }
          : state.selectedMessage,
    }));
    try {
      await api.toggleStarred(gatewayUrl, account, message.folder, message.uid, next);
    } catch (e) {
      // 回滚
      set((state) => ({
        messages: state.messages.map((m) =>
          m.uid === message.uid ? { ...m, isStarred: message.isStarred } : m,
        ),
        selectedMessage:
          state.selectedMessage?.uid === message.uid
            ? { ...state.selectedMessage, isStarred: message.isStarred }
            : state.selectedMessage,
      }));
      set({ error: String(e) });
    }
  },

  deleteMessage: async (gatewayUrl, message) => {
    const account = get().accounts.find((a) => a.id === message.accountId);
    if (!account) return;
    set({ loading: true, error: null });
    try {
      await api.deleteMessage(gatewayUrl, account, message.folder, message.uid);
      set((state) => ({
        messages: state.messages.filter((m) => m.uid !== message.uid),
        selectedMessage:
          state.selectedMessage?.uid === message.uid ? null : state.selectedMessage,
        loading: false,
      }));
      // 删除后刷新未读数
      await get().refreshUnreadCounts(account.id);
    } catch (e) {
      set({ loading: false, error: String(e) });
      throw e;
    }
  },

  markAllRead: async (gatewayUrl, accountId, mailbox) => {
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) return;
    set({ loading: true, error: null });
    try {
      await api.markAllRead(gatewayUrl, account, mailbox);
      // 本地缓存同步
      set((state) => ({
        messages: state.messages.map((m) =>
          m.folder === mailbox && m.accountId === accountId
            ? { ...m, isRead: true }
            : m,
        ),
        loading: false,
      }));
      await get().refreshUnreadCounts(accountId);
    } catch (e) {
      set({ loading: false, error: String(e) });
      throw e;
    }
  },

  emptyFolder: async (gatewayUrl, accountId, mailbox) => {
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) return;
    set({ loading: true, error: null });
    try {
      await api.emptyFolder(gatewayUrl, account, mailbox);
      set((state) => ({
        messages:
          state.selectedFolder === mailbox
            ? []
            : state.messages,
        selectedMessage:
          state.selectedMessage?.folder === mailbox ? null : state.selectedMessage,
        loading: false,
      }));
      await get().refreshUnreadCounts(accountId);
    } catch (e) {
      set({ loading: false, error: String(e) });
      throw e;
    }
  },

  loadAnalysis: async (message) => {
    const key = `${message.uid}:${message.accountId}:${message.folder}`;
    const cached = get().analysisCache[key];
    if (cached) return cached;
    try {
      const analysis = await api.getEmailAnalysis(
        message.uid,
        message.accountId,
        message.folder,
      );
      if (analysis) {
        set((state) => ({
          analysisCache: { ...state.analysisCache, [key]: analysis },
        }));
      }
      return analysis;
    } catch {
      return null;
    }
  },

  runAnalysis: async (gatewayUrl, message) => {
    set({ analysisLoading: true, analysisError: null });
    try {
      // 提取邮件图片（内嵌 + 附件），用于多模态分析
      const account = get().accounts.find((a) => a.id === message.accountId) ?? null;
      const images = await api.prepareAnalyzeImages(gatewayUrl, message, account);
      const result = await api.analyzeEmail(gatewayUrl, message, images);
      const analysis: EmailAnalysis = {
        uid: message.uid,
        accountId: message.accountId,
        folder: message.folder,
        summary: result.summary,
        category: result.category,
        intent: result.intent,
        urgency: result.urgency,
        sentiment: result.sentiment,
        keyInfo: result.keyInfo,
        analyzedAt: new Date().toISOString(),
      };
      // 持久化到本地 SQLite
      try {
        await api.saveEmailAnalysis(analysis);
      } catch {
        // 存储失败不影响展示
      }
      const key = `${message.uid}:${message.accountId}:${message.folder}`;
      set((state) => ({
        analysisCache: { ...state.analysisCache, [key]: analysis },
        analysisLoading: false,
      }));
      return analysis;
    } catch (e) {
      set({ analysisLoading: false, analysisError: String(e) });
      throw e;
    }
  },
}));
