import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StockVibeReport } from "./StockVibeReport";
import { StockVibeInfo } from "./StockVibeInfo";
import { stockTime } from "@/lib/stock-vibe-workbench";
import "./stock-vibe-research.css";
import {
  cancelStockVibeSession,
  createStockVibeSession,
  getStockVibeAttempt,
  getStockVibeMessages,
  getStockVibeEventStreamUrl,
  getStockVibeRequest,
  getStockVibeSession,
  sendStockVibeMessage,
  StockVibeApiError,
  uploadStockVibeFile,
  type StockVibeAttempt,
  type StockVibeRequestRecord,
  type StockVibeWorkbenchContext,
} from "@/lib/stock-vibe-api";

type ResearchMode = "ultrashort" | "swing" | "medium";
type RequestKind = "create" | "send" | "cancel" | "upload";
type RequestPhase = "dispatching" | "checking" | "blocked";

interface PendingRequest {
  requestId: string;
  kind: RequestKind;
  phase: RequestPhase;
  sessionId?: string;
  attemptId?: string;
  filename?: string;
}

interface UploadedAttachment {
  filename: string;
  filePath: string;
  requestId: string;
}

interface StoredResearch {
  sessionId: string | null;
  attemptId: string | null;
  attachments: UploadedAttachment[];
  pending: PendingRequest[];
  draft?: string;
  scope?: { symbol: string | null; mode: ResearchMode };
  task?: StockVibeWorkbenchContext["task"] | null;
  excludedAttachments?: string[];
}

interface ResearchMessage {
  message_id: string;
  role: string;
  content: string;
  created_at: string;
  linked_attempt_id: string | null;
  metadata: Record<string, unknown>;
  tool_trail: Record<string, unknown>[];
}

export interface StockVibeResearchProps {
  symbol: string | null;
  mode: ResearchMode;
  enabled: boolean;
  title?: string;
  initialQuestion?: string;
  /** 由「追问」带入的明确问题：打开即提交，不再要求用户在弹窗里二次确认。 */
  autoSend?: boolean;
  journalOperationId?: string;
  nativeResearch?: import("@/lib/stock-vibe-api").StockVibeNativeResearchOrigin;
  strategyCreation?: boolean;
  strategyDraftId?: string;
  strategyName?: string;
  onStrategyRegistered?: (id: string) => void;
  onOpenStrategy?: (id: string) => void;
  context?: StockVibeWorkbenchContext;
  resumeSession?: { sessionId: string; attemptId?: string };
  resumeScope?: StockVibeWorkbenchContext;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  canSubmit?: boolean;
  onChanged?: () => void;
  onOpenModel?: () => void;
  attachmentFile?: File | null;
  onAttachmentFileChange?: (file: File | null) => void;
}

const STORAGE_PREFIX = "mona.stock-vibe.research.v1:";
const REQUEST_ID = /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
const OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SYMBOL_PATTERN = /^\d{6}\.(SH|SZ|BJ)$/;
const UPLOAD_PATH = /^uploads\/[a-f0-9]{32}\.(?:csv|tsv|xls|xlsx|pdf|docx|txt|md)$/i;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".csv", ".tsv", ".xls", ".xlsx", ".pdf", ".docx", ".txt", ".md"]);
const MODE_LABEL: Record<ResearchMode, string> = { ultrashort: "超短线", swing: "波段", medium: "中短线" };
const TASK_LABEL: Record<StockVibeWorkbenchContext["task"], string> = {
  comprehensive: "综合分析",
  fundamental: "财报与估值",
  technical: "走势分析",
  risk: "风险检查",
};
const TOOL_LABELS: Record<string, string> = {
  read_trade_review: "读取成交复盘",
  get_market_data: "读取行情", get_stock_profile: "查询公司资料", get_financial_statements: "读取财报",
  get_cn_announcements: "查询公告", get_stock_news: "查询新闻", web_search: "搜索资料", web_fetch: "读取网页",
  read_file: "读取资料", read_document: "分析文档", write_file: "保存研究文件", load_skill: "准备分析方法",
  run_swarm: "协作研究", backtest: "历史回测", quantlib_call: "计算分析指标",
};

function toolLabel(tool: unknown): string {
  return typeof tool === "string" ? TOOL_LABELS[tool] ?? "执行研究分析" : "执行研究分析";
}

function visibleQuestion(message: ResearchMessage): string {
  if (!message.metadata.research && /^(?:标的：|研究范围：)/.test(message.content)
    && message.content.includes("账户资料不足时请说明限制，不要生成个性化仓位数字。")) {
    const marker = message.content.indexOf("\n\n用户问题：");
    if (marker >= 0) return message.content.slice(marker + "\n\n用户问题：".length);
  }
  return message.content;
}
const POLLING_ATTEMPT_STATUSES = new Set<StockVibeAttempt["status"]>([
  "pending",
  "running",
  "waiting_user",
]);
const BUSY_ATTEMPT_STATUSES = new Set<StockVibeAttempt["status"]>(["pending", "running"]);

type RequestOutcome = "confirmed" | "pending" | "rejected" | "blocked";

