import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Check, Copy, FileText, Menu, X } from "lucide-react";
import { DeleteConfirm } from "@/components/DeleteConfirm";
import { RenameChatDialog } from "@/components/RenameChatDialog";
import { AppRail } from "@/components/shell/AppRail";
import { SessionListPanel } from "@/components/shell/SessionListPanel";
import { AgentManagementView } from "@/components/agents/AgentManagementView";
import {
  NewRoomDialog,
} from "@/components/shell/ConversationDialogs";
import { MONA_AGENT_ID } from "@/components/room/AgentAvatar";
import { invalidateAgents, useAgents } from "@/components/room/useAgents";
import { useMaterialsOpenStore } from "@/lib/materials-open-store";
import { SessionSearchDialog } from "@/components/SessionSearchDialog";
import { QuickAskWindow } from "@/components/quick/QuickAskWindow";
import { SettingsView } from "@/components/settings/SettingsView";
import { ThreadShell } from "@/components/thread/ThreadShell";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AppTitleBar } from "@/components/workspace/AppTitleBar";
import { BrowserTabView } from "@/components/browser/BrowserTabView";
import { HistoryPage } from "@/components/browser/HistoryPage";
import { DownloadsPage } from "@/components/browser/DownloadsPage";
import { useBrowserTabs } from "@/hooks/useBrowserTabs";
import { TerminalView } from "@/components/terminal/TerminalView";
import { useTerminalStore } from "@/components/terminal/store/terminalStore";
import { useDbStore } from "@/components/db/store/dbStore";
import { useMdReaderStore } from "@/components/md-reader/mdReaderStore";

import { useSessions } from "@/hooks/useSessions";
import { useDeferredTitleRefresh } from "@/hooks/useDeferredTitleRefresh";
import {
  isSessionUnread,
  markAllSessionsRead,
  markSessionRead,
  useSidebarState,
} from "@/hooks/useSidebarState";
import { ThemeProvider, useTheme } from "@/hooks/useTheme";
import { LicenseProvider, useLicense } from "@/hooks/useLicense";
import { LoginDialog } from "@/components/LoginDialog";
import { UpdateNotification } from "@/components/UpdateNotification";
import { useEmailStore } from "@/components/email/store/emailStore";
import { useTodoStore } from "@/components/schedule/todoStore";
import { cn } from "@/lib/utils";
import {
  deriveWsUrl,
  fetchBootstrap,
  loadSavedSecret,
  resetGatewayBaseUrl,
  saveSecret,
} from "@/lib/bootstrap";
import { fetchSettings, removeProject, resetApiBase } from "@/lib/api";
import { browserHideTabsExcept } from "@/lib/browser-ipc";
import { deriveTitle } from "@/lib/format";
import { MonaClient } from "@/lib/mona-client";
import { ClientProvider, useClientOptional, type RuntimeStatus } from "@/providers/ClientProvider";
import type { ChatSummary } from "@/lib/types";
import { isTauri, getGatewayStatus, startGateway, getServicesStatus, startServices, getDesktopSettings, readGatewayLog, createNoteFromChat, revealItemInDir, openPathWithSystemApp, type GatewayLog, type SidebarShortcuts, type SidebarModuleConfig, type UpdateCheckResult } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type BootState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "auth"; failed?: boolean }
  | {
      status: "ready";
      client: MonaClient;
      token: string;
      tokenExpiresAt: number;
      modelName: string | null;
    };

const SIDEBAR_STORAGE_KEY = "mona-webui.sidebar";
const COMPLETED_RUNS_STORAGE_KEY = "mona-webui.sidebar.completed-runs.v1";
const RESTART_STARTED_KEY = "mona-webui.restartStartedAt";
const TOKEN_REFRESH_MARGIN_MS = 30_000;
const TOKEN_REFRESH_MIN_DELAY_MS = 5_000;
type ShellView = "chat" | "settings" | "note" | "ssh" | "db" | "doc" | "email" | "schedule" | "system" | "profile" | "stock";

export function openNewBrowserTab(
  setView: (view: ShellView) => void,
  addEmptyTab: () => void,
) {
  setView("chat");
  addEmptyTab();
}

interface QueuedAgentPrompt {
  id: string;
  content: string;
}

const NotesView = lazy(() =>
  import("@/components/notes/NotesView").then((module) => ({
    default: module.NotesView,
  })),
);

const DbClientView = lazy(() =>
  import("@/components/db/DbClientView").then((module) => ({
    default: module.DbClientView,
  })),
);

const DocMakerView = lazy(() =>
  import("@/components/doc/DocMakerView").then((module) => ({
    default: module.DocMakerView,
  })),
);

const MdFileView = lazy(() =>
  import("@/components/md-reader/MdFileView").then((module) => ({
    default: module.MdFileView,
  })),
);

const EmailClientView = lazy(() =>
  import("@/components/email/EmailClientView").then((module) => ({
    default: module.EmailClientView,
  })),
);

const PlanningView = lazy(() =>
  import("@/components/schedule/PlanningView").then((module) => ({
    default: module.PlanningView,
  })),
);

const ProfileView = lazy(() =>
  import("@/components/profile/ProfileView").then((module) => ({
    default: module.ProfileView,
  })),
);

const StockView = lazy(() =>
  import("@/components/stock/StockView").then((module) => ({
    default: module.StockView,
  })),
);

const SystemView = lazy(() =>
  import("@/components/system/SystemView").then((module) => ({
    default: module.SystemView,
  })),
);

const ComposeWindow = lazy(() =>
  import("@/components/email/ComposeWindow").then((module) => ({
    default: module.ComposeWindow,
  })),
);

const MailPreviewWindow = lazy(() =>
  import("@/components/email/MailPreviewWindow").then((module) => ({
    default: module.MailPreviewWindow,
  })),
);

const NotificationWindow = lazy(() =>
  import("@/components/notification/NotificationWindow").then((module) => ({
    default: module.NotificationWindow,
  })),
);

const DownloadsWindow = lazy(() =>
  import("@/components/browser/DownloadsWindow").then((module) => ({
    default: module.DownloadsWindow,
  })),
);

function bootstrapTokenExpiresAt(expiresInSeconds: number): number {
  return Date.now() + Math.max(0, expiresInSeconds) * 1000;
}

function tokenRefreshDelayMs(expiresAt: number): number {
  const remaining = Math.max(0, expiresAt - Date.now());
  const margin = Math.min(
    TOKEN_REFRESH_MARGIN_MS,
    Math.max(1_000, remaining / 2),
  );
  return Math.max(TOKEN_REFRESH_MIN_DELAY_MS, remaining - margin);
}

function isQuickAskRoute(): boolean {
  return typeof window !== "undefined" && window.location.hash.startsWith("#/quick-ask");
}

function isComposeRoute(): boolean {
  return typeof window !== "undefined" && window.location.hash.startsWith("#/compose");
}

function isMailPreviewRoute(): boolean {
  return typeof window !== "undefined" && window.location.hash.startsWith("#/mailview");
}

function isNotificationRoute(): boolean {
  return typeof window !== "undefined" && window.location.hash.startsWith("#/notification");
}

function isDownloadsRoute(): boolean {
  return typeof window !== "undefined" && window.location.hash.startsWith("#/browser-downloads");
}

function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");

  let key = event.key;
  if (/^[a-z]$/i.test(key)) {
    key = key.toUpperCase();
  } else if (key === " ") {
    key = "Space";
  } else {
    const aliases: Record<string, string> = {
      Escape: "Esc",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
    };
    key = aliases[key] ?? key;
  }

  if (!key || key.length > 12) return null;
  parts.push(key);
  return parts.join("+");
}

function AuthForm({
  failed,
  onSecret,
}: {
  failed: boolean;
  onSecret: (secret: string) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const secret = value.trim();
    if (!secret) return;
    setSubmitting(true);
    onSecret(secret);
  };

  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-4"
      >
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-title-sm">{t("app.auth.title")}</p>
          <p className="text-body text-muted-foreground">{t("app.auth.hint")}</p>
        </div>
        {failed && (
          <p className="text-center text-body text-destructive">
            {t("app.auth.invalid")}
          </p>
        )}
        <Input
          type="password"
          placeholder={t("app.auth.placeholder")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={submitting}
          autoFocus
        />
        <Button
          type="submit"
          className="w-full"
          disabled={!value.trim() || submitting}
        >
          {t("app.auth.submit")}
        </Button>
      </form>
    </div>
  );
}

function readSidebarOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (raw === null) return true;
    return raw === "1";
  } catch {
    return true;
  }
}

function readCompletedRunChatIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COMPLETED_RUNS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function writeCompletedRunChatIds(chatIds: Set<string>): void {
  try {
    window.localStorage.setItem(
      COMPLETED_RUNS_STORAGE_KEY,
      JSON.stringify(Array.from(chatIds)),
    );
  } catch {
    // ignore storage errors (private mode, etc.)
  }
}

