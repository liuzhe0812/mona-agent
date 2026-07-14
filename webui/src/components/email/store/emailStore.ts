import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { EmailAccount, EmailAnalysis, EmailAttachment, EmailFolder, EmailMessage } from "../lib/types";
import * as api from "../lib/emailApi";
import { sortFolders } from "../lib/folderUtils";
import { showNotification } from "@/lib/tauri";

// 正在进行的 fetchBody 请求去重，避免 useEffect + selectMessage 预取重复触发 IPC
const inflightBodyLoads = new Set<string>();

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

/** 发送新邮件通知（自定义右下角弹窗，独立 Tauri 窗口） */
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
    await showNotification({
      id: `mail-${firstMessage.uid}-${Date.now()}`,
      title,
      body,
      icon: "mail",
      autoCloseMs: 6000,
      clickAction: "open-email",
    });
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
  // 后台同步（IDLE 推送/定时轮询触发），不阻塞 UI
  backgroundSyncing: boolean;
  error: string | null;
  gatewayUrl: string;
  // AI 分析结果缓存：key = `${uid}:${accountId}:${folder}`
  analysisCache: Record<string, EmailAnalysis>;
  // 正文缓存：key = `${uid}:${accountId}:${folder}`，value = { bodyText, bodyHtml, attachments }
  // 避免切换邮件/刷新列表时重复调 gateway 解析 .eml（SQLite 不存正文，每次 reload 都是空）
  bodyCache: Record<string, { bodyText: string; bodyHtml: string | null; attachments?: EmailAttachment[] }>;
  analysisLoading: boolean;
  analysisError: string | null;
  // AI 对话会话 ID（email agent panel 的对话模式）
  agentChatId: string | null;
  // 所有账号总未读数（用于托盘图标）
  totalUnreadCount: number;
  // gateway 是否在线（离线时仅可查看本地缓存）
  isOnline: boolean;
  // 游标分页：是否还有更旧的邮件可加载（上次拉取数量等于 limit 时为 true）
  hasMore: boolean;
  // 正在加载下一页（不阻塞首屏，仅控制底部 spinner）
  loadingMore: boolean;
  // 是否处于统一收件箱模式（聚合所有账号 INBOX）
  isUnifiedInbox: boolean;
  // 联系人邮箱→名称映射（小写 email → displayName），用于地址显示解析
  contactsByEmail: Record<string, string>;
  contactsLoaded: boolean;

  loadAccounts: () => Promise<void>;
  addAccount: (account: EmailAccount) => Promise<void>;
  updateAccount: (account: EmailAccount, newPassword?: string | null) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;
  selectAccount: (accountId: string) => void;
  // 加载所有联系人，建立 email→name 映射
  loadContacts: () => Promise<void>;
  loadFolders: (gatewayUrl: string, accountId: string, localOnly?: boolean) => Promise<void>;
  selectFolder: (folder: string) => void;
  loadMessages: (accountId: string, folder?: string) => Promise<void>;
  // 加载下一页（基于当前列表最旧 uid 作为游标）
  loadMore: () => Promise<void>;
  // 切换到统一收件箱模式并加载
  selectUnifiedInbox: () => Promise<void>;
  syncMail: (gatewayUrl: string, mailbox?: string) => Promise<void>;
  // 全局同步所有账号 INBOX，返回每个账号的新邮件数；silent 为 true 时不弹通知
  syncAllAccounts: (gatewayUrl: string, silent?: boolean) => Promise<Record<string, number>>;
  // 启动所有账号的 IMAP IDLE 实时监听
  startAllIdle: (gatewayUrl: string) => Promise<void>;
  // 停止所有账号的 IDLE 监听
  stopAllIdle: (gatewayUrl: string) => Promise<void>;
  selectMessage: (message: EmailMessage | null) => void;
  // 按需拉取邮件正文（同步时只拉头部，点击邮件时调用）
  fetchBody: (gatewayUrl: string, message: EmailMessage) => Promise<void>;
  toggleRead: (gatewayUrl: string, message: EmailMessage) => Promise<void>;
  toggleStarred: (gatewayUrl: string, message: EmailMessage) => Promise<void>;
  deleteMessage: (gatewayUrl: string, message: EmailMessage) => Promise<void>;
  markAllRead: (gatewayUrl: string, accountId: string, mailbox: string) => Promise<void>;
  emptyFolder: (gatewayUrl: string, accountId: string, mailbox: string) => Promise<void>;
  setGatewayUrl: (url: string) => void;
  refreshUnreadCounts: (accountId: string) => Promise<void>;
  // 重新计算所有账号总未读数（基于 foldersByAccount）
  recalcTotalUnread: () => Promise<void>;
  // 直接从 SQLite 查询所有账号总未读数（不依赖 foldersByAccount，用于全局初始化）
  loadTotalUnreadFromDb: () => Promise<void>;
  // AI 分析：从本地缓存加载（无则返回 null）
  loadAnalysis: (message: EmailMessage) => Promise<EmailAnalysis | null>;
  // AI 分析：调用 LLM 生成分析并存储
  runAnalysis: (gatewayUrl: string, message: EmailMessage) => Promise<EmailAnalysis>;
  // AI 对话会话管理
  setAgentChatId: (chatId: string | null) => void;
  // 检测 gateway 是否在线（ping /health），更新 isOnline 状态
  checkGatewayHealth: (gatewayUrl: string) => Promise<boolean>;
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
  backgroundSyncing: false,
  error: null,
  gatewayUrl: "",
  analysisCache: {},
  bodyCache: {},
  analysisLoading: false,
  analysisError: null,
  agentChatId: null,
  totalUnreadCount: 0,
  isOnline: true,
  hasMore: false,
  loadingMore: false,
  isUnifiedInbox: false,
  contactsByEmail: {},
  contactsLoaded: false,

  setGatewayUrl: (url) => set({ gatewayUrl: url }),

  setAgentChatId: (chatId) => set({ agentChatId: chatId }),

  loadContacts: async () => {
    if (get().contactsLoaded) return;
    try {
      const { listContacts } = await import("../contacts/lib/contactsApi");
      const { getAllEmails } = await import("../contacts/lib/types");
      const contacts = await listContacts();
      const map: Record<string, string> = {};
      for (const c of contacts) {
        const name = (c.displayName || "").trim();
        if (!name) continue;
        for (const email of getAllEmails(c)) {
          const key = email.toLowerCase().trim();
          if (key && !map[key]) map[key] = name;
        }
      }
      set({ contactsByEmail: map, contactsLoaded: true });
    } catch (e) {
      console.warn("loadContacts failed:", e);
      set({ contactsLoaded: true });
    }
  },

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
      // foldersByAccount 可能为空（未打开邮件模块），直接从 SQLite 查询
      await get().loadTotalUnreadFromDb();
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

  updateAccount: async (account, newPassword) => {
    set({ error: null });
    try {
      // 调用 updateAccountSettings：未传 newPassword 时保留原密码，避免双重加密
      await api.updateAccountSettings(account, newPassword ?? null);
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
      const gatewayUrl = get().gatewayUrl;
      await api.deleteAccount(gatewayUrl, accountId);
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
        hasMore: false,
      });
      await setTrayUnreadCount(total);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  selectAccount: (accountId) => {
    const cached = get().foldersByAccount[accountId] ?? [];
    // 不清空 messages，避免切换账号时列表瞬间空白闪烁
    // loadMessages 会无缝替换为新账号 INBOX 的内容
    set({
      selectedAccountId: accountId,
      folders: cached,
      selectedFolder: "INBOX",
      selectedMessage: null,
      hasMore: false,
      isUnifiedInbox: false,
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

    // 2. 后台连接 IMAP 同步最新文件夹列表，fire-and-forget 不阻塞首屏
    //    本地 SQLite 结果已在 step 1 立即渲染，IMAP 同步完成后静默更新缓存
    //    localOnly 模式跳过 IMAP 同步，仅用本地缓存（用于新建文件夹后避免锁竞争）
    if (!gatewayUrl || localOnly) return;
    // 不 await：让 IMAP LIST 在后台执行，不阻塞当前调用
    void (async () => {
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
    })();
  },

  refreshUnreadCounts: async (accountId) => {
    try {
      const localCounts = await api.getUnreadCounts(accountId);
      let shouldLoadMessages = false;
      const selectedFolder = get().selectedFolder;
      set((state) => {
        const cached = state.foldersByAccount[accountId] ?? state.folders;
        const prevUnread = cached.find((f) => f.name === selectedFolder)?.unreadCount ?? 0;
        const newUnread = localCounts[selectedFolder] ?? 0;
        const merged = cached.map((f) => ({
          ...f,
          unreadCount: localCounts[f.name] ?? 0,
        }));
        const nextFoldersByAccount = { ...state.foldersByAccount, [accountId]: merged };
        const total = calcTotalUnread(nextFoldersByAccount);
        // 兜底：当前选中文件夹的未读数增加，说明有新邮件但列表未刷新
        // 或文件夹显示有未读但当前列表为空（loadMessages 可能因竞态失败）
        if (
          state.selectedAccountId === accountId &&
          state.selectedFolder === selectedFolder &&
          (newUnread > prevUnread || (newUnread > 0 && state.messages.length === 0))
        ) {
          shouldLoadMessages = true;
        }
        return {
          folders: state.selectedAccountId === accountId ? merged : state.folders,
          foldersByAccount: nextFoldersByAccount,
          totalUnreadCount: total,
        };
      });
      // 同步托盘图标（refreshUnreadCounts 是未读数变化的统一出口）
      await setTrayUnreadCount(get().totalUnreadCount);
      if (shouldLoadMessages) {
        await get().loadMessages(accountId, selectedFolder);
      }
    } catch {
      // ignore
    }
  },

  recalcTotalUnread: async () => {
    set((state) => ({ totalUnreadCount: calcTotalUnread(state.foldersByAccount) }));
  },

  loadTotalUnreadFromDb: async () => {
    const accounts = get().accounts;
    if (accounts.length === 0) {
      set({ totalUnreadCount: 0 });
      return;
    }
    let total = 0;
    for (const account of accounts) {
      try {
        const counts = await api.getUnreadCounts(account.id);
        for (const cnt of Object.values(counts)) {
          total += cnt;
        }
      } catch {
        // 单个账号查询失败时跳过，不影响其他账号
      }
    }
    set({ totalUnreadCount: total });
  },

  selectFolder: (folder) => {
    // 不清空 messages，避免切换文件夹时列表瞬间空白闪烁
    // loadMessages 会无缝替换为新文件夹的内容
    set({ selectedFolder: folder, selectedMessage: null, hasMore: false, isUnifiedInbox: false });
  },

  loadMessages: async (accountId, folderParam) => {
    // 显式传入 folder，避免 selectFolder/set 的异步竞态导致读到旧文件夹
    const folder = folderParam ?? get().selectedFolder;
    // 不设置 loading: true，避免本地 SQLite 查询（<10ms）时显示"加载中"闪烁
    // 本地查询极快，直接无缝替换列表内容（foxmail 式体验）
    try {
      const PAGE_SIZE = 50;
      const messages = await api.getMessages(accountId, folder, null, PAGE_SIZE);
      // 从内存缓存恢复正文（SQLite 不存正文，但 bodyCache 有已解析过的）
      const bodyCache = get().bodyCache;
      const messagesWithBody = messages.map((m) => {
        const key = `${m.uid}:${m.accountId}:${m.folder}`;
        const cached = bodyCache[key];
        if (cached && (cached.bodyText || cached.bodyHtml)) {
          return { ...m, bodyText: cached.bodyText, bodyHtml: cached.bodyHtml, bodyFetched: true };
        }
        return m;
      });
      // 仅在用户仍停留在同一账号同一文件夹时才更新（避免异步竞态：用户已切换走）
      if (get().selectedAccountId === accountId && get().selectedFolder === folder) {
        set({
          messages: messagesWithBody,
          loading: false,
          error: null,
          hasMore: messagesWithBody.length === PAGE_SIZE,
        });
        // 不在点击空文件夹时触发同步：
        // 后台定时同步（5分钟）+ IMAP IDLE 会自动覆盖所有文件夹，
        // 用户需要立即同步时点工具栏「收取」按钮。
        // 之前点击空文件夹触发同步会显示"正在后台同步..."且争抢 IMAP 锁。
      }
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  loadMore: async () => {
    // 防止重复加载 / 已无更多 / 正在加载
    if (get().loadingMore || !get().hasMore) return;
    if (get().isUnifiedInbox) {
      // 统一收件箱模式：使用 date 作为游标（uid 跨账号会冲突）
      const { messages } = get();
      if (messages.length === 0) return;
      // 取列表中最早的 date 作为游标
      const oldestDate = messages.reduce((min, m) => (m.date < min ? m.date : min), messages[0].date);
      set({ loadingMore: true });
      try {
        const PAGE_SIZE = 50;
        const older = await api.getUnifiedInbox(oldestDate, PAGE_SIZE);
        if (get().isUnifiedInbox) {
          // 去重：避免相同 (accountId, uid) 重复
          const existingKeys = new Set(get().messages.map((m) => `${m.accountId}:${m.uid}`));
          const fresh = older.filter((m) => !existingKeys.has(`${m.accountId}:${m.uid}`));
          set((state) => ({
            messages: [...state.messages, ...fresh],
            loadingMore: false,
            hasMore: older.length === PAGE_SIZE,
          }));
        } else {
          set({ loadingMore: false });
        }
      } catch (e) {
        set({ loadingMore: false, error: String(e) });
      }
      return;
    }
    const { selectedAccountId, selectedFolder, messages } = get();
    if (!selectedAccountId || messages.length === 0) return;
    // 取当前列表中最旧的 uid 作为游标（uid 是字符串，按数值大小排序）
    const oldestUid = messages.reduce((min, m) => {
      const cur = parseInt(m.uid, 10) || 0;
      const minVal = parseInt(min, 10) || 0;
      return cur < minVal ? m.uid : min;
    }, messages[0].uid);
    set({ loadingMore: true });
    try {
      const PAGE_SIZE = 50;
      const older = await api.getMessages(selectedAccountId, selectedFolder, oldestUid, PAGE_SIZE);
      // 防竞态：用户可能在 await 期间切换文件夹，确保仍是同一账号同一文件夹
      if (get().selectedAccountId === selectedAccountId && get().selectedFolder === selectedFolder) {
        // 去重：避免游标计算错误导致重复
        const existingUids = new Set(get().messages.map((m) => m.uid));
        const fresh = older.filter((m) => !existingUids.has(m.uid));
        set((state) => ({
          messages: [...state.messages, ...fresh],
          loadingMore: false,
          hasMore: older.length === PAGE_SIZE,
        }));
      } else {
        set({ loadingMore: false });
      }
    } catch (e) {
      set({ loadingMore: false, error: String(e) });
    }
  },

  selectUnifiedInbox: async () => {
    set({
      isUnifiedInbox: true,
      selectedAccountId: null,
      selectedFolder: "INBOX",
      selectedMessage: null,
      messages: [],
      hasMore: false,
    });
    try {
      const PAGE_SIZE = 50;
      const messages = await api.getUnifiedInbox(null, PAGE_SIZE);
      if (get().isUnifiedInbox) {
        set({ messages, loading: false, error: null, hasMore: messages.length === PAGE_SIZE });
      }
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  syncMail: async (gatewayUrl, mailbox) => {
    const account = get().accounts.find((a) => a.id === get().selectedAccountId);
    if (!account) return;
    const targetMailbox = mailbox ?? get().selectedFolder;
    // 记录同步前的 UID 集合，用于检测是否需要通知（首次加载不通知）
    const prevUids = new Set(get().messages.map((m) => m.uid));
    const hadPrevMessages = prevUids.size > 0;
    set({ syncing: true, error: null });
    try {
      const result = await api.syncEmail(gatewayUrl, account, targetMailbox);
      // 增量 prepend：只把新邮件插入到列表头部，不全量 reload
      // 避免列表重新渲染、滚动位置丢失、视觉闪烁
      const freshNew = result.newMessages.filter((m) => !prevUids.has(m.uid));
      if (freshNew.length > 0) {
        set((state) => ({
          messages: [...freshNew, ...state.messages],
        }));
      }
      // 新邮件通知（首次加载不通知）
      if (freshNew.length > 0 && hadPrevMessages) {
        await notifyNewMail(freshNew.length, account.displayName, freshNew[0]);
      }
      // 同步后用本地数据库刷新未读数
      await get().refreshUnreadCounts(account.id);
      await setTrayUnreadCount(get().totalUnreadCount);
      set({ syncing: false });
      // 兜底：如果当前选中文件夹是本次同步的目标，但 prepend 没新增（newMessages 为空
      // 或都是已存在邮件），从 SQLite 重新加载列表，确保新邮件能显示
      if (
        get().selectedAccountId === account.id &&
        get().selectedFolder === targetMailbox &&
        freshNew.length === 0
      ) {
        await get().loadMessages(account.id, targetMailbox);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // 422 = 文件夹不支持同步（企业邮箱限制），静默处理不弹报错
      if (errMsg.includes("422") || errMsg.includes("不支持同步")) {
        set({ syncing: false, error: null });
      } else {
        set({ syncing: false, error: errMsg });
      }
    }
  },

  syncAllAccounts: async (gatewayUrl, silent = false) => {
    const accounts = get().accounts;
    if (accounts.length === 0 || !gatewayUrl) return {};
    const result: Record<string, number> = {};
    // 后台同步用 backgroundSyncing，不阻塞 UI（不显示"正在收取..."，不禁用按钮）
    set({ backgroundSyncing: true, error: null });
    // 并行同步所有账号 INBOX：各账号 IMAP 连接独立，互不阻塞
    // 单账号失败不影响其他账号；result 在每个 task 内部独立写入（无并发写竞态）
    await Promise.all(
      accounts.map(async (account) => {
        try {
          const syncResult = await api.syncEmail(gatewayUrl, account, "INBOX");
          // 用本地数据库刷新未读数
          await get().refreshUnreadCounts(account.id);
          result[account.id] = syncResult.newCount;
          // 非首次全局同步且检测到新邮件时发系统通知
          if (!silent && syncResult.newCount > 0 && syncResult.newMessages.length > 0) {
            await notifyNewMail(syncResult.newCount, account.displayName, syncResult.newMessages[0]);
          }
          // 如果当前选中的是 INBOX，增量 prepend 新邮件
          const selectedAccountId = get().selectedAccountId;
          const selectedFolder = get().selectedFolder;
          if (
            selectedAccountId === account.id &&
            selectedFolder === "INBOX"
          ) {
            if (syncResult.newMessages.length > 0) {
              const prevUids = new Set(get().messages.map((m) => m.uid));
              const freshNew = syncResult.newMessages.filter((m) => !prevUids.has(m.uid));
              if (freshNew.length > 0) {
                set((state) => ({
                  messages: [...freshNew, ...state.messages],
                }));
              }
            }
            // 兜底：如果 syncResult.newMessages 为空但 newCount > 0，
            // 或当前列表为空，从 SQLite 重新加载，避免新邮件不显示
            if (syncResult.newCount > 0 && syncResult.newMessages.length === 0) {
              await get().loadMessages(account.id, "INBOX");
            }
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[email] sync account failed", account.id, e);
        }
      }),
    );
    // 全部同步后刷新一次总未读数并同步托盘
    // 用 DB 查询而非 foldersByAccount 计算，确保邮件模块未打开时也能正确更新
    await get().loadTotalUnreadFromDb();
    await setTrayUnreadCount(get().totalUnreadCount);
    set({ backgroundSyncing: false });
    // 统一收件箱模式：同步后重新加载聚合列表以显示新邮件
    if (get().isUnifiedInbox) {
      await get().selectUnifiedInbox();
    }
    return result;
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
    if (!message) {
      set({ selectedMessage: null });
      return;
    }
    // 命中内存缓存时直接带正文，MailView 首次渲染即显示（零加载）
    const cacheKey = `${message.uid}:${message.accountId}:${message.folder}`;
    const cached = get().bodyCache[cacheKey];
    if (cached && (cached.bodyText || cached.bodyHtml)) {
      set({
        selectedMessage: {
          ...message,
          bodyText: cached.bodyText,
          bodyHtml: cached.bodyHtml,
          bodyFetched: true,
          bodyError: null,
          attachments: cached.attachments ?? message.attachments,
        },
      });
      return;
    }
    set({ selectedMessage: message });
    // 预取正文：不等 MailView 的 useEffect，省一个渲染周期
    const gw = get().gatewayUrl;
    if (gw && !message.bodyFetched) {
      void get().fetchBody(gw, message);
    }
  },

  fetchBody: async (gatewayUrl, message) => {
    const cacheKey = `${message.uid}:${message.accountId}:${message.folder}`;
    // 1. 先查内存缓存（SQLite 不存正文，但解析过的正文缓存在 store 中）
    const cached = get().bodyCache[cacheKey];
    if (cached && (cached.bodyText || cached.bodyHtml)) {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.uid === message.uid && m.accountId === message.accountId
            ? {
                ...m,
                bodyText: cached.bodyText,
                bodyHtml: cached.bodyHtml,
                bodyFetched: true,
                bodyError: null,
                attachments: cached.attachments ?? m.attachments,
              }
            : m,
        ),
        selectedMessage:
          state.selectedMessage?.uid === message.uid
            ? {
                ...state.selectedMessage,
                bodyText: cached.bodyText,
                bodyHtml: cached.bodyHtml,
                bodyFetched: true,
                bodyError: null,
                attachments: cached.attachments ?? state.selectedMessage.attachments,
              }
            : state.selectedMessage,
      }));
      return;
    }
    // 2. 已缓存且有内容才跳过（兼容旧数据 body_fetched 默认 1 但正文为空的情况）
    //    但有附件未加载时不跳过，需要拉取附件列表
    if (
      message.bodyFetched &&
      (message.bodyText || message.bodyHtml) &&
      (!message.hasAttachments || (message.attachments && message.attachments.length > 0))
    ) {
      return;
    }
    // 3. in-flight 去重：selectMessage 预取和 useEffect 可能同时触发，避免重复 IPC
    if (inflightBodyLoads.has(cacheKey)) return;
    inflightBodyLoads.add(cacheKey);
    // 4. 标记为正在加载：把 bodyFetched 置 false，触发 UI 显示 spinner
    //    避免 bodyFetched=true 但正文为空时显示"(无正文)"的闪烁
    set((state) => ({
      messages: state.messages.map((m) =>
        m.uid === message.uid && m.accountId === message.accountId
          ? { ...m, bodyFetched: false, bodyError: null }
          : m,
      ),
      selectedMessage:
        state.selectedMessage?.uid === message.uid
          ? { ...state.selectedMessage, bodyFetched: false, bodyError: null }
          : state.selectedMessage,
    }));
    try {
      const result = await api.fetchEmailBody(
        gatewayUrl,
        message.accountId,
        message.uid,
        message.folder,
      );
      // 写入内存缓存 + 更新本地消息对象
      const header = result.header;
      set((state) => ({
        bodyCache: {
          ...state.bodyCache,
          [cacheKey]: { bodyText: result.bodyText, bodyHtml: result.bodyHtml, attachments: result.attachments },
        },
        messages: state.messages.map((m) =>
          m.uid === message.uid && m.accountId === message.accountId
            ? {
                ...m,
                bodyText: result.bodyText,
                bodyHtml: result.bodyHtml,
                bodyFetched: true,
                bodyError: null,
                attachments: result.attachments ?? m.attachments,
                // 用重新解析的 header 修复旧数据中可能的乱码（gb2312→gb18030 修复前）
                ...(header
                  ? {
                      subject: header.subject,
                      fromAddress: header.fromAddress,
                      fromName: header.fromName,
                      toAddresses: header.toAddresses,
                      ccAddresses: header.ccAddresses,
                    }
                  : {}),
              }
            : m,
        ),
        selectedMessage:
          state.selectedMessage?.uid === message.uid
            ? {
                ...state.selectedMessage,
                bodyText: result.bodyText,
                bodyHtml: result.bodyHtml,
                bodyFetched: true,
                bodyError: null,
                attachments: result.attachments ?? state.selectedMessage.attachments,
                ...(header
                  ? {
                      subject: header.subject,
                      fromAddress: header.fromAddress,
                      fromName: header.fromName,
                      toAddresses: header.toAddresses,
                      ccAddresses: header.ccAddresses,
                    }
                  : {}),
              }
            : state.selectedMessage,
      }));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("fetchBody failed:", errMsg);
      // 记录错误到 UI 状态，避免永远 loading；用户可重新点击邮件触发重试
      set((state) => ({
        messages: state.messages.map((m) =>
          m.uid === message.uid && m.accountId === message.accountId
            ? { ...m, bodyError: errMsg }
            : m,
        ),
        selectedMessage:
          state.selectedMessage?.uid === message.uid
            ? { ...state.selectedMessage, bodyError: errMsg }
            : state.selectedMessage,
      }));
      throw e;
    } finally {
      inflightBodyLoads.delete(cacheKey);
    }
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
    // 乐观更新：先从本地列表移除，UI 立即响应，后端失败时回滚
    const prevMessages = get().messages;
    const prevSelected = get().selectedMessage;
    set((state) => ({
      messages: state.messages.filter((m) => m.uid !== message.uid),
      selectedMessage:
        state.selectedMessage?.uid === message.uid ? null : state.selectedMessage,
      error: null,
    }));
    try {
      await api.deleteMessage(gatewayUrl, account, message.folder, message.uid);
      // 后端成功后用本地数据库刷新未读数（不触发 IMAP）
      await get().refreshUnreadCounts(account.id);
    } catch (e) {
      // 回滚
      set({ messages: prevMessages, selectedMessage: prevSelected, error: String(e) });
      throw e;
    }
  },

  markAllRead: async (gatewayUrl, accountId, mailbox) => {
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) return;
    // 乐观更新：先本地标记已读
    const prevMessages = get().messages;
    set((state) => ({
      messages: state.messages.map((m) =>
        m.folder === mailbox && m.accountId === accountId
          ? { ...m, isRead: true }
          : m,
      ),
      error: null,
    }));
    try {
      await api.markAllRead(gatewayUrl, account, mailbox);
      await get().refreshUnreadCounts(accountId);
    } catch (e) {
      set({ messages: prevMessages, error: String(e) });
      throw e;
    }
  },

  emptyFolder: async (gatewayUrl, accountId, mailbox) => {
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) return;
    // 乐观更新：先清空本地列表
    const prevMessages = get().messages;
    const prevSelected = get().selectedMessage;
    set((state) => ({
      messages: state.selectedFolder === mailbox ? [] : state.messages,
      selectedMessage:
        state.selectedMessage?.folder === mailbox ? null : state.selectedMessage,
      error: null,
    }));
    try {
      await api.emptyFolder(gatewayUrl, account, mailbox);
      await get().refreshUnreadCounts(accountId);
    } catch (e) {
      set({ messages: prevMessages, selectedMessage: prevSelected, error: String(e) });
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

  checkGatewayHealth: async (gatewayUrl) => {
    if (!gatewayUrl) {
      if (get().isOnline) set({ isOnline: false });
      return false;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(`${gatewayUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      const online = resp.ok;
      const wasOffline = !get().isOnline;
      set({ isOnline: online });
      // 从离线恢复到在线时，自动同步所有账号
      if (online && wasOffline) {
        void get().syncAllAccounts(gatewayUrl, true);
      }
      return online;
    } catch {
      if (get().isOnline) set({ isOnline: false });
      return false;
    }
  },
}));

/**
 * 解析地址字符串，用通讯录名称替换邮箱显示。
 * 支持 "Name <email>" 和纯 email 两种格式，逗号分隔多个地址。
 * 有名称（含通讯录）时只显示名称，否则显示邮箱。
 */
export function resolveAddressDisplay(
  raw: string | null | undefined,
  contactsByEmail: Record<string, string>,
): string {
  if (!raw) return "";
  // 按逗号分割，但不分割尖括号内的逗号
  const parts: string[] = [];
  let current = "";
  let inAngle = false;
  for (const ch of raw) {
    if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    if (ch === "," && !inAngle) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  const resolved = parts.map((part) => {
    // 提取 Name <email> 格式
    const match = part.match(/^([^<]*?)\s*<([^>]+)>$/);
    if (match) {
      const name = match[1].trim().replace(/^["']|["']$/g, "");
      if (name) return name;
      const email = match[2].trim();
      const contactName = contactsByEmail[email.toLowerCase()];
      if (contactName) return contactName;
      return email;
    }
    // 纯 email
    const email = part.trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const contactName = contactsByEmail[email.toLowerCase()];
      if (contactName) return contactName;
      return email;
    }
    return part;
  });

  return resolved.join(", ");
}

/** 解析单个地址，返回显示名（优先 fromName，其次通讯录，最后 email） */
export function resolveSenderDisplay(
  fromName: string | null | undefined,
  fromAddress: string,
  contactsByEmail: Record<string, string>,
): string {
  const name = (fromName || "").trim();
  if (name) return name;
  const addr = (fromAddress || "").trim();
  if (!addr) return "(未知发件人)";
  const contactName = contactsByEmail[addr.toLowerCase()];
  if (contactName) return contactName;
  return addr;
}