function emptyStoredResearch(): StoredResearch {
  return { sessionId: null, attemptId: null, attachments: [], pending: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObjectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID.test(value);
}

function comparableRequestId(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

function safeUploadPath(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_PATH.test(value);
}

function storageKeyFor(symbol: string | null, context?: StockVibeWorkbenchContext, sessionId?: string, journalOperationId?: string, nativeResearch?: import("@/lib/stock-vibe-api").StockVibeNativeResearchOrigin): string {
  if (journalOperationId) return `${STORAGE_PREFIX}journal:${journalOperationId}`;
  if (sessionId) return `${STORAGE_PREFIX}session:${sessionId}`;
  const normalized = symbol?.trim().toUpperCase();
  const key = `${STORAGE_PREFIX}${normalized ? encodeURIComponent(normalized) : "universe"}`;
  const scoped = context ? `${key}:task:${context.task}` : key;
  return nativeResearch ? `${scoped}:native:${encodeURIComponent(nativeResearch.strategy_id ?? `${nativeResearch.swarm_id}:${nativeResearch.task_id ?? ""}`)}` : scoped;
}

function readStoredResearch(key: string): StoredResearch {
  try {
    const payload: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (!isRecord(payload)) return emptyStoredResearch();
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments.flatMap((value): UploadedAttachment[] => {
        if (!isRecord(value) || typeof value.filename !== "string"
          || !safeUploadPath(value.filePath) || typeof value.requestId !== "string") return [];
        return [{ filename: value.filename, filePath: value.filePath, requestId: value.requestId }];
      })
      : [];
    const pending = Array.isArray(payload.pending)
      ? payload.pending.flatMap((value): PendingRequest[] => {
        if (!isRecord(value) || typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)
          || !["create", "send", "cancel", "upload"].includes(String(value.kind))) return [];
        const phase: RequestPhase = value.phase === "blocked" ? "blocked" : "checking";
        return [{
          requestId: value.requestId,
          kind: value.kind as RequestKind,
          phase,
          ...(isObjectId(value.sessionId) ? { sessionId: value.sessionId } : {}),
          ...(isObjectId(value.attemptId) ? { attemptId: value.attemptId } : {}),
          ...(typeof value.filename === "string" ? { filename: value.filename } : {}),
        }];
      })
      : [];
    return {
      sessionId: isObjectId(payload.sessionId) ? payload.sessionId : null,
      attemptId: isObjectId(payload.attemptId) ? payload.attemptId : null,
      attachments,
      pending,
      ...(typeof payload.draft === "string" ? { draft: payload.draft } : {}),
      ...(isRecord(payload.scope) && (payload.scope.symbol === null || typeof payload.scope.symbol === "string" && SYMBOL_PATTERN.test(payload.scope.symbol))
        && ["ultrashort", "swing", "medium"].includes(String(payload.scope.mode))
        ? { scope: { symbol: payload.scope.symbol as string | null, mode: payload.scope.mode as ResearchMode } } : {}),
      ...(payload.task === null || Object.hasOwn(TASK_LABEL, String(payload.task)) ? { task: payload.task as StoredResearch["task"] } : {}),
      ...(Array.isArray(payload.excludedAttachments) ? { excludedAttachments: payload.excludedAttachments.filter(safeUploadPath) } : {}),
    };
  } catch {
    return emptyStoredResearch();
  }
}

function parseMessages(value: unknown): ResearchMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ResearchMessage[] => {
    if (!isRecord(item) || typeof item.message_id !== "string"
      || typeof item.role !== "string" || typeof item.content !== "string"
      || typeof item.created_at !== "string") return [];
    return [{
      message_id: item.message_id,
      role: item.role,
      content: item.content,
      created_at: item.created_at,
      linked_attempt_id: isObjectId(item.linked_attempt_id) ? item.linked_attempt_id : null,
      metadata: isRecord(item.metadata) ? item.metadata : {},
      tool_trail: Array.isArray(item.tool_trail) ? item.tool_trail.filter(isRecord) : [],
    }];
  });
}

function parseAttempt(value: unknown, sessionId: string, attemptId: string): StockVibeAttempt | null {
  if (!isRecord(value)
    || value.session_id !== sessionId
    || value.attempt_id !== attemptId
    || !["pending", "running", "waiting_user", "completed", "failed", "cancelled", "interrupted"].includes(String(value.status))) {
    return null;
  }
  return value as unknown as StockVibeAttempt;
}

function validReceiptBody(record: StockVibeRequestRecord, status: "completed" | "rejected"): Record<string, unknown> | null {
  const receipt = record.receipt;
  const statusCode = receipt?.status_code;
  if (record.status !== status || !receipt || typeof statusCode !== "number" || !Number.isInteger(statusCode)
    || typeof record.receipt_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(record.receipt_sha256)) return null;
  if (status === "completed" && (statusCode < 200 || statusCode >= 300)) return null;
  if (status === "rejected" && (statusCode < 400 || statusCode >= 500)) return null;
  return isRecord(receipt.body) ? receipt.body : null;
}

function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID().replace(/-/g, "").toLowerCase();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return hex;
}

function safeApiError(error: unknown): string {
  return error instanceof StockVibeApiError
    ? error.message
    : "股票研究暂时无法完成，请检查服务状态后再试。";
}

function encodeFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("invalid file encoding"));
      else resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