export default function App() {
  const [state, setState] = useState<BootState>({ status: "loading" });
  const bootstrapSecretRef = useRef("");

  const bootstrapWithSecret = useCallback(
    (secret: string) => {
      let cancelled = false;
      (async () => {
        setState({ status: "loading" });
        try {
          const boot = await fetchBootstrap("", secret);
          if (cancelled) return;
          if (secret) saveSecret(secret);
          const url = await deriveWsUrl(boot.ws_path, boot.token);
          let client: MonaClient;
          client = new MonaClient({
            url,
            onReauth: async () => {
              try {
                const refreshed = await fetchBootstrap("", bootstrapSecretRef.current);
                const refreshedUrl = await deriveWsUrl(refreshed.ws_path, refreshed.token);
                const tokenExpiresAt = bootstrapTokenExpiresAt(refreshed.expires_in);
                setState((current) =>
                  current.status === "ready" && current.client === client
                    ? {
                        ...current,
                        token: refreshed.token,
                        tokenExpiresAt,
                        modelName: refreshed.model_name ?? current.modelName,
                      }
                    : current,
                );
                return refreshedUrl;
              } catch {
                return null;
              }
            },
          });
          bootstrapSecretRef.current = secret;
          client.connect();
          setState({
            status: "ready",
            client,
            token: boot.token,
            tokenExpiresAt: bootstrapTokenExpiresAt(boot.expires_in),
            modelName: boot.model_name ?? null,
          });
        } catch (e) {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : String(e ?? "");
          if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
            setState({ status: "auth", failed: true });
          } else {
            setState({ status: "error", message: msg });
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    },
    [],
  );

  useEffect(() => {
    if (state.status !== "ready") return;
    const client = state.client;
    const timer = window.setTimeout(async () => {
      try {
        const boot = await fetchBootstrap("", bootstrapSecretRef.current);
        const url = await deriveWsUrl(boot.ws_path, boot.token);
        const tokenExpiresAt = bootstrapTokenExpiresAt(boot.expires_in);
        client.updateUrl(url);
        setState((current) =>
          current.status === "ready" && current.client === client
            ? {
                ...current,
                token: boot.token,
                tokenExpiresAt,
                modelName: boot.model_name ?? current.modelName,
              }
            : current,
        );
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
          setState({ status: "auth", failed: true });
        }
      }
    }, tokenRefreshDelayMs(state.tokenExpiresAt));
    return () => window.clearTimeout(timer);
  }, [state]);

  const connectRuntime = useCallback(() => {
    if (!isTauri()) {
      const saved = loadSavedSecret();
      return bootstrapWithSecret(saved);
    }

    // Clear cached API base URLs so we re-resolve the gateway port fresh.
    // This prevents stale caches from causing silent request failures
    // after a gateway restart with a potentially different port.
    resetApiBase();
    resetGatewayBaseUrl();

    let cancelled = false;
    (async () => {
      setState({ status: "loading" });
      try {
        try {
          const gwStatus = await getGatewayStatus();
          if (!gwStatus.running) {
            await startGateway();
          }
        } catch {
          try {
            await startGateway();
          } catch (startErr) {
            if (cancelled) return;
            const errMsg = startErr instanceof Error ? startErr.message : String(startErr);
            setState({ status: "error", message: `Gateway 启动失败: ${errMsg}` });
            return;
          }
        }

        const saved = loadSavedSecret();
        bootstrapWithSecret(saved);
      } catch (e) {
        if (cancelled) return;
        setState({ status: "error", message: (e as Error).message });
      }
    })();
    return () => { cancelled = true; };
  }, [bootstrapWithSecret]);

  useEffect(() => {
    return connectRuntime();
  }, [connectRuntime]);

  const runtimeStatus: RuntimeStatus =
    state.status === "loading" ? "connecting" : state.status;
  const client = state.status === "ready" ? state.client : null;
  const token = state.status === "ready" ? state.token : "";
  const modelName = state.status === "ready" ? state.modelName : null;
  const errorMessage = state.status === "error" ? state.message : null;

  const handleModelNameChange = (modelName: string | null) => {
    setState((current) =>
      current.status === "ready" ? { ...current, modelName } : current,
    );
  };

  const quickAskRoute = isQuickAskRoute();
  const composeRoute = isComposeRoute();
  const mailPreviewRoute = isMailPreviewRoute();
  const notificationRoute = isNotificationRoute();
  const downloadsRoute = isDownloadsRoute();

  return (
    <ClientProvider
      client={client}
      token={token}
      modelName={modelName}
      runtimeStatus={runtimeStatus}
      runtimeError={errorMessage}
    >
      {downloadsRoute ? (
        <Suspense fallback={null}>
          <DownloadsWindow />
        </Suspense>
      ) : notificationRoute ? (
        <Suspense fallback={null}>
          <NotificationWindow />
        </Suspense>
      ) : composeRoute ? (
        <Suspense fallback={<ModuleLoading title="正在打开写邮件" />}>
          <ComposeWindow />
        </Suspense>
      ) : mailPreviewRoute ? (
        <Suspense fallback={<ModuleLoading title="正在打开邮件" />}>
          <MailPreviewWindow />
        </Suspense>
      ) : quickAskRoute ? (
        client ? <QuickAskWindow /> : null
      ) : (
        <LicenseProvider>
          <Shell
            onModelNameChange={handleModelNameChange}
            onRetryConnection={connectRuntime}
            onSubmitAuth={(s) => bootstrapWithSecret(s)}
            authFailed={state.status === "auth" && !!state.failed}
          />
        </LicenseProvider>
      )}
    </ClientProvider>
  );
}

function Shell({
  onModelNameChange,
  onRetryConnection,
  onSubmitAuth,
  authFailed,
}: {
  onModelNameChange: (modelName: string | null) => void;
  onRetryConnection: () => void;
  onSubmitAuth: (secret: string) => void;
  authFailed: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { client, runtimeStatus, runtimeError, token } = useClientOptional();
  const { theme, toggle } = useTheme();
  const { licenseActive, loggedIn, pricingConfig } = useLicense();
  const [promoClosed, setPromoClosed] = useState(false);
  const promo = pricingConfig?.promoTrial;
  const promoKey = promo?.end_at ? `mona_promo_closed_${promo.end_at}` : "mona_promo_closed";
  const promoVisible = !!promo?.enabled && !promoClosed;
  const promoText = useMemo(() => {
    if (!promo?.enabled) return "";
    let text = `🎉 限时活动：注册即送 ${promo.days} 天试用`;
    if (promo.end_at) {
      const d = new Date(promo.end_at);
      if (!isNaN(d.getTime())) {
        text += ` · 截止 ${d.toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}`;
      }
    }
    return text;
  }, [promo]);
  useEffect(() => {
    if (!promo?.enabled) return;
    try {
      if (localStorage.getItem(promoKey) === "1") setPromoClosed(true);
    } catch { /* ignore */ }
  }, [promoKey, promo]);
  const handleClosePromo = () => {
    setPromoClosed(true);
    try { localStorage.setItem(promoKey, "1"); } catch { /* ignore */ }
  };
  const { sessions, loading, loaded: sessionsLoaded, refresh, createChat, deleteChat } = useSessions();
  const {
    state: sidebarState,
    loading: sidebarStateLoading,
    update: updateSidebarState,
  } =
    useSidebarState(sessions, sessionsLoaded);
  const agentsById = useAgents(token);
  const partnerAgents = useMemo(() => [...agentsById.values()], [agentsById]);
  useEffect(() => {
    if (!client) return;
    return client.onAgentsUpdated(() => invalidateAgents());
  }, [client]);
  const [roomDialogOpen, setRoomDialogOpen] = useState(false);
  const [roomInitialAgents, setRoomInitialAgents] = useState<string[] | undefined>(undefined);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [pendingDirectAgentId, setPendingDirectAgentId] = useState<string | null>(null);
  const [managedAgentId, setManagedAgentId] = useState<string | null>(null);
  const [createNoteOnOpen, setCreateNoteOnOpen] = useState(false);
  const [view, setView] = useState<ShellView>(
    new URLSearchParams(window.location.search).get("noteId") ? "note" : "chat",
  );
  // 首次进入 note 后保持挂载，让网页转笔记可在切换模块后继续完成。
  const [noteMounted, setNoteMounted] = useState(view === "note");
  useEffect(() => {
    if (view === "note") setNoteMounted(true);
  }, [view]);
  // 首次进入 system 后保持挂载，避免存储扫描过程中切走再切回丢失状态
  const [systemMounted, setSystemMounted] = useState(view === "system");
  useEffect(() => {
    if (view === "system") setSystemMounted(true);
  }, [view]);
  const [settingsInitialSection, setSettingsInitialSection] = useState<string | undefined>(undefined);
  const {
    tabs: browserTabs,
    activeTabId: activeBrowserTabId,
    activeTab: activeBrowserTab,
    addEmptyTab,
    addMdReaderTab,
    navigateToUrl,
    closeTab: closeBrowserTab,
    switchTab: switchBrowserTab,
    goBack,
    goForward,
    reload,
    updateTabUrl,
    browserFullscreen,
    toggleFullscreen,
    exitFullscreen,
    reorderTabs,
    togglePinTab,
    closeOtherTabs,
    closeTabsToRight,
    duplicateTab,
    openHistoryPage,
    openDownloadsPage,
    toggleMute,
    toggleAdBlock,
    toggleDarkMode,
    openDevtools,
  } = useBrowserTabs();
  const mdReaderTabs = useMdReaderStore((s) => s.tabs);
  const saveMdAsNote = useCallback((tabId: string) => {
    const tab = browserTabs.find((t) => t.id === tabId);
    if (!tab || tab.type !== "md-reader" || !tab.mdFilePath) return;
    const mdTab = mdReaderTabs.find((t) => t.filePath === tab.mdFilePath);
    const content = mdTab?.content ?? "";
    const title = tab.title.replace(/\.md$/i, "") || "未命名笔记";
    createNoteFromChat(title, content).catch((err) => {
      console.error("[saveMdAsNote] failed:", err);
    });
  }, [browserTabs, mdReaderTabs]);
  const revealMdInExplorer = useCallback((tabId: string) => {
    const tab = browserTabs.find((t) => t.id === tabId);
    if (!tab || tab.type !== "md-reader" || !tab.mdFilePath) return;
    void revealItemInDir(tab.mdFilePath);
  }, [browserTabs]);
  const [desktopSidebarOpen, setDesktopSidebarOpen] =
    useState<boolean>(readSidebarOpen);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    key: string;
    label: string;
  } | null>(null);
  const [pendingRename, setPendingRename] = useState<{
    key: string;
    label: string;
  } | null>(null);
  const restartSawDisconnectRef = useRef(false);
  const [restartToast, setRestartToast] = useState<string | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [runningChatIds, setRunningChatIds] = useState<Set<string>>(() => new Set());
  const [completedChatIds, setCompletedChatIds] = useState<Set<string>>(readCompletedRunChatIds);
  const [queuedAgentPrompt, setQueuedAgentPrompt] = useState<QueuedAgentPrompt | null>(null);
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);
  const [loginDialogInitialView, setLoginDialogInitialView] = useState<"login" | "subscribe">("login");
  const [loginDialogSubscribeIntent, setLoginDialogSubscribeIntent] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<UpdateCheckResult | null>(null);
  const [updateDialogTrigger, setUpdateDialogTrigger] = useState(0);
  const [sidebarModules, setSidebarModules] = useState<SidebarModuleConfig[] | null>(null);
  // 股票模块开关（StockConfig.enabled）：null=未加载；关闭时隐藏导航入口与 StockView
  const [stockEnabled, setStockEnabled] = useState<boolean | null>(null);
  // 行情轮询间隔（StockConfig.quote_refresh_sec，秒）：null=未加载用默认 30s
  const [stockQuoteRefreshSec, setStockQuoteRefreshSec] = useState<number | null>(null);
  // 自动复盘配置（与股票模块开关独立）
  const [stockAutoReviewEnabled, setStockAutoReviewEnabled] = useState(false);
  // 复盘时间/范围（StockConfig.review_time/review_scope，股票工作台 Hero 展示）
  const [stockReviewTime, setStockReviewTime] = useState<string | null>(null);
  const [stockReviewScope, setStockReviewScope] = useState<"all" | "focus" | null>(null);
  // 复盘通知点击聚焦的 runId（T20）：StockView 消费后清空
  const [stockFocusRunId, setStockFocusRunId] = useState<string | null>(null);
  // 私聊确认卡带入的标的（T22d）：StockView 自选命中后自动启动深度投研
  const [stockAutoRunSymbol, setStockAutoRunSymbol] = useState<string | null>(null);
  const runningChatIdsRef = useRef<Set<string>>(new Set());
  const sidebarShortcutsRef = useRef<SidebarShortcuts>({
    mona: "Alt+1",
    note: "Alt+2",
    ssh: "Alt+3",
    email: "Alt+4",
    schedule: "Alt+5",
    db: "Alt+6",
  });

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => {
      if (!e.matches) setDesktopSidebarOpen(false);
    };
    mql.addEventListener("change", handler);
    if (!mql.matches) setDesktopSidebarOpen(false);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // 全局邮件自动同步 + IMAP IDLE 实时推送
  // 策略：gateway 就绪后首次静默同步 → 启动 IDLE 实时监听 → 兜底轮询 10 分钟
  useEffect(() => {
    let cancelled = false;
    let intervalId = 0;
    let ws: WebSocket | null = null;
    let wsReconnectTimer = 0;
    const loadAccounts = useEmailStore.getState().loadAccounts;
    const syncAllAccounts = useEmailStore.getState().syncAllAccounts;
    const startAllIdle = useEmailStore.getState().startAllIdle;
    const stopAllIdle = useEmailStore.getState().stopAllIdle;

    const connectIdleWs = (gatewayUrl: string) => {
      if (cancelled || !gatewayUrl) return;
      const wsUrl = `${gatewayUrl.replace("http", "ws")}/email/idle/ws`;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        return;
      }
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "new-mail") {
            // IDLE 收到新邮件通知，触发同步（非静默，会弹通知）
            // eslint-disable-next-line no-console
            console.log("[email] IDLE new-mail event", data.accountId);
            void syncAllAccounts(gatewayUrl, false);
          }
        } catch {
          // 忽略解析错误
        }
      };
      ws.onclose = () => {
        // 断线重连（5 秒后），保证 IDLE 事件不丢失
        if (cancelled) return;
        wsReconnectTimer = window.setTimeout(() => connectIdleWs(gatewayUrl), 5000);
      };
      ws.onerror = () => {
        // 错误时关闭，触发 onclose 重连
        try { ws?.close(); } catch { /* ignore */ }
      };
    };

    void (async () => {
      try {
        // 轮询等待 services HTTP 端口就绪（services 启动可能比 Shell 挂载晚）
        let gatewayUrl = "";
        for (let i = 0; i < 60; i++) {
          if (cancelled) return;
          let status = await getServicesStatus();
          if (!status.running && i === 0) {
            try {
              await startServices();
              status = await getServicesStatus();
            } catch {
              // fall through — 继续轮询等待
            }
          }
          if (status.port) {
            gatewayUrl = `http://127.0.0.1:${status.port}`;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        // eslint-disable-next-line no-console
        console.log("[email] global sync ready", gatewayUrl);
        if (cancelled || !gatewayUrl) return;
        await loadAccounts();
        if (cancelled) return;
        // 启动 IMAP IDLE 实时监听（秒级推送）
        // bg sync 会在启动 30s 后自动全量同步 INBOX + 其他文件夹，无需此处冗余 syncAllAccounts
        await startAllIdle(gatewayUrl);
        // 连接 WebSocket 接收 IDLE 事件
        connectIdleWs(gatewayUrl);
        // 兜底轮询：IDLE 可能因网络断开失效，每 10 分钟兜底同步一次
        intervalId = window.setInterval(() => {
          // eslint-disable-next-line no-console
          console.log("[email] scheduled fallback sync");
          void syncAllAccounts(gatewayUrl, false);
        }, 10 * 60 * 1000);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[email] global sync init failed", e);
      }
    })();
    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
      if (wsReconnectTimer) window.clearTimeout(wsReconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        try { ws.close(); } catch { /* ignore */ }
      }
      // 停止所有 IDLE 监听
      void (async () => {
        try {
          const status = await getServicesStatus();
          if (status.port) {
            await stopAllIdle(`http://127.0.0.1:${status.port}`);
          }
        } catch {
          // 忽略
        }
      })();
    };
  }, []);

  // 全局初始化计划收集箱数量（用于主菜单“计划”角标）
  // 策略：services 就绪后加载 todos + 待确认邮件日程，并每 5 分钟轮询刷新
  useEffect(() => {
    let cancelled = false;
    let intervalId = 0;
    const { loadAll, loadPendingSchedules } = useTodoStore.getState();

    const refresh = async () => {
      try {
        await Promise.all([loadAll(), loadPendingSchedules()]);
      } catch {
        // silent — 角标非关键功能
      }
    };

    void (async () => {
      // 轮询等待 services HTTP 端口就绪
      for (let i = 0; i < 60; i++) {
        if (cancelled) return;
        const status = await getServicesStatus();
        if (status.port) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (cancelled) return;
      await refresh();
      // 每 5 分钟兜底刷新一次，保证收集箱数量同步
      intervalId = window.setInterval(refresh, 5 * 60 * 1000);
    })();

    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, []);

  // 通知点击后窗口获得焦点时跳转到邮件页面
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const win = getCurrentWindow();
        unlisten = await win.onFocusChanged(({ payload: focused }) => {
          if (!focused) return;
          void invoke<boolean>("check_and_clear_pending_mail").then((pending) => {
            if (pending) {
              setView("email");
            }
          });
        });
      } catch {
        // 非桌面环境忽略
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_STORAGE_KEY,
        desktopSidebarOpen ? "1" : "0",
      );
    } catch {
      // ignore storage errors (private mode, etc.)
    }
  }, [desktopSidebarOpen]);

  useEffect(() => {
    writeCompletedRunChatIds(completedChatIds);
  }, [completedChatIds]);

  const activeSession = useMemo<ChatSummary | null>(() => {
    if (!activeKey) return null;
    const existing = sessions.find((s) => s.key === activeKey);
    if (existing) return existing;
    const quickChatId = activeKey.startsWith("websocket:")
      ? activeKey.slice("websocket:".length)
      : "";
    if (!quickChatId) return null;
    const now = new Date().toISOString();
    return {
      key: activeKey,
      channel: "websocket",
      chatId: quickChatId,
      createdAt: now,
      updatedAt: now,
      title: "",
      preview: "",
    };
  }, [sessions, activeKey]);
  const runningChatIdList = useMemo(() => Array.from(runningChatIds), [runningChatIds]);
  const unreadSessionKeys = useMemo(
    () => sessions
      .filter((session) => isSessionUnread(
        session,
        sidebarState.last_read_at_by_key[session.key],
      ))
      .map((session) => session.key),
    [sessions, sidebarState.last_read_at_by_key],
  );
  const onMarkAllRead = useCallback(() => {
    void updateSidebarState((current) => markAllSessionsRead(current, sessions));
  }, [sessions, updateSidebarState]);
  const messageAttentionCount = useMemo(() => {
    const attentionKeys = new Set(unreadSessionKeys);
    for (const session of sessions) {
      if (session.waitingApproval) attentionKeys.add(session.key);
    }
    return attentionKeys.size;
  }, [sessions, unreadSessionKeys]);

  useEffect(() => {
    if (
      sidebarStateLoading
      || !activeSession?.previewAt
      || activeBrowserTab.type !== "mona"
      || view !== "chat"
      || !isSessionUnread(
        activeSession,
        sidebarState.last_read_at_by_key[activeSession.key],
      )
    ) {
      return;
    }

    const markIfVisible = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      void updateSidebarState((current) =>
        markSessionRead(current, activeSession.key, activeSession.previewAt),
      );
    };

    markIfVisible();
    window.addEventListener("focus", markIfVisible);
    document.addEventListener("visibilitychange", markIfVisible);
    return () => {
      window.removeEventListener("focus", markIfVisible);
      document.removeEventListener("visibilitychange", markIfVisible);
    };
  }, [
    activeBrowserTab.type,
    activeSession,
    sidebarState.last_read_at_by_key,
    sidebarStateLoading,
    updateSidebarState,
    view,
  ]);

  useEffect(() => {
    if (loading) return;
    const knownChatIds = new Set(sessions.map((session) => session.chatId));
    setCompletedChatIds((current) => {
      const next = new Set(
        Array.from(current).filter((chatId) => knownChatIds.has(chatId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [loading, sessions]);

  useEffect(() => {
    if (loading || !client) return;
    const activeRunIds = sessions
      .filter((session) => typeof session.runStartedAt === "number")
      .map((session) => session.chatId);
    if (activeRunIds.length === 0) return;

    for (const chatId of activeRunIds) {
      client.attach(chatId);
    }
    setRunningChatIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const chatId of activeRunIds) {
        if (!next.has(chatId)) changed = true;
        next.add(chatId);
      }
      if (!changed) return current;
      runningChatIdsRef.current = next;
      return next;
    });
    setCompletedChatIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const chatId of activeRunIds) {
        if (next.delete(chatId)) changed = true;
      }
      return changed ? next : current;
    });
  }, [client, loading, sessions]);

  const toggleSidebar = useCallback(() => {
    const isDesktop =
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 1024px)").matches;
    if (isDesktop) {
      setDesktopSidebarOpen((v) => !v);
    } else {
      setMobileSidebarOpen((v) => !v);
    }
  }, []);

  const switchToMonaTab = useCallback(() => {
    switchBrowserTab("mona");
  }, [switchBrowserTab]);

  const handleBrowserTabClick = useCallback((id: string) => {
    if (id !== "mona") setView("chat");
    switchBrowserTab(id);
  }, [switchBrowserTab]);

  const onGoHome = useCallback(() => {
    setManagedAgentId(null);
    setView("chat");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, [switchToMonaTab]);

  const onOpenSubscribe = useCallback(() => {
    setLoginDialogInitialView(loggedIn ? "subscribe" : "login");
    setLoginDialogSubscribeIntent(!loggedIn);
    setLoginDialogOpen(true);
    setMobileSidebarOpen(false);
  }, [loggedIn]);

  const onOpenNote = useCallback(() => {
    setCreateNoteOnOpen(false);
    setView("note");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, [switchToMonaTab]);

  // 聊天中的资料引用链接（mona:material?...）被点击：切到笔记模块，
  // 由 NotesView/MaterialsPreview 继续消费请求并定位到引用位置。
  const pendingMaterialOpen = useMaterialsOpenStore((s) => s.pending);
  useEffect(() => {
    if (!pendingMaterialOpen) return;
    setCreateNoteOnOpen(false);
    setView("note");
    switchToMonaTab();
  }, [pendingMaterialOpen, switchToMonaTab]);

  const onCreateNote = useCallback(() => {
    setCreateNoteOnOpen(true);
    setView("note");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, [switchToMonaTab]);

  const onOpenSSH = useCallback(() => {
    setView("ssh");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, [switchToMonaTab]);

  const onOpenSSHAndNew = useCallback(() => {
    setView("ssh");
    switchToMonaTab();
    setMobileSidebarOpen(false);
    requestAnimationFrame(() => {
      useTerminalStore.getState().setNewConnectionDialogOpen(true);
    });
  }, [switchToMonaTab]);

  const onOpenDb = useCallback(() => {
    setView("db");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, [switchToMonaTab]);

  const onOpenDbAndNew = useCallback(() => {
    setView("db");
    switchToMonaTab();
    setMobileSidebarOpen(false);
    requestAnimationFrame(() => {
      useDbStore.getState().setNewConnectionDialogOpen(true);
    });
  }, [switchToMonaTab]);

  const onOpenDoc = useCallback(() => {
    if (!licenseActive) {
      onOpenSubscribe();
      return;
    }
    setView("doc");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, [licenseActive, onOpenSubscribe, switchToMonaTab]);

  const onOpenEmail = useCallback(() => {
    setView("email");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, [switchToMonaTab]);

  const onOpenSchedule = useCallback(() => {
    setView("schedule");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, [switchToMonaTab]);

  const onOpenSystem = useCallback(() => {
    setView("system");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, [switchToMonaTab]);

  const onOpenProfile = useCallback(() => {
    setView("profile");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, [switchToMonaTab]);

  const onOpenStock = useCallback(() => {
    setView("stock");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, [switchToMonaTab]);

  const onCreateChat = useCallback(async (workspace?: string | null) => {
    try {
      const chatId = await createChat(workspace);
      setActiveKey(`websocket:${chatId}`);
      setView("chat");
      switchToMonaTab();
      setMobileSidebarOpen(false);
      return chatId;
    } catch (e) {
      console.error("Failed to create chat", e);
      return null;
    }
  }, [createChat]);

  // Trigger an agent task from a non-chat surface (e.g. settings page banner).
  // Always starts a fresh session so the setup flow has a clean context.
  const onTriggerAgent = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      try {
        const chatId = await createChat();
        setActiveKey(`websocket:${chatId}`);
        setQueuedAgentPrompt({
          id: crypto.randomUUID(),
          content: trimmed,
        });
        setView("chat");
        switchToMonaTab();
        setMobileSidebarOpen(false);
      } catch (e) {
        console.error("Failed to trigger agent task", e);
      }
    },
    [createChat, switchToMonaTab],
  );

  const onNewChat = useCallback(() => {
    setManagedAgentId(null);
    setPendingDirectAgentId(null);
    setActiveKey(null);
    setView("chat");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, []);

  /** Open a direct-agent draft. The actual chat is created on first send. */
  const onStartDirect = useCallback(
    (agentId: string) => {
      if (creatingConversation) return;
      if (agentId === MONA_AGENT_ID) {
        onNewChat();
        return;
      }
      setManagedAgentId(null);
      setPendingDirectAgentId(agentId);
      setActiveKey(null);
      setView("chat");
      switchToMonaTab();
      setMobileSidebarOpen(false);
    },
    [creatingConversation, onNewChat, switchToMonaTab],
  );

  const onCreateDirectChat = useCallback(
    async (agentId: string, workspace?: string | null) => {
      if (creatingConversation || !client) return null;
      setCreatingConversation(true);
      try {
        const chatId = await createChat(workspace);
        await client.createDirectConversation(chatId, agentId);
        await refresh();
        setActiveKey(`websocket:${chatId}`);
        setView("chat");
        switchToMonaTab();
        setMobileSidebarOpen(false);
        setPendingDirectAgentId(null);
        setManagedAgentId(null);
        return chatId;
      } catch (e) {
        console.error("Failed to create direct conversation", e);
        return null;
      } finally {
        setCreatingConversation(false);
      }
    },
    [client, creatingConversation, createChat, refresh, switchToMonaTab],
  );

  /** 创建协作房间：新建会话后调用 createRoom 命令。 */
  const onSubmitRoom = useCallback(
    async (input: { agentIds: string[]; title: string; goal?: string }) => {
      if (creatingConversation || !client) return;
      setCreatingConversation(true);
      try {
        const chatId = await onCreateChat();
        if (!chatId) return;
        await client.createRoom(chatId, input.agentIds, input.title, input.goal);
        await refresh();
        setRoomDialogOpen(false);
      } catch (e) {
        console.error("Failed to create room", e);
      } finally {
        setCreatingConversation(false);
      }
    },
    [client, creatingConversation, onCreateChat, refresh],
  );

  const onOpenNewRoom = useCallback((agentId?: string) => {
    setRoomInitialAgents(agentId ? [agentId] : undefined);
    setRoomDialogOpen(true);
  }, []);

  const onSelectAgent = useCallback((agentId: string) => {
    setManagedAgentId(agentId);
    setPendingDirectAgentId(null);
    setActiveKey(null);
    setView("chat");
    switchToMonaTab();
    setMobileSidebarOpen(false);
  }, [switchToMonaTab]);

  const onSelectChat = useCallback(
    (key: string) => {
      const selectedChatId = sessions.find((session) => session.key === key)?.chatId;
      if (selectedChatId) {
        setCompletedChatIds((current) => {
          if (!current.has(selectedChatId)) return current;
          const next = new Set(current);
          next.delete(selectedChatId);
          return next;
        });
      }
      setManagedAgentId(null);
      setPendingDirectAgentId(null);
      setActiveKey(key);
      setView("chat");
      switchToMonaTab();
      setMobileSidebarOpen(false);
    },
    [sessions, switchToMonaTab],
  );

  const onTogglePin = useCallback(
    (key: string) => {
      void updateSidebarState((current) => {
        const pinned = new Set(current.pinned_keys);
        if (pinned.has(key)) {
          pinned.delete(key);
        } else {
          pinned.add(key);
        }
        return {
          ...current,
          pinned_keys: Array.from(pinned),
        };
      });
    },
    [updateSidebarState],
  );

  const onRequestRename = useCallback((key: string, label: string) => {
    setPendingRename({ key, label });
  }, []);

  const onRequestProjectRename = useCallback((workspace: string, label: string) => {
    setPendingRename({ key: `project:${workspace}`, label });
  }, []);

  const onConfirmRename = useCallback(
    (title: string) => {
      if (!pendingRename) return;
      const key = pendingRename.key;
      setPendingRename(null);
      const cleaned = title.trim();
      if (key.startsWith("project:")) {
        const workspace = key.slice("project:".length);
        void updateSidebarState((current) => {
          const project_names = { ...current.project_names };
          if (cleaned) project_names[workspace] = cleaned;
          else delete project_names[workspace];
          return { ...current, project_names };
        });
        return;
      }
      void updateSidebarState((current) => {
        const titleOverrides = { ...current.title_overrides };
        if (cleaned) {
          titleOverrides[key] = cleaned;
        } else {
          delete titleOverrides[key];
        }
        return {
          ...current,
          title_overrides: titleOverrides,
        };
      });
    },
    [pendingRename, updateSidebarState],
  );

  const onToggleArchive = useCallback(
    (key: string) => {
      void updateSidebarState((current) => {
        const archived = new Set(current.archived_keys);
        const pinned = current.pinned_keys.filter((item) => item !== key);
        if (archived.has(key)) {
          archived.delete(key);
        } else {
          archived.add(key);
        }
        return {
          ...current,
          pinned_keys: pinned,
          archived_keys: Array.from(archived),
        };
      });
      if (activeKey === key && !sidebarState.archived_keys.includes(key)) {
        const archived = new Set([...sidebarState.archived_keys, key]);
        const next = sessions.find((session) => !archived.has(session.key));
        setActiveKey(next?.key ?? null);
      }
    },
    [activeKey, sessions, sidebarState.archived_keys, updateSidebarState],
  );

  const onToggleArchived = useCallback(() => {
    void updateSidebarState((current) => ({
      ...current,
      view: {
        ...current.view,
        show_archived: !current.view.show_archived,
      },
    }));
  }, [updateSidebarState]);

  const onCreateTask = useCallback(
    (workspace: string) => {
      void onCreateChat(workspace);
    },
    [onCreateChat],
  );

  const onRemoveProject = useCallback(
    async (workspace: string) => {
      try {
        await removeProject(workspace, token);
        await updateSidebarState((current) => {
          const project_names = { ...current.project_names };
          delete project_names[workspace];
          return { ...current, project_names };
        });
        await refresh();
      } catch (e) {
        console.error("Failed to remove project", e);
      }
    },
    [token, refresh, updateSidebarState],
  );

  const onOpenProjectFolder = useCallback((workspace: string) => {
    void openPathWithSystemApp(workspace);
  }, []);

  const onOpenSessionSearch = useCallback(() => {
    setMobileSidebarOpen(false);
    setSessionSearchOpen(true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const plainCommandK =
        (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
      if (!plainCommandK) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      onOpenSessionSearch();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenSessionSearch]);

  useEffect(() => {
    if (!isTauri()) return;
    getDesktopSettings().then((s) => {
      if (s.sidebar_shortcuts) {
        sidebarShortcutsRef.current = s.sidebar_shortcuts;
      }
      if (s.sidebar_modules) {
        setSidebarModules(s.sidebar_modules);
      }
      // 启动默认模块：仅在初次启动且没有 ?noteId 深链时应用
      if (!new URLSearchParams(window.location.search).get("noteId")) {
        const dv = typeof s.default_view === "string" ? s.default_view : "";
        const VALID_VIEWS: ShellView[] = ["chat", "note", "doc", "ssh", "email", "schedule", "db", "system", "profile", "stock", "settings"];
        if (dv && VALID_VIEWS.includes(dv as ShellView)) {
          setView(dv as ShellView);
        }
      }
    }).catch(() => {});
  }, []);

  // 股票模块开关 + 行情轮询间隔：启动时拉取一次，并订阅设置页保存后的变更事件
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetchSettings(token)
      .then((payload) => {
        if (cancelled) return;
        setStockEnabled(Boolean(payload.stock?.enabled));
        if (typeof payload.stock?.quote_refresh_sec === "number") {
          setStockQuoteRefreshSec(payload.stock.quote_refresh_sec);
        }
        setStockAutoReviewEnabled(Boolean(payload.stock?.auto_review_enabled));
        if (typeof payload.stock?.review_time === "string") {
          setStockReviewTime(payload.stock.review_time);
        }
        if (payload.stock?.review_scope === "all" || payload.stock?.review_scope === "focus") {
          setStockReviewScope(payload.stock.review_scope);
        }
      })
      .catch(() => {
        if (!cancelled) setStockEnabled(false);
      });
    const onStockSettingsChanged = (
      event: Event,
    ) => {
      const detail = (
        event as CustomEvent<{
          enabled?: boolean;
          quoteRefreshSec?: number;
          reviewTime?: string;
          reviewScope?: "all" | "focus";
          autoReviewEnabled?: boolean;
        }>
      ).detail;
      setStockEnabled(Boolean(detail?.enabled));
      if (typeof detail?.quoteRefreshSec === "number") {
        setStockQuoteRefreshSec(detail.quoteRefreshSec);
      }
      if (typeof detail?.reviewTime === "string") {
        setStockReviewTime(detail.reviewTime);
      }
      if (detail?.reviewScope === "all" || detail?.reviewScope === "focus") {
        setStockReviewScope(detail.reviewScope);
      }
      if (typeof detail?.autoReviewEnabled === "boolean") {
        setStockAutoReviewEnabled(detail.autoReviewEnabled);
      }
    };
    window.addEventListener("mona-stock-settings-changed", onStockSettingsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("mona-stock-settings-changed", onStockSettingsChanged);
    };
  }, [token]);

  // 模块被关闭后仍停留在 stock 视图时（如残留的 default_view）回退到会话
  useEffect(() => {
    if (stockEnabled === false && view === "stock") setView("chat");
  }, [stockEnabled, view]);

  // 私聊确认卡（T22d）：跳转股票工作台并自动启动单股深度投研
  useEffect(() => {
    const onOpenStockEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ symbol?: string }>).detail;
      if (detail?.symbol) setStockAutoRunSymbol(detail.symbol);
      onOpenStock();
    };
    window.addEventListener("mona-open-stock", onOpenStockEvent);
    return () => {
      window.removeEventListener("mona-open-stock", onOpenStockEvent);
    };
  }, [onOpenStock]);

  useEffect(() => {
    if (!isTauri()) return;
    const shortcutToView: Record<string, () => void> = {
      [sidebarShortcutsRef.current.mona]: onNewChat,
      [sidebarShortcutsRef.current.note]: onOpenNote,
      [sidebarShortcutsRef.current.ssh]: onOpenSSH,
      [sidebarShortcutsRef.current.email]: onOpenEmail,
      [sidebarShortcutsRef.current.schedule]: onOpenSchedule,
      [sidebarShortcutsRef.current.db]: onOpenDb,
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcut = shortcutFromKeyboardEvent(event);
      if (!shortcut) return;
      const handler = shortcutToView[shortcut];
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onNewChat, onOpenNote, onOpenSSH, onOpenEmail, onOpenSchedule, onOpenDb]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unlisteners: (() => void)[] = [];
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un1 = await listen("tray-new-note", () => {
        onOpenNote();
      });
      const un2 = await listen("tray-new-ssh", () => {
        onOpenSSHAndNew();
      });
      const un3 = await listen("quick-open-chat", (event) => {
        const payload = event.payload as { chatId?: string } | undefined;
        const chatId = payload?.chatId;
        if (!chatId) return;
        setActiveKey(`websocket:${chatId}`);
        setView("chat");
        switchToMonaTab();
        setMobileSidebarOpen(false);
        void refresh();
      });
      const un4 = await listen<string>("md-file-open", (event) => {
        const filePath = event.payload;
        if (filePath) {
          addMdReaderTab(filePath);
        }
      });
      const un5 = await listen<{ action: string; data?: unknown }>("notification-action", async (event) => {
        const action = event.payload?.action;
        const data = event.payload?.data as
          | { type?: string; accountId?: string; uid?: string; folder?: string; subject?: string }
          | undefined;
        // 邮件通知点击：携带邮件标识时，直接打开独立预览窗口，不唤醒主窗口
        if (action === "open-email" && data?.type === "mail" && data.accountId && data.uid && data.folder) {
          try {
            await invoke("email_open_view_window", {
              payload: {
                accountId: data.accountId,
                uid: data.uid,
                folder: data.folder,
                subject: data.subject,
              },
            });
          } catch (err) {
            console.error("[NotificationAction] 打开邮件预览窗口失败:", err);
          }
          return;
        }
        if (action === "open-email" || action === "open-schedule" || action === "open-stock") {
          try {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            const mainWin = getCurrentWindow();
            await mainWin.show();
            await mainWin.unminimize();
            await mainWin.setFocus();
          } catch {
            // ignore
          }
          if (action === "open-email") onOpenEmail();
          else if (action === "open-schedule") onOpenSchedule();
          else if (action === "open-stock") {
            // 股票复盘通知（T20）：携带 runId 时聚焦对应复盘简报。
            setStockFocusRunId((data as { runId?: string } | undefined)?.runId ?? null);
            onOpenStock();
          }
        }
      });
      if (cancelled) {
        un1();
        un2();
        un3();
        un4();
        un5();
        return;
      }
      unlisteners.push(un1, un2, un3, un4, un5);
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [onOpenNote, onOpenSSHAndNew, refresh, addMdReaderTab, onOpenEmail, onOpenSchedule, onOpenStock]);

  // 监听浏览器 WebView 内的 Ctrl+J/Ctrl+H 快捷键，打开下载/历史记录页面
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<string>("browser-open-internal-page", (event) => {
        if (event.payload === "downloads") openDownloadsPage();
        else if (event.payload === "history") openHistoryPage();
      });
      if (cancelled) unlisten();
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openHistoryPage, openDownloadsPage]);

  // 启动时拉取 pending 的 md 文件（首次启动场景）
  const addMdReaderTabRef = useRef(addMdReaderTab);
  addMdReaderTabRef.current = addMdReaderTab;
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const files = await invoke<string[]>("get_pending_md_files");
        if (cancelled || !files || files.length === 0) return;
        files.forEach((f) => addMdReaderTabRef.current(f));
      } catch (err) {
        console.error("Failed to get pending md files:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSelectSearchResult = useCallback(
    (key: string) => {
      setSessionSearchOpen(false);
      onSelectChat(key);
    },
    [onSelectChat],
  );

  const onOpenSettings = useCallback((section?: string) => {
    setSessionSearchOpen(false);
    setSettingsInitialSection(section);
    setView("settings");
    setMobileSidebarOpen(false);
  }, []);

  const onOpenLogin = useCallback(() => {
    setLoginDialogInitialView("login");
    setLoginDialogSubscribeIntent(false);
    setLoginDialogOpen(true);
    setMobileSidebarOpen(false);
  }, []);

  const onBackToChat = useCallback(() => {
    setView("chat");
    switchToMonaTab();
    setMobileSidebarOpen(false);
    setActiveKey((current) => {
      if (!current) return null;
      if (sessions.some((session) => session.key === current)) return current;
      return sessions[0]?.key ?? null;
    });
  }, [sessions]);

  const onRestart = useCallback(() => {
    if (!client) return;
    const chatId = activeSession?.chatId ?? client.defaultChatId;
    if (!chatId) return;
    restartSawDisconnectRef.current = false;
    setIsRestarting(true);
    try {
      window.localStorage.setItem(RESTART_STARTED_KEY, String(Date.now()));
    } catch {
      // ignore storage errors
    }
    client.sendMessage(chatId, "/restart");
  }, [activeSession?.chatId, client]);

  useEffect(() => {
    if (!client) return;
    return client.onRuntimeModelUpdate((modelName) => {
      onModelNameChange(modelName);
    });
  }, [client, onModelNameChange]);

  useEffect(() => {
    if (!client) return;
    return client.onRunStatus((chatId, startedAt) => {
      if (startedAt != null) {
        const nextRunning = new Set(runningChatIdsRef.current);
        nextRunning.add(chatId);
        runningChatIdsRef.current = nextRunning;
        setRunningChatIds(nextRunning);
        setCompletedChatIds((current) => {
          if (!current.has(chatId)) return current;
          const next = new Set(current);
          next.delete(chatId);
          return next;
        });
        return;
      }

      if (!runningChatIdsRef.current.has(chatId)) return;
      const nextRunning = new Set(runningChatIdsRef.current);
      nextRunning.delete(chatId);
      runningChatIdsRef.current = nextRunning;
      setRunningChatIds(nextRunning);
      setCompletedChatIds((current) => {
        const next = new Set(current);
        next.add(chatId);
        return next;
      });
    });
  }, [client]);

  useEffect(() => {
    if (!client) return;
    return client.onStatus((status) => {
      let startedAt = 0;
      try {
        startedAt = Number(window.localStorage.getItem(RESTART_STARTED_KEY) ?? "0");
      } catch {
        startedAt = 0;
      }
      if (!startedAt) return;
      if (status !== "open") {
        restartSawDisconnectRef.current = true;
        return;
      }
      const elapsedMs = Date.now() - startedAt;
      if (!restartSawDisconnectRef.current && elapsedMs < 1500) return;
      try {
        window.localStorage.removeItem(RESTART_STARTED_KEY);
      } catch {
        // ignore storage errors
      }
      setIsRestarting(false);
      setRestartToast(t("app.restart.completed", { seconds: (elapsedMs / 1000).toFixed(1) }));
      window.setTimeout(() => setRestartToast(null), 3_500);
    });
  }, [client, t]);

  const onTurnEnd = useDeferredTitleRefresh(activeSession, refresh);

  const onConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const key = pendingDelete.key;
    const deletingActive = activeKey === key;
    const currentIndex = sessions.findIndex((s) => s.key === key);
    const fallbackKey = deletingActive
      ? (sessions[currentIndex + 1]?.key ?? sessions[currentIndex - 1]?.key ?? null)
      : activeKey;
    setPendingDelete(null);
    if (deletingActive) setActiveKey(fallbackKey);
    try {
      await deleteChat(key);
    } catch (e) {
      if (deletingActive) setActiveKey(key);
      console.error("Failed to delete session", e);
    }
  }, [pendingDelete, deleteChat, activeKey, sessions]);

  const headerTitle = activeSession
    ? sidebarState.title_overrides[activeSession.key] ||
      activeSession.title ||
      deriveTitle(activeSession.preview, t("chat.newChat"))
    : t("app.brand");

  const isBrowserTabActive = activeBrowserTab.type !== "mona";
  const browserSurfaceVisible =
    view === "chat" && activeBrowserTab.type === "browser" && !loginDialogOpen;
  // 主内容表面：非浏览器原生 WebView 模式时启用圆角裁切与画布边缘。
  // browser 类型标签走原生 WebView，必须边到边布局（见 redesign-plan §4.7）。
  const showContentSurface = !browserFullscreen && activeBrowserTab.type !== "browser";

  useEffect(() => {
    if (!isTauri()) return;
    void browserHideTabsExcept(
      browserSurfaceVisible ? activeBrowserTab.id : undefined,
    ).catch(() => {});
  }, [activeBrowserTab.id, browserSurfaceVisible]);

  useEffect(() => {
    if (view === "settings") {
      document.title = t("app.documentTitle.chat", {
        title: t("settings.sidebar.title"),
      });
      return;
    }
    document.title = activeSession
      ? t("app.documentTitle.chat", { title: headerTitle })
      : t("app.documentTitle.base");
  }, [activeSession, headerTitle, i18n.resolvedLanguage, t, view]);

  const sessionListProps = {
    sessions,
    activeKey,
    loading,
    onSelect: onSelectChat,
    onSelectAgent,
    onRequestDelete: (key: string, label: string) =>
      setPendingDelete({ key, label }),
    onTogglePin,
    onRequestRename,
    onToggleArchive,
    onMarkAllRead,
    onToggleArchived,
    pinnedKeys: sidebarState.pinned_keys,
    archivedKeys: sidebarState.archived_keys,
    titleOverrides: sidebarState.title_overrides,
    runningChatIds: runningChatIdList,
    unreadKeys: unreadSessionKeys,
    showArchived: sidebarState.view.show_archived,
    archivedCount: sidebarState.archived_keys.length,
    onRemoveProject,
    onCreateTask,
    projectNames: sidebarState.project_names,
    onRequestProjectRename,
    onOpenProjectFolder,
    onNewChat: () => {
      setMobileSidebarOpen(false);
      onNewChat();
    },
    onStartDirect: (agentId: string) => {
      setMobileSidebarOpen(false);
      void onStartDirect(agentId);
    },
    onNewRoom: () => {
      setMobileSidebarOpen(false);
      onOpenNewRoom();
    },
  };
  const showMainSidebar = true;
  const showSessionList = showMainSidebar && !isBrowserTabActive;

  return (
    <ThemeProvider theme={theme}>
      <div
        className="relative flex h-full w-full flex-col overflow-hidden text-foreground"
        style={{
          background:
            "linear-gradient(180deg, hsl(var(--canvas-top)) 0%, hsl(var(--canvas-bottom)) 100%)",
        }}
      >
        {/* 标题栏在最顶部，全宽（浏览器全屏时隐藏） */}
        {!browserFullscreen && (
          <AppTitleBar
            tabs={browserTabs}
            activeTabId={activeBrowserTabId}
            onTabClick={handleBrowserTabClick}
            onTabClose={closeBrowserTab}
            onNewTab={() => openNewBrowserTab(setView, addEmptyTab)}
            onPinToggle={togglePinTab}
            onDuplicate={duplicateTab}
            onCloseOthers={closeOtherTabs}
            onCloseRight={closeTabsToRight}
            onReorder={reorderTabs}
            onToggleMute={toggleMute}
            onSaveMdAsNote={saveMdAsNote}
            onRevealMdInExplorer={revealMdInExplorer}
          />
        )}

        {/* 活动走马灯（关闭后不再显示） */}
        {promoVisible && (
          <>
            <style>{`@keyframes monaMarquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}`}</style>
            <div className="relative flex h-7 shrink-0 items-center overflow-hidden bg-gradient-to-r from-emerald-500 to-emerald-600 pl-3 pr-8 text-white">
              <div className="flex whitespace-nowrap" style={{ animation: "monaMarquee 18s linear infinite" }}>
                <span className="px-4 text-xs font-medium">{promoText}</span>
                <span className="px-4 text-xs font-medium">{promoText}</span>
              </div>
              <button
                type="button"
                onClick={handleClosePromo}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-0.5 hover:bg-white/20"
                title="关闭"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </>
        )}

        {/* 标题栏下方：Sidebar + 主内容区 */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* 企微式窄功能栏（浏览器全屏时隐藏；无展开/折叠态） */}
          {!browserFullscreen && showMainSidebar ? (
            <aside className="relative z-20 w-16 shrink-0 overflow-hidden">
              <AppRail
                activeView={view}
                onGoHome={onGoHome}
                onOpenMessages={onGoHome}
                onOpenNote={onOpenNote}
                onOpenDoc={onOpenDoc}
                onOpenSSH={onOpenSSH}
                onOpenDb={onOpenDb}
                onOpenEmail={onOpenEmail}
                onOpenSchedule={onOpenSchedule}
                onOpenSystem={onOpenSystem}
                onOpenProfile={onOpenProfile}
                onOpenStock={onOpenStock}
                onOpenSettings={onOpenSettings}
                onOpenLogin={onOpenLogin}
                onOpenSubscribe={onOpenSubscribe}
                onStartUpdate={() => setUpdateDialogTrigger((n) => n + 1)}
                updateAvailable={!!updateAvailable}
                messageAttentionCount={messageAttentionCount}
                runningChatIds={runningChatIdList}
                modules={sidebarModules ?? undefined}
                moduleAvailability={{ stock: stockEnabled === true }}
                theme={theme}
                onToggleTheme={toggle}
              />
            </aside>
          ) : null}

          {/* 消息会话列表列 */}

          {!browserFullscreen && showSessionList ? (
            <Sheet
              open={mobileSidebarOpen}
              onOpenChange={(open) => setMobileSidebarOpen(open)}
            >
              <SheetContent
                side="left"
                showCloseButton={false}
                aria-describedby={undefined}
                className="w-[min(320px,100vw)] max-w-[100vw] p-0 lg:hidden"
              >
                <SheetTitle className="sr-only">{t("sidebar.navigation")}</SheetTitle>
                <SessionListPanel {...sessionListProps} className="w-full border-r-0" />
              </SheetContent>
            </Sheet>
          ) : null}

          <div className="flex min-w-0 flex-1 flex-col">
            <div
              className={cn(
                "flex min-h-0 flex-1 overflow-hidden bg-background",
                showContentSurface &&
                  "m-px mr-2 mb-2 rounded-xl border border-border/60",
              )}
            >
              {/* 消息 Tab 的会话列表列（仅 chat 视图显示，包在圆角卡片内） */}
              {!browserFullscreen && showSessionList && view === "chat" ? (
                <SessionListPanel
                  {...sessionListProps}
                  className="hidden lg:flex"
                />
              ) : null}

              <main
                className={cn(
                  "relative isolate flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background",
                )}
              >
              <div
                className={cn(
                  "absolute inset-0 flex flex-col bg-background",
                  (view === "settings" || view === "note" || view === "ssh" || view === "db" || view === "doc" || view === "email" || view === "schedule" || view === "system" || view === "profile" || view === "stock" || activeBrowserTab.type !== "mona") &&
                    "invisible pointer-events-none",
                )}
              >
                {managedAgentId ? (
                  <AgentManagementView
                    agentId={managedAgentId}
                    onBack={() => setManagedAgentId(null)}
                    onStartDirect={() => void onStartDirect(managedAgentId)}
                  />
                ) : client ? (
                  <ThreadShell
                    session={activeSession}
                    title={headerTitle}
                    onToggleSidebar={toggleSidebar}
                    onOpenSSH={onOpenSSHAndNew}
                    onOpenDb={onOpenDbAndNew}
                    onOpenEmail={onOpenEmail}
                    onCreateNote={onCreateNote}
                    recentSessions={sessions.filter((session) => !sidebarState.archived_keys.includes(session.key))}
                    onSelectSession={onSelectChat}
                    onCreateChat={onCreateChat}
                    pendingDirectAgentId={pendingDirectAgentId}
                    onCreateDirectChat={onCreateDirectChat}
                    onTurnEnd={onTurnEnd}
                    queuedPrompt={queuedAgentPrompt}
                    onQueuedPromptConsumed={() => setQueuedAgentPrompt(null)}
                    hideSidebarToggleOnDesktop
                    showHeader
                    onModelNameChange={onModelNameChange}
                    onOpenSettings={onOpenSettings}
                  />
                ) : (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-3 lg:hidden">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("thread.header.toggleSidebar")}
                        onClick={toggleSidebar}
                        className="h-8 w-8 rounded-lg text-muted-foreground"
                      >
                        <Menu className="h-4 w-4" />
                      </Button>
                      <span className="truncate text-[13px] font-medium">{headerTitle}</span>
                    </div>
                    <RuntimePlaceholder
                      status={runtimeStatus}
                      message={runtimeError}
                      onRetry={onRetryConnection}
                    />
                  </div>
                )}
              </div>
              {noteMounted && (
                <div className={cn(
                  "absolute inset-0 flex flex-col",
                  (view !== "note" || isBrowserTabActive) && "invisible pointer-events-none",
                )}>
                  <Suspense fallback={<ModuleLoading title="正在打开笔记" />}>
                    <NotesView
                      onOpenSubscribe={onOpenSubscribe}
                      initialNoteId={new URLSearchParams(window.location.search).get("noteId") ?? undefined}
                      createOnOpen={createNoteOnOpen}
                      onCreateOnOpenHandled={() => setCreateNoteOnOpen(false)}
                    />
                  </Suspense>
                </div>
              )}
              {view === "settings" && (
                <div className={cn("absolute inset-0 flex flex-col", isBrowserTabActive && "hidden")}>
                  <SettingsView
                    theme={theme}
                    onToggleTheme={toggle}
                    onBackToChat={onBackToChat}
                    onModelNameChange={onModelNameChange}
                    onRestart={onRestart}
                    isRestarting={isRestarting}
                    initialSection={settingsInitialSection}
                    onTriggerAgent={onTriggerAgent}
                  />
                </div>
              )}
              <div
                className={cn(
                  "absolute inset-0 flex flex-col bg-background",
                  (view !== "ssh" || isBrowserTabActive) && "invisible pointer-events-none",
                )}
              >
                <TerminalView onOpenSubscribe={onOpenSubscribe} />
              </div>
              {view === "db" && (
                <div className={cn("absolute inset-0 flex flex-col", isBrowserTabActive && "hidden")}>
                  {client ? (
                    <Suspense fallback={<ModuleLoading title="正在打开数据库客户端" />}>
                      <DbClientView onOpenSubscribe={onOpenSubscribe} />
                    </Suspense>
                  ) : (
                    <RuntimePlaceholder
                      status={runtimeStatus}
                      message={runtimeError}
                      onRetry={onRetryConnection}
                    />
                  )}
                </div>
              )}
              {view === "email" && (
                <div className={cn("absolute inset-0 flex flex-col", isBrowserTabActive && "hidden")}>
                  {client ? (
                    <Suspense fallback={<ModuleLoading title="正在打开邮件" />}>
                      <EmailClientView onOpenSubscribe={onOpenSubscribe} />
                    </Suspense>
                  ) : (
                    <RuntimePlaceholder
                      status={runtimeStatus}
                      message={runtimeError}
                      onRetry={onRetryConnection}
                    />
                  )}
                </div>
              )}
              {view === "schedule" && (
                <div className={cn("absolute inset-0 flex flex-col", isBrowserTabActive && "hidden")}>
                  {client ? (
                    <Suspense fallback={<ModuleLoading title="正在打开计划" />}>
                      <PlanningView />
                    </Suspense>
                  ) : (
                    <RuntimePlaceholder
                      status={runtimeStatus}
                      message={runtimeError}
                      onRetry={onRetryConnection}
                    />
                  )}
                </div>
              )}
              {view === "profile" && (
                <div className={cn("absolute inset-0 flex flex-col", isBrowserTabActive && "hidden")}>
                  <Suspense fallback={<ModuleLoading title="正在打开用户画像" />}>
                    <ProfileView onAskMona={onTriggerAgent} />
                  </Suspense>
                </div>
              )}
              {view === "stock" && stockEnabled === true && (
                <div className={cn("absolute inset-0 flex flex-col", isBrowserTabActive && "hidden")}>
                  <Suspense fallback={<ModuleLoading title="正在打开股票工作台" />}>
                    <StockView
                      focusRunId={stockFocusRunId}
                      onConsumeFocusRun={() => setStockFocusRunId(null)}
                      autoRunSymbol={stockAutoRunSymbol}
                      onConsumeAutoRun={() => setStockAutoRunSymbol(null)}
                      quoteRefreshSecMs={
                        stockQuoteRefreshSec != null
                          ? stockQuoteRefreshSec * 1000
                          : undefined
                      }
                      reviewTime={stockReviewTime ?? undefined}
                      reviewScope={stockReviewScope ?? undefined}
                      autoReviewEnabled={stockAutoReviewEnabled}
                      onOpenSettings={() => onOpenSettings("stock")}
                    />
                  </Suspense>
                </div>
              )}
              {systemMounted && (
                <div className={cn(
                  "absolute inset-0 flex flex-col bg-background",
                  (view !== "system" || isBrowserTabActive) && "invisible pointer-events-none",
                )}>
                  <Suspense fallback={<ModuleLoading title="正在打开系统" />}>
                    <SystemView />
                  </Suspense>
                </div>
              )}
              {client ? (
                <div className={cn("absolute inset-0 flex flex-col bg-background", (view !== "doc" || isBrowserTabActive) && "invisible pointer-events-none")}>
                  <Suspense fallback={<ModuleLoading title="正在打开 AI 文档" />}>
                    <DocMakerView />
                  </Suspense>
                </div>
              ) : null}
              {browserTabs
                .filter((t) => t.type === "md-reader")
                .map((tab) => (
                  <div
                    key={tab.id}
                    className="absolute inset-0 flex flex-col"
                    style={{ display: tab.id === activeBrowserTabId ? "flex" : "none" }}
                  >
                    <Suspense fallback={<ModuleLoading title="正在打开 Markdown 阅读器" />}>
                      <MdFileView filePath={tab.mdFilePath!} />
                    </Suspense>
                  </div>
                ))}
              {browserTabs
                .filter((t) => t.type === "history")
                .map((tab) => (
                  <div
                    key={tab.id}
                    className="absolute inset-0 flex flex-col bg-background"
                    style={{ display: tab.id === activeBrowserTabId ? "flex" : "none" }}
                  >
                    <HistoryPage
                      onNavigate={(url) => {
                        // 关闭历史记录标签，打开新标签导航
                        void closeBrowserTab(tab.id);
                        const newTabId = addEmptyTab();
                        // 等待新标签进入 React 状态后再创建原生 WebView。
                        setTimeout(() => {
                          navigateToUrl(newTabId, url).catch(() => {});
                        }, 0);
                      }}
                      onBack={() => void closeBrowserTab(tab.id)}
                    />
                  </div>
                ))}
              {browserTabs
                .filter((t) => t.type === "downloads")
                .map((tab) => (
                  <div
                    key={tab.id}
                    className="absolute inset-0 flex flex-col bg-background"
                    style={{ display: tab.id === activeBrowserTabId ? "flex" : "none" }}
                  >
                    <DownloadsPage onBack={() => void closeBrowserTab(tab.id)} />
                  </div>
                ))}
              {browserTabs
                .filter((t) => t.type === "browser")
                .map((tab) => (
                  <div
                    key={tab.id}
                    className="absolute inset-0 flex flex-col bg-background"
                    style={{ display: tab.id === activeBrowserTabId ? "flex" : "none" }}
                  >
                    <BrowserTabView
                      tab={tab}
                      isVisible={tab.id === activeBrowserTabId && browserSurfaceVisible}
                      layoutVersion={desktopSidebarOpen}
                      isFullscreen={browserFullscreen}
                      onToggleFullscreen={toggleFullscreen}
                      onExitFullscreen={exitFullscreen}
                      session={activeSession}
                      onNavigate={(url) => navigateToUrl(tab.id, url)}
                      onGoBack={() => goBack(tab.id)}
                      onGoForward={() => goForward(tab.id)}
                      onReload={() => reload(tab.id)}
                      onUrlChange={(url) => updateTabUrl(tab.id, url)}
                      onOpenHistory={openHistoryPage}
                      onOpenDownloads={openDownloadsPage}
                      onToggleMute={() => toggleMute(tab.id)}
                      onToggleAdBlock={() => toggleAdBlock(tab.id)}
                      onToggleDarkMode={() => toggleDarkMode(tab.id)}
                      onOpenDevtools={() => openDevtools(tab.id)}
                    />
                  </div>
                ))}
            </main>
          </div>
        </div>
        </div>

        <SessionSearchDialog
          open={sessionSearchOpen}
          onOpenChange={setSessionSearchOpen}
          sessions={sessions}
          activeKey={activeKey}
          loading={loading}
          titleOverrides={sidebarState.title_overrides}
          onSelect={onSelectSearchResult}
        />

        <LoginDialog
          open={loginDialogOpen}
          onOpenChange={setLoginDialogOpen}
          initialView={loginDialogInitialView}
          autoSubscribeAfterLogin={loginDialogSubscribeIntent}
        />

        <UpdateNotification
          onUpdateAvailable={setUpdateAvailable}
          openTrigger={updateDialogTrigger}
        />

        <DeleteConfirm
          open={!!pendingDelete}
          title={pendingDelete?.label ?? ""}
          onCancel={() => setPendingDelete(null)}
          onConfirm={onConfirmDelete}
        />
        <RenameChatDialog
          open={!!pendingRename}
          title={pendingRename?.label ?? ""}
          onCancel={() => setPendingRename(null)}
          onConfirm={onConfirmRename}
        />
        <NewRoomDialog
          open={roomDialogOpen}
          onOpenChange={setRoomDialogOpen}
          agents={partnerAgents}
          initialSelected={roomInitialAgents}
          submitting={creatingConversation}
          onSubmit={(input) => void onSubmitRoom(input)}
        />
        {runtimeStatus === "auth" ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-xl border border-border bg-popover p-6 shadow-lg">
              <AuthForm
                failed={authFailed}
                onSecret={onSubmitAuth}
              />
            </div>
          </div>
        ) : null}
        {restartToast ? (
          <div
            role="status"
            className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-full border border-border/70 bg-popover px-4 py-2 text-sm font-medium text-popover-foreground shadow-lg"
          >
            {restartToast}
          </div>
        ) : null}
      </div>
    </ThemeProvider>
  );
}

function ModuleLoading({ title }: { title: string }) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background text-[13px] text-muted-foreground">
      {title}...
    </div>
  );
}