export function StockVibeResearch({
  symbol: initialSymbol,
  mode: initialMode,
  enabled,
  title,
  initialQuestion,
  autoSend = false,
  journalOperationId,
  nativeResearch,
  strategyCreation = false,
  strategyDraftId,
  strategyName,
  onStrategyRegistered,
  onOpenStrategy,
  context: initialContext,
  resumeSession,
  resumeScope,
  open = true,
  onOpenChange,
  canSubmit = true,
  onChanged,
  onOpenModel,
  attachmentFile,
  onAttachmentFileChange,
}: StockVibeResearchProps) {
  const [scope, setScope] = useState({ symbol: initialSymbol, mode: initialMode });
  const [scopeRecorded, setScopeRecorded] = useState(false);
  const { symbol, mode } = scope;
  const [task, setTask] = useState<StockVibeWorkbenchContext["task"] | null>(initialContext?.task ?? null);
  const context = symbol && task ? { symbol, mode, task } : undefined;
  const resumeSessionId = resumeSession?.sessionId;
  const resumeAttemptId = resumeSession?.attemptId;
  const invalidResume = resumeSession !== undefined && (!isObjectId(resumeSessionId)
    || (resumeAttemptId !== undefined && !isObjectId(resumeAttemptId)));
  const baseStorageKey = storageKeyFor(initialSymbol, initialContext, resumeSessionId, journalOperationId, nativeResearch);
  const storageKey = invalidResume ? null : strategyDraftId && !resumeSessionId ? `${baseStorageKey}:strategy:${strategyDraftId}` : baseStorageKey;
  const [stored, setStored] = useState<StoredResearch>(emptyStoredResearch);
  const storedRef = useRef(stored);
  const activeKeyRef = useRef<string | null>(null);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<ResearchMessage[]>([]);
  const [attempt, setAttempt] = useState<StockVibeAttempt | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [draft, setDraft] = useState(initialQuestion ?? "");
  const [localFile, setLocalFile] = useState<File | null>(null);
  const selectedFile = onAttachmentFileChange ? attachmentFile ?? null : localFile;
  const setSelectedFile = onAttachmentFileChange ?? setLocalFile;
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [verifiedSessionId, setVerifiedSessionId] = useState<string | null>(null);
  const verifiedSessionRef = useRef<string | null>(null);
  const writeLock = useRef(false);
  const sessionWasOpen = useRef(false);
  const shownAlerts = useRef(new Set<string>());
  const showAlertRef = useRef<(key: string, message: string) => void>(() => undefined);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const notifiedAttempt = useRef<string | null>(null);
  const registeredStrategies = messages.filter((message) => message.role === "assistant").flatMap((message) => Array.isArray(message.metadata.strategy_artifacts) ? message.metadata.strategy_artifacts.filter((item): item is { strategy_id: string; version: string; name: string } => isRecord(item) && typeof item.strategy_id === "string" && /^sdm:[A-Za-z0-9_.-]{1,128}$/.test(item.strategy_id) && !item.strategy_id.includes("..") && typeof item.version === "string" && /^[a-f\d]{64}$/i.test(item.version) && typeof item.name === "string") : []);
  const registeredRef = useRef(onStrategyRegistered); registeredRef.current = onStrategyRegistered;
  const notifiedStrategies = useRef(new Set<string>());
  useEffect(() => {
    if (!strategyCreation) return;
    for (const item of registeredStrategies) {
      const identity = `${item.strategy_id}:${item.version}`;
      if (!notifiedStrategies.current.has(identity)) { notifiedStrategies.current.add(identity); registeredRef.current?.(item.strategy_id); }
    }
  }, [messages, strategyCreation]);
  useEffect(() => {
    if (!attempt || !stored.sessionId) return;
    const identity = `${stored.sessionId}:${attempt.attempt_id}:${attempt.status}`;
    if (notifiedAttempt.current === identity) return;
    notifiedAttempt.current = identity;
    changedRef.current?.();
  }, [attempt?.attempt_id, attempt?.status, stored.sessionId]);

  const showAlert = useCallback((key: string, message: string) => {
    if (shownAlerts.current.has(key)) return;
    shownAlerts.current.add(key);
    setAlertMessage(message);
  }, []);
  showAlertRef.current = showAlert;

  const updateStored = useCallback((key: string, update: (current: StoredResearch) => StoredResearch): boolean => {
    const current = activeKeyRef.current === key ? storedRef.current : readStoredResearch(key);
    const next = update(current);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      showAlertRef.current(`storage:${key}`, "无法安全保存请求核对信息，因此没有提交操作。请检查本机存储空间后再试。");
      return false;
    }
    if (activeKeyRef.current === key) {
      storedRef.current = next;
      setStored(next);
    }
    return true;
  }, []);

  const storedSessionId = stored.sessionId;
  const storedAttemptId = stored.attemptId;
  const pendingSignature = stored.pending.map((item) => `${item.requestId}:${item.phase}`).join("|");

  useEffect(() => {
    activeKeyRef.current = storageKey;
    setHydratedKey(null);
    setMessages([]);
    setAttempt(null);
    setNotice(null);
    verifiedSessionRef.current = null;
    setVerifiedSessionId(null);
    if (!enabled || !storageKey) {
      storedRef.current = emptyStoredResearch();
      setStored(emptyStoredResearch());
      if (enabled && invalidResume) showAlert("resume-invalid", "研究记录标识无效，无法打开原会话。请从研究记录重新进入。");
      return;
    }
    const initial = readStoredResearch(storageKey);
    if (resumeSessionId) {
      if ((initial.sessionId && initial.sessionId !== resumeSessionId)
        || initial.pending.some((operation) => operation.kind === "create"
          || (operation.sessionId && operation.sessionId !== resumeSessionId))) {
        storedRef.current = emptyStoredResearch();
        setStored(emptyStoredResearch());
        showAlert(`resume-mismatch:${resumeSessionId}`, "本机研究记录与所选会话不一致，已停止恢复。请从研究记录重新进入。");
        return;
      }
      initial.sessionId = resumeSessionId;
      if (resumeAttemptId && !initial.pending.length) initial.attemptId = resumeAttemptId;
      else initial.attemptId ??= resumeAttemptId ?? null;
    }
    storedRef.current = initial;
    setStored(initial);
    setDraft(autoSend && initialQuestion ? initialQuestion : initial.draft ?? (initial.sessionId ? "" : initialQuestion ?? ""));
    if (initial.scope) setScope(initial.scope);
    if (initial.task !== undefined) setTask(initial.task);
    setHydratedKey(storageKey);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(initial));
    } catch {
      // Reads can proceed, but every future write still requires a successful save first.
    }
  }, [autoSend, enabled, initialQuestion, invalidResume, resumeAttemptId, resumeSessionId, showAlert, storageKey]);

  useEffect(() => {
    if (!storageKey || hydratedKey !== storageKey) return;
    updateStored(storageKey, (current) => ({ ...current, draft, scope: { symbol, mode }, task }));
  }, [draft, hydratedKey, mode, storageKey, symbol, task, updateStored]);

  useEffect(() => {
    if (attempt?.status === "waiting_user") setHistoryRevision((value) => value + 1);
  }, [attempt?.attempt_id, attempt?.status]);

  const removePending = useCallback((key: string, requestId: string, change?: Partial<StoredResearch>) => {
    return updateStored(key, (current) => ({
      ...current,
      ...change,
      pending: current.pending.filter((item) => item.requestId !== requestId),
    }));
  }, [updateStored]);

  const setRequestPhase = useCallback((key: string, requestId: string, phase: RequestPhase) => {
    return updateStored(key, (current) => ({
      ...current,
      pending: current.pending.map((item) => item.requestId === requestId ? { ...item, phase } : item),
    }));
  }, [updateStored]);

  const processRequest = useCallback((key: string, operation: PendingRequest, record: StockVibeRequestRecord): RequestOutcome => {
    const alertForRequest = (message: string, replace = false) => {
      if (activeKeyRef.current !== key) return;
      const alertKey = `request:${operation.requestId}`;
      if (replace && shownAlerts.current.has(alertKey)) setAlertMessage(message);
      else showAlert(alertKey, message);
    };
    const failClosed = (message: string) => {
      setRequestPhase(key, operation.requestId, "blocked");
      alertForRequest(message);
    };
    if (comparableRequestId(record.request_id) !== comparableRequestId(operation.requestId)) {
      failClosed("请求回执标识不匹配，结果尚未确认。请先核对状态，不要重复提交。");
      return "blocked";
    }
    if (record.status === "pending" || record.status === "unknown") {
      setRequestPhase(key, operation.requestId, "checking");
      return "pending";
    }
    if (record.status === "rejected") {
      if (record.error_category === "not_dispatched" && record.receipt === null && record.source === null) {
        removePending(key, operation.requestId);
        alertForRequest("这次请求已确认未发出。检查内容后，可由你手动重新提交。", true);
        return "rejected";
      }
      if (!validReceiptBody(record, "rejected")) {
        failClosed("操作回执不完整，结果尚未确认。请先核对状态，不要重复提交。");
        return "blocked";
      }
      if (activeKeyRef.current === key) setAlertMessage(null);
      removePending(key, operation.requestId);
      alertForRequest("股票服务未接受这项操作。检查输入后，可由你主动重新提交。", true);
      return "rejected";
    }

    const body = validReceiptBody(record, "completed");
    if (!body) {
      failClosed("操作回执不完整，结果尚未确认。系统不会自动重发。");
      return "blocked";
    }
    if (activeKeyRef.current === key) setAlertMessage(null);

    if (operation.kind === "create") {
      const sessionId = body.session_id;
      if (!isObjectId(sessionId)) {
        failClosed("会话回执缺少有效标识，无法安全继续。请先核对状态。");
        return "blocked";
      }
      const saved = removePending(key, operation.requestId, { sessionId, attemptId: null });
      if (saved && activeKeyRef.current === key) {
        verifiedSessionRef.current = sessionId;
        setVerifiedSessionId(sessionId);
        setNotice("会话已就绪。问题尚未提交，请再次点击发送继续。");
      }
      return saved ? "confirmed" : "blocked";
    }

    if (operation.kind === "send") {
      const attemptId = body.attempt_id;
      if (!isObjectId(attemptId)) {
        failClosed("消息回执缺少有效执行标识，结果尚未确认。系统不会自动重发。");
        return "blocked";
      }
      const saved = removePending(key, operation.requestId, {
        attemptId,
        attachments: [],
        draft: "",
      });
      if (saved && activeKeyRef.current === key) {
        setDraft("");
        setAttempt(null);
        setNotice("问题已提交，正在开始研究。");
        changedRef.current?.();
      }
      return saved ? "confirmed" : "blocked";
    }

    if (operation.kind === "upload") {
      const filePath = body.file_path;
      if (!safeUploadPath(filePath) || !operation.filename) {
        failClosed("附件回执路径无效，附件尚未加入消息。系统不会自动重传。");
        return "blocked";
      }
      const attachment: UploadedAttachment = {
        filename: operation.filename,
        filePath,
        requestId: operation.requestId,
      };
      const current = activeKeyRef.current === key ? storedRef.current : readStoredResearch(key);
      const saved = removePending(key, operation.requestId, {
        attachments: [...current.attachments, attachment],
      });
      if (saved && activeKeyRef.current === key) {
        setSelectedFile(null);
        setInlineError(null);
        setNotice("附件已确认上传，可在下一条消息中引用。");
      }
      return saved ? "confirmed" : "blocked";
    }

    const cancelStatus = body.status;
    if (cancelStatus !== "cancelled" && cancelStatus !== "no_active_loop") {
      failClosed("取消回执状态无法确认。系统会继续读取原生执行记录。");
      return "blocked";
    }
    const saved = removePending(key, operation.requestId);
    if (saved && activeKeyRef.current === key) {
      setNotice("取消请求已收到，正在确认研究状态。");
      setHistoryRevision((value) => value + 1);
    }
    return saved ? "confirmed" : "blocked";
  }, [removePending, setRequestPhase, showAlert]);

  const processRequestRef = useRef(processRequest);
  processRequestRef.current = processRequest;

  useEffect(() => {
    if (!enabled || !storageKey || hydratedKey !== storageKey) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const pending = storedRef.current.pending.filter((item) => item.phase === "checking");
      if (!pending.length) return;
      for (const operation of pending) {
        try {
          const record = await getStockVibeRequest(operation.requestId);
          if (stopped) return;
          processRequestRef.current(storageKey, operation, record);
        } catch {
          if (stopped) return;
          showAlertRef.current(
            `request:${operation.requestId}`,
            "暂时无法核对操作状态。请勿重复提交，系统会继续查询。",
          );
        }
      }
      if (!stopped && storedRef.current.pending.some((item) => item.phase === "checking")) {
        timer = setTimeout(poll, 5000);
      }
    };

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, hydratedKey, pendingSignature, storageKey]);

  useEffect(() => {
    const opening = open && !sessionWasOpen.current;
    sessionWasOpen.current = open;
    if (!open || !enabled || !storageKey || hydratedKey !== storageKey || !storedSessionId) return undefined;
    let stopped = false;
    if (opening) setVerifiedSessionId(null);
    const load = async () => {
      const observedAttemptId = storedRef.current.attemptId;
      const hadPendingWrite = writeLock.current || storedRef.current.pending.length > 0;
      try {
        const [sessionResult, messageResult] = await Promise.all([
          getStockVibeSession(storedSessionId),
          getStockVibeMessages(storedSessionId),
        ]);
        const nativeSession = sessionResult.native;
        if (!isRecord(nativeSession) || nativeSession.session_id !== storedSessionId
          || journalOperationId && nativeSession.journal_operation_id !== journalOperationId) {
          if (stopped || activeKeyRef.current !== storageKey) return;
          verifiedSessionRef.current = null;
          setVerifiedSessionId(null);
          setAttempt(null);
          setMessages([]);
          showAlert(`session-mismatch:${storedSessionId}`, "读取的研究记录与原会话不一致，已停止追问。请从研究记录重新进入。");
          return;
        }
        const nextMessages = parseMessages(messageResult.native);
        if (stopped || activeKeyRef.current !== storageKey) return;
        verifiedSessionRef.current = storedSessionId;
        setVerifiedSessionId(storedSessionId);
        const nativeAttemptId = isObjectId(nativeSession.last_attempt_id) ? nativeSession.last_attempt_id : null;
        const followLatest = !resumeAttemptId && !hadPendingWrite && !writeLock.current && !storedRef.current.pending.length
          && storedRef.current.attemptId === observedAttemptId;
        const targetAttemptId = followLatest ? nativeAttemptId ?? storedAttemptId : storedRef.current.attemptId;
        const answerIndex = nextMessages.map((message) => message.role === "assistant" && message.linked_attempt_id === targetAttemptId).lastIndexOf(true);
        setMessages(answerIndex >= 0 && !followLatest ? nextMessages.slice(0, answerIndex + 1) : nextMessages);
        const relatedMessages = answerIndex >= 0 ? nextMessages.slice(0, answerIndex)
          : !targetAttemptId || nativeAttemptId === targetAttemptId ? nextMessages : [];
        const savedResearch = [...relatedMessages].reverse().find((message) => message.role === "user")?.metadata.research;
        const savedContext = isRecord(savedResearch) ? savedResearch : resumeScope;
        if (savedContext && (savedContext.symbol === null || typeof savedContext.symbol === "string" && SYMBOL_PATTERN.test(savedContext.symbol))
          && ["ultrashort", "swing", "medium"].includes(String(savedContext.mode))) {
          setScope({ symbol: savedContext.symbol as string | null, mode: savedContext.mode as ResearchMode });
          setScopeRecorded(true);
        } else if (resumeSessionId) {
          setScopeRecorded(false);
          setScope({ symbol: null, mode: initialMode });
        }
        if (resumeScope?.task) setTask(resumeScope.task);

        if (followLatest && nativeAttemptId && nativeAttemptId !== storedRef.current.attemptId) {
          updateStored(storageKey, (current) => ({ ...current, attemptId: nativeAttemptId }));
        }
      } catch (error) {
        if (!stopped) showAlert(`session:${storedSessionId}`, safeApiError(error));
      }
    };
    void load();
    return () => {
      stopped = true;
    };
  }, [enabled, historyRevision, hydratedKey, journalOperationId, open, resumeAttemptId, resumeScope?.symbol, resumeScope?.mode, resumeScope?.task, resumeSessionId, showAlert, storageKey, storedAttemptId, storedSessionId, updateStored]);

  useEffect(() => {
    if (!enabled || !storageKey || hydratedKey !== storageKey || !storedSessionId || !storedAttemptId
      || verifiedSessionId !== storedSessionId) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const result = await getStockVibeAttempt(storedSessionId, storedAttemptId);
        const current = parseAttempt(result.native, storedSessionId, storedAttemptId);
        if (!current) {
            showAlert(`attempt-invalid:${storedAttemptId}`, "无法确认研究状态，报告暂不可用。");
          return;
        }
        if (stopped || activeKeyRef.current !== storageKey) return;
        setAttempt(current);
        if (POLLING_ATTEMPT_STATUSES.has(current.status)) {
          timer = setTimeout(poll, 5000);
        } else {
          setNotice(null);
          setHistoryRevision((value) => value + 1);
          if (current.status === "failed" || current.status === "interrupted") {
            showAlert(`attempt:${storedAttemptId}:${current.status}`, "本次研究未能完成。请查看会话记录后，再决定是否追问。");
          }
        }
      } catch {
        if (stopped) return;
        showAlert(`attempt-read:${storedAttemptId}`, "暂时无法读取研究状态，系统会继续核对。");
        timer = setTimeout(poll, 5000);
      }
    };

    setAttempt(null);
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, hydratedKey, showAlert, storageKey, storedAttemptId, storedSessionId, verifiedSessionId]);

  const runWrite = useCallback(async (
    kind: RequestKind,
    details: Omit<PendingRequest, "requestId" | "kind" | "phase">,
    write: (requestId: string) => Promise<StockVibeRequestRecord>,
  ): Promise<RequestOutcome> => {
    if (!enabled || !canSubmit || !storageKey || hydratedKey !== storageKey || writeLock.current) return "blocked";
    if (storedRef.current.sessionId && verifiedSessionRef.current !== storedRef.current.sessionId) return "blocked";
    if (storedRef.current.pending.length) return "blocked";
    const requestId = newRequestId();
    const operation: PendingRequest = { requestId, kind, phase: "dispatching", ...details };
    const saved = updateStored(storageKey, (current) => ({
      ...current,
      pending: [...current.pending, operation],
    }));
    if (!saved) return "blocked";

    writeLock.current = true;
    setWriting(true);
    try {
      const record = await write(requestId);
      return processRequestRef.current(storageKey, operation, record);
    } catch (error) {
      setRequestPhase(storageKey, requestId, "checking");
      showAlert(`request:${requestId}`, safeApiError(error));
      return "pending";
    } finally {
      writeLock.current = false;
      if (activeKeyRef.current === storageKey) setWriting(false);
    }
  }, [canSubmit, enabled, hydratedKey, removePending, setRequestPhase, showAlert, storageKey, updateStored]);

  const pending = stored.pending.length > 0;
  const ready = enabled && Boolean(storageKey) && hydratedKey === storageKey
    && (!storedSessionId || verifiedSessionId === storedSessionId);
  const locked = !ready || !canSubmit || writing || pending;
  const activeAttempt = attempt && POLLING_ATTEMPT_STATUSES.has(attempt.status);
  const attemptBusy = Boolean((attempt && BUSY_ATTEMPT_STATUSES.has(attempt.status)) || storedAttemptId && !attempt);
  const reportMessage = storedAttemptId
    ? messages.find((message) => message.role === "assistant" && message.linked_attempt_id === storedAttemptId)?.content
    : undefined;
  const report = attempt?.status === "completed" ? (attempt.summary || reportMessage || "研究已完成，但没有返回报告正文。") : null;
  const trail = messages.filter((message) => message.linked_attempt_id === storedAttemptId).flatMap((message) => message.tool_trail);
  const priorAttachments = [...new Map(messages.filter((message) => message.role === "user").flatMap((message) =>
    Array.isArray(message.metadata.attachments) ? message.metadata.attachments.filter(isRecord).flatMap((file) =>
      safeUploadPath(file.file_path) && typeof file.filename === "string" ? [[file.file_path, { file_path: file.file_path, filename: file.filename }] as const] : []) : [],
  )).values()].filter((file) => !stored.excludedAttachments?.includes(file.file_path));


  useEffect(() => {
    setActivity(null);
    if (!enabled || !storedSessionId || verifiedSessionId !== storedSessionId || !storedAttemptId || !attemptBusy || typeof EventSource === "undefined") return;
    let stopped = false;
    let stream: EventSource | undefined;
    void getStockVibeEventStreamUrl(newRequestId(), { kind: "session", object_id: storedSessionId }).then((url) => {
      if (stopped) return;
      stream = new EventSource(url);
      for (const eventType of ["tool_call", "tool_result"]) {
        stream.addEventListener(eventType, (event) => {
          if (stopped) return;
          try {
            const data: unknown = JSON.parse((event as MessageEvent).data);
            if (!isRecord(data) || data.attempt_id !== storedAttemptId) return;
            setActivity(eventType === "tool_call" ? `正在${toolLabel(data.tool)}`
              : data.status === "ok" ? `${toolLabel(data.tool)}已完成，继续分析中` : `${toolLabel(data.tool)}未完成，正在核对缺项`);
          } catch { /* State polling remains authoritative when an event is incomplete. */ }
        });
      }
      stream.onerror = () => { stream?.close(); if (!stopped) setActivity("进度更新暂时中断，正在核对研究状态"); };
    }).catch(() => { if (!stopped) setActivity("正在核对研究状态"); });
    return () => { stopped = true; stream?.close(); };
  }, [attemptBusy, enabled, storedAttemptId, storedSessionId, verifiedSessionId]);
  const groundingNote = attempt?.status === "completed"
    ? attempt.grounding_validation?.valid === true
      ? "数值匹配检查已通过，分析结论仍需复核。"
      : attempt.grounding_validation?.valid === false
        ? "数字与证据核对未通过。"
        : "未取得数字与证据核对记录。"
    : null;

  const submitMessage = async () => {
    const text = draft.trim();
    if (!text && stored.attachments.length === 0 && !selectedFile) {
      setInlineError("请输入研究问题，或先上传附件。");
      return;
    }
    setInlineError(null);
    if (selectedFile && await uploadFile() !== "confirmed") return;
    const content = text || "请读取并分析我附上的资料。";
    const attachments = [...new Map([
      ...priorAttachments, ...storedRef.current.attachments.map((attachment) => ({ file_path: attachment.filePath, filename: attachment.filename })),
    ].map((file) => [file.file_path, file])).values()];
    if (attachments.length > 10) { setInlineError("一次最多使用10份资料，请先移除不需要的附件。"); return; }
    let sessionId = storedSessionId;
    if (!sessionId) {
      const creation = await runWrite(
        "create",
        {},
        (requestId) => createStockVibeSession(requestId, journalOperationId ? {
          title: title ?? "成交复盘解读", journal_operation_id: journalOperationId,
        } : context ? {
          title: `${context.symbol} · ${TASK_LABEL[context.task]} · ${MODE_LABEL[context.mode]}`,
          workbench: context,
          ...(nativeResearch ? { native_research: nativeResearch } : {}),
        } : { title: strategyCreation ? nativeResearch?.strategy_id ? "修改策略" : "创建策略" : nativeResearch?.strategy_id ? "原生策略复用研究" : symbol ? `${symbol}研究` : "A股股票池研究", ...(nativeResearch ? { native_research: nativeResearch } : {}), ...(strategyCreation ? { strategy_creation: true } : {}) }),
      );
      if (creation !== "confirmed") return;
      sessionId = storedRef.current.sessionId;
      if (!sessionId) return;
      setNotice(null);
    }
    await runWrite("send", { sessionId }, (requestId) =>
      sendStockVibeMessage(sessionId, requestId, {
        content, ...(!journalOperationId && !strategyCreation && (!resumeSessionId || scopeRecorded) ? { research: { symbol, mode } } : {}),
        ...(attachments.length ? { attachments } : {}),
      }),
    );
  };

  /**
   * 追问带进来的问题在本地已是一次明确提交，弹窗只负责展示进度。
   * 这里只自动派发一次：同一问题重复渲染不再触发，用户改动草稿后也不再被覆盖。
   */
  const autoSent = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSend || !enabled || !storageKey || hydratedKey !== storageKey) return;
    const text = initialQuestion?.trim();
    if (!text || draft.trim() !== text || locked) return;
    const identity = `${storageKey}|${text}`;
    if (autoSent.current === identity) return;
    autoSent.current = identity;
    void submitMessage();
  }, [autoSend, draft, enabled, hydratedKey, initialQuestion, locked, storageKey, submitMessage]);

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    setInlineError(null);
    if (!file) return;
    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (file.size < 1 || file.size > MAX_UPLOAD_BYTES) {
      setSelectedFile(null);
      setInlineError("附件需为 1 字节至 8MB。");
    } else if (!ALLOWED_EXTENSIONS.has(extension)) {
      setSelectedFile(null);
      setInlineError("附件格式支持 CSV、TSV、Excel、PDF、Word、TXT 或 Markdown。");
    } else {
      setSelectedFile(file);
    }
  };

  const uploadFile = async (): Promise<RequestOutcome> => {
    if (!selectedFile || locked) return "blocked";
    const file = selectedFile;
    try {
      const dataBase64 = await encodeFile(file);
      return await runWrite("upload", { filename: file.name }, (requestId) =>
        uploadStockVibeFile(requestId, file.name, dataBase64),
      );
    } catch {
      if (activeKeyRef.current === storageKey) {
        showAlert(`file:${file.name}`, "无法读取所选附件。请重新选择文件后再试。");
      }
      return "blocked";
    }
  };

  const exportReport = () => {
    if (!report) return;
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${symbol?.slice(0, 6) ?? "研究"}-${storedAttemptId ?? "报告"}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const removeAttachment = (requestId: string) => {
    if (!storageKey || locked) return;
    updateStored(storageKey, (current) => ({
      ...current,
      attachments: current.attachments.filter((item) => item.requestId !== requestId),
    }));
  };

  const cancelAttempt = () => {
    if (!storedSessionId || !storedAttemptId || !activeAttempt || locked) return;
    void runWrite(
      "cancel",
      { sessionId: storedSessionId, attemptId: storedAttemptId },
      (requestId) => cancelStockVibeSession(storedSessionId, requestId),
    );
  };

  const retryChecks = () => {
    if (!storageKey || !stored.pending.some((item) => item.phase === "blocked")) return;
    updateStored(storageKey, (current) => ({
      ...current,
      pending: current.pending.map((item) => item.phase === "blocked" ? { ...item, phase: "checking" } : item),
    }));
  };

  if (!enabled) {
    return <EmptyState title="研究暂不可用" description="启用股票研究后可开始对话。" />;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className={`scrollbar-scope stock-vibe-research-dialog flex max-h-[88dvh] max-w-4xl flex-col gap-3 ${storedSessionId ? "h-[min(48rem,88dvh)]" : ""}`}>
      <DialogHeader className="shrink-0 pr-6">
        <DialogTitle>{task ? TASK_LABEL[task] : title ?? "研究详情"}</DialogTitle>
        <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-muted-foreground">
          <p>{strategyCreation ? strategyName ? `来源：${strategyName}。描述你想调整的规则，生成结果会进入策略库。` : "描述你想创建的规则，生成结果会进入策略库。" : journalOperationId ? "基于所选成交复盘，可继续追问" : <>{symbol ? symbol.slice(0, 6) : "原研究范围"} · {storedSessionId && !scopeRecorded ? "原记录未保存研究周期" : MODE_LABEL[mode]}</>}</p>
        </div>
      </DialogHeader>
    <section className="stock-vibe-research" aria-label="研究详情内容">

      <div className="stock-vibe-research-reader" role="region" aria-label="研究内容">
        {resumeSessionId && !resumeAttemptId && !pending && !writing && verifiedSessionId === resumeSessionId && <p className="text-caption text-muted-foreground">已打开这项研究的最新记录，可继续追问。</p>}
        {messages.filter((message) => (message.role === "user" || message.role === "assistant")
          && !(report && message.role === "assistant" && message.linked_attempt_id === storedAttemptId)).map((message) => (
          <article key={message.message_id} className={message.role === "user" ? "stock-vibe-research-question" : "stock-vibe-research-answer"}>
            <h3 className="text-caption font-medium">{message.role === "user" ? "你" : "研究回复"}</h3>
            {message.role === "assistant" ? <StockVibeReport>{message.content}</StockVibeReport>
              : <p className="whitespace-pre-wrap break-words text-body">{visibleQuestion(message)}</p>}
            {Array.isArray(message.metadata.attachments) && message.metadata.attachments.filter(isRecord).map((file, index) =>
              typeof file.filename === "string" ? <p key={index} className="text-caption text-muted-foreground">附件：{file.filename}</p> : null)}
          </article>
        ))}
        {report && <article className="stock-vibe-research-answer" aria-label="本次研究报告">
          <div className="stock-vibe-research-report-actions">
            <h3 className="text-caption font-medium">本次报告 · {stockTime(attempt?.completed_at)}</h3>
            <Button type="button" variant="ghost" size="sm" onClick={exportReport}>导出 Markdown</Button>
          </div>
          {groundingNote && <p className={`text-caption ${attempt?.grounding_validation?.valid === false ? "text-destructive" : "text-muted-foreground"}`}>{groundingNote}</p>}
          <StockVibeReport>{report}</StockVibeReport>
          <StockVibeInfo title="本次研究依据" label="查看研究依据">
            {trail.length ? <ul className="space-y-3">{trail.map((entry, index) => {
              const argumentsValue = isRecord(entry.arguments) ? entry.arguments : {};
              return <li key={index}><p className="font-medium">{toolLabel(entry.tool)} · {entry.status === "ok" ? "已完成" : entry.status === "error" ? "未完成" : "结果待核对"}</p>
                {["symbol", "code", "source", "start_date", "end_date"].flatMap((field) => typeof argumentsValue[field] === "string"
                  ? <p key={field} className="text-muted-foreground">{{ symbol: "标的", code: "标的", source: "请求数据源", start_date: "开始日期", end_date: "结束日期" }[field]}：{String(argumentsValue[field])}</p> : [])}</li>;
            })}</ul> : <p>这份报告没有可读取的工具调用记录，请核查报告中的引用和资料时点。</p>}
          </StockVibeInfo>
        </article>}
        {registeredStrategies.length > 0 && <div className="space-y-2" aria-label="已生成策略">{[...new Map(registeredStrategies.map((item) => [`${item.strategy_id}:${item.version}`, item])).values()].map((item) => <div key={`${item.strategy_id}:${item.version}`} className="flex items-center justify-between gap-3 rounded-md bg-muted/40 p-3"><div><p className="text-ui font-medium">{item.name}</p><p className="text-caption text-muted-foreground">自定义 · 代码已就绪</p></div>{onOpenStrategy && <Button type="button" size="sm" variant="ghost" onClick={() => onOpenStrategy(item.strategy_id)}>查看策略</Button>}</div>)}</div>}
        {(attemptBusy || attempt?.status === "waiting_user") && <p className="stock-vibe-research-activity text-caption" role="status">
          {attempt?.status === "waiting_user" ? "需要你补充信息，可在下方继续回答。" : activity ?? "正在研究，完成后会在这里显示结果。"}
        </p>}
        {attempt && ["failed", "cancelled", "interrupted"].includes(attempt.status) && <p className="text-caption text-muted-foreground" role="status">
          {attempt.status === "cancelled" ? "本次研究已取消。" : "本次研究未完成，已保留现有记录。你可以补充问题后继续。"}
        </p>}
      </div>

      <div className="stock-vibe-research-composer">
        {!canSubmit && <div className="flex items-center gap-2 text-caption text-muted-foreground"><p>{onOpenModel ? "选择研究模型后可发送问题。" : "暂时无法提交研究，已有记录仍可查看。"}</p>
          {onOpenModel && <Button type="button" variant="secondary" size="sm" onClick={onOpenModel}>选择模型</Button>}</div>}
        {notice && !attemptBusy && <p className="text-caption text-muted-foreground" role="status">{notice}</p>}
        {pending && <div className="flex items-center gap-2 text-caption" role="status"><span>正在确认提交结果，请稍候。</span>
          {stored.pending.some((item) => item.phase === "blocked") && <Button type="button" size="sm" variant="secondary" onClick={retryChecks}>再次核对</Button>}
        </div>}
        <label className="sr-only" htmlFor="stock-vibe-research-question">{storedSessionId ? "追问" : "研究问题"}</label>
        <Textarea id="stock-vibe-research-question" value={draft} rows={3} disabled={locked || attemptBusy}
          placeholder={strategyCreation ? "描述选股规则，或说明你想调整的策略…" : storedSessionId ? "接着这份研究继续问…" : "例如：这家公司的盈利增长，有现金流支持吗？"}
          onChange={(event) => { setDraft(event.target.value); setInlineError(null); }} />
        <div className="stock-vibe-research-composer-actions">
          <label className="stock-vibe-research-attachment text-caption" htmlFor="stock-vibe-research-file">添加资料
            <input id="stock-vibe-research-file" type="file" accept=".csv,.tsv,.xls,.xlsx,.pdf,.docx,.txt,.md"
              onChange={chooseFile} disabled={locked || attemptBusy} aria-label="附件" aria-describedby="stock-vibe-attachment-limit" />
          </label>
          <span id="stock-vibe-attachment-limit" className="text-caption text-muted-foreground">单份资料最多 8MB</span>
          <Button className="stock-vibe-research-send" type="button" variant="interaction" disabled={locked || attemptBusy} onClick={submitMessage}>发送</Button>
          {activeAttempt && <Button type="button" variant="ghost" disabled={locked} onClick={cancelAttempt}>取消研究</Button>}
        </div>
        {selectedFile && <div className="flex items-center gap-2 text-caption"><span>{selectedFile.name} · 将随消息上传</span>
          <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => setSelectedFile(null)}>移除</Button></div>}
        {stored.attachments.map((attachment) => <div key={attachment.requestId} className="flex items-center gap-2 text-caption">
          <span>{attachment.filename} · 已就绪</span><Button type="button" variant="ghost" size="sm" disabled={locked || attemptBusy}
            aria-label={`移除附件 ${attachment.filename}`} onClick={() => removeAttachment(attachment.requestId)}>移除</Button></div>)}
        {priorAttachments.map((file) => <div key={file.file_path} className="flex items-center gap-2 text-caption">
          <span>{file.filename} · 本次追问沿用</span><Button type="button" variant="ghost" size="sm" disabled={locked || attemptBusy}
            aria-label={`本次不使用 ${file.filename}`} onClick={() => {
              if (storageKey) updateStored(storageKey, (current) => ({ ...current, excludedAttachments: [...(current.excludedAttachments ?? []), file.file_path] }));
            }}>移除</Button></div>)}
        {inlineError && <p className="text-caption text-destructive" role="alert">{inlineError}</p>}
      </div>
      <AlertDialog open={alertMessage !== null} onOpenChange={(open) => { if (!open) setAlertMessage(null); }}>
        <AlertDialogContent className="scrollbar-scope"><AlertDialogHeader><AlertDialogTitle>研究操作未能完成</AlertDialogTitle>
          <AlertDialogDescription>{alertMessage}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>知道了</AlertDialogCancel></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
      </DialogContent>
    </Dialog>
  );
}