function RuntimePlaceholder({
  status,
  message,
  onRetry,
}: {
  status: RuntimeStatus;
  message?: string | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const [logOpen, setLogOpen] = useState(false);

  // 连接中：显示简洁的连接提示，避免聊天区空白造成"应用卡住"的错觉
  if (status === "connecting") {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          <p className="text-sm text-muted-foreground">
            {t("app.loading.connecting")}
          </p>
        </div>
      </div>
    );
  }
  if (status !== "error") return null;
  return (
    <div className="flex h-full w-full items-center justify-center px-4 text-center">
      <div className="flex max-w-md flex-col items-center gap-3">
        <p className="text-title-sm">{t("app.error.title")}</p>
        {message ? (
          <p className="text-body text-muted-foreground">{message}</p>
        ) : null}
        <p className="text-caption text-muted-foreground">
          {t("app.error.gatewayHint")}
        </p>
        <p className="text-caption text-muted-foreground">
          {t("app.error.otherFeaturesHint")}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t("app.error.retry")}
          </Button>
          {isTauri() ? (
            <Button variant="outline" size="sm" onClick={() => setLogOpen(true)}>
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              {t("app.error.viewLog")}
            </Button>
          ) : null}
        </div>
      </div>
      {isTauri() ? (
        <GatewayLogDialog open={logOpen} onOpenChange={setLogOpen} />
      ) : null}
    </div>
  );
}

function GatewayLogDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const [log, setLog] = useState<GatewayLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCopied(false);
    readGatewayLog(200)
      .then((res) => {
        if (cancelled) return;
        setLog(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleCopy = async () => {
    if (!log?.tail) return;
    try {
      await navigator.clipboard.writeText(log.tail);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-[680px] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-2xl border-border/70 bg-popover p-0 shadow-lg">
        <DialogHeader className="border-b border-border/60 px-5 py-4 text-left">
          <DialogTitle className="flex items-center gap-2 text-body-lg">
            <FileText className="h-4 w-4 text-muted-foreground" />
            {t("app.error.logTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("app.error.logTitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden px-5 py-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t("app.error.logLoading")}</p>
          ) : error ? (
            <p className="text-sm text-destructive">{t("app.error.logLoadError")}: {error}</p>
          ) : log ? (
            <>
              {log.path ? (
                <p className="mb-2 break-all text-xs text-muted-foreground">
                  <span className="font-medium">{t("app.error.logPath")}: </span>
                  <span className="select-text font-mono">{log.path}</span>
                </p>
              ) : null}
              <div className="max-h-[55vh] overflow-y-auto scrollbar-thin rounded-md bg-background/60 p-3">
                {log.tail ? (
                  <pre className="whitespace-pre-wrap break-all text-left font-mono text-xs leading-relaxed text-foreground/90 select-text">
                    {log.tail}
                  </pre>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("app.error.logEmpty")}</p>
                )}
              </div>
            </>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
            disabled={!log?.tail || loading}
          >
            {copied ? (
              <Check className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <Copy className="mr-1.5 h-3.5 w-3.5" />
            )}
            {copied ? t("app.error.copyLogDone") : t("app.error.copyLog")}
          </Button>
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            {t("deleteConfirm.cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
