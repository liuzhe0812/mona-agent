import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

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
import { Input } from "@/components/ui/input";
import { SectionHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StockVibeInfo } from "./StockVibeInfo";
import { StockVibeShadowResult } from "./StockVibeShadowResult";
import { StockVibeJournalResult } from "./StockVibeJournalResult";
import {
  downloadStockVibeArtifact,
  getStockVibeOperation,
  getStockVibePortfolio,
  getStockVibePortfolioStatus,
  getStockVibeRequest,
  getStockVibeShadowProfile,
  listStockVibeOperations,
  listStockVibeShadowProfiles,
  listStockVibeUploads,
  startStockVibeOperation,
  StockVibeApiError,
  uploadStockVibeFile,
  type StockVibeArtifactKind,
  type StockVibeOperationInput,
  type StockVibeRequestRecord,
  type StockVibeSource,
  type StockVibeUploadReceipt,
} from "@/lib/stock-vibe-api";
import "./stock-vibe-operations.css";

type OperationStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
type TrackedStatus = OperationStatus | "dispatching" | "checking_request" | "checking_operation" | "unknown" | "rejected" | "uploaded";
type UploadId = string;

interface StoredUpload {
  uploadId: UploadId;
  filename: string;
  requestId: string;
  uploadedAt: string;
}

interface AvailableUpload extends StoredUpload {
  sizeBytes: number | null;
  source?: StockVibeSource;
}

interface TrackedWrite {
  requestId: string;
  kind: "operation" | "upload";
  label: string;
  status: TrackedStatus;
  createdAt: string;
  operationInput?: StockVibeOperationInput;
  operationId?: string;
  fileName?: string;
  uploadId?: UploadId;
}

interface SavedState {
  writes: TrackedWrite[];
  uploads: StoredUpload[];
}

interface NativeOperation {
  operation_id: string;
  operation: string;
  status: OperationStatus;
  payload?: Record<string, unknown>;
  references?: Record<string, unknown>;
  source?: Record<string, unknown>;
  tool_result?: unknown;
  tool_result_raw?: string;
  error_category?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface NativeProfile {
  shadow_id: string;
  created_at?: string;
  source_market?: string;
  profitable_roundtrips?: number;
  total_roundtrips?: number;
  profile_text?: string;
  rules?: unknown[];
  typical_holding_days?: unknown[];
}

interface ReportArtifact {
  kind: StockVibeArtifactKind;
  id: string;
  filename: string;
  label: string;
}

const STORAGE_KEY = "mona.stock-vibe.operations.v1";
const REQUEST_ID = /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
const OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHADOW_ID = /^shadow_[0-9a-f]{8}$/i;
const UPLOAD_PATH = /^uploads\/([a-f0-9]{32})\.(csv|xls|xlsx)$/i;
const OPERATION_STATUSES = new Set<OperationStatus>(["queued", "running", "completed", "failed", "interrupted"]);
const TERMINAL_TRACKED = new Set<TrackedStatus>(["completed", "failed", "interrupted", "rejected", "uploaded"]);
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ACCOUNT_OPERATIONS = new Set([
  "analyze_trade_journal", "extract_shadow_strategy", "run_shadow_backtest", "render_shadow_report", "scan_shadow_signals",
]);
const SOURCE_OPTIONS = [
  { value: "auto", label: "自动选择" },
  { value: "local", label: "本地数据" },
  { value: "tencent", label: "腾讯行情" },
  { value: "eastmoney", label: "东方财富行情" },
];

const emptySavedState = (): SavedState => ({ writes: [], uploads: [] });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID.test(value);
}

function normalizedRequestId(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

function isoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function readOperationInput(value: unknown): StockVibeOperationInput | undefined {
  if (!isRecord(value) || typeof value.operation !== "string") return undefined;
  switch (value.operation) {
    case "backtest":
    case "strategy_oos_validation":
      return typeof value.run_id === "string" && objectId(value.run_id)
        ? value as unknown as StockVibeOperationInput
        : undefined;
    case "strict_factor_validation":
      return (value.zoo === "alpha101" || value.zoo === "qlib158") && typeof value.start_date === "string"
        && typeof value.end_date === "string" && typeof value.oos_cutoff === "string"
        ? value as unknown as StockVibeOperationInput : undefined;
    case "analyze_trade_journal":
    case "extract_shadow_strategy":
      return typeof value.upload_id === "string" && /^[a-f0-9]{32}$/i.test(value.upload_id)
        ? { operation: value.operation, upload_id: value.upload_id }
        : undefined;
    case "run_shadow_backtest":
    case "render_shadow_report":
    case "scan_shadow_signals":
      return typeof value.shadow_id === "string" && SHADOW_ID.test(value.shadow_id)
        ? value as unknown as StockVibeOperationInput
        : undefined;
    default:
      return undefined;
  }
}

function readSavedState(): SavedState {
  if (typeof window === "undefined") return emptySavedState();
  try {
    const payload: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!isRecord(payload)) return emptySavedState();
    const writes = Array.isArray(payload.writes)
      ? payload.writes.flatMap((value): TrackedWrite[] => {
        if (!isRecord(value) || typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)
          || (value.kind !== "operation" && value.kind !== "upload")
          || typeof value.label !== "string" || typeof value.createdAt !== "string") return [];
        const status: TrackedStatus = [
          "queued", "running", "completed", "failed", "interrupted", "dispatching",
          "checking_request", "checking_operation", "unknown", "rejected", "uploaded",
        ].includes(String(value.status)) ? value.status as TrackedStatus : "unknown";
        return [{
          requestId: value.requestId,
          kind: value.kind,
          label: value.label,
          status: status === "dispatching" ? "checking_request" : status,
          createdAt: value.createdAt,
          ...(readOperationInput(value.operationInput) ? { operationInput: readOperationInput(value.operationInput) } : {}),
          ...(objectId(value.operationId) ? { operationId: value.operationId } : {}),
          ...(typeof value.fileName === "string" ? { fileName: value.fileName } : {}),
          ...(typeof value.uploadId === "string" && /^[a-f0-9]{32}$/i.test(value.uploadId) ? { uploadId: value.uploadId } : {}),
        }];
      })
      : [];
    const uploads = Array.isArray(payload.uploads)
      ? payload.uploads.flatMap((value): StoredUpload[] => {
        if (!isRecord(value) || typeof value.uploadId !== "string" || !/^[a-f0-9]{32}$/i.test(value.uploadId)
          || typeof value.filename !== "string" || typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)
          || typeof value.uploadedAt !== "string") return [];
        return [{ uploadId: value.uploadId, filename: value.filename, requestId: value.requestId, uploadedAt: value.uploadedAt }];
      })
      : [];
    return { writes, uploads };
  } catch {
    return emptySavedState();
  }
}

function parseOperation(value: unknown): NativeOperation | null {
  if (!isRecord(value) || !objectId(value.operation_id) || typeof value.operation !== "string"
    || !ACCOUNT_OPERATIONS.has(value.operation) || !OPERATION_STATUSES.has(value.status as OperationStatus)) return null;
  return value as unknown as NativeOperation;
}

function isAccountWrite(entry: TrackedWrite): boolean {
  return entry.kind === "upload" || Boolean(entry.operationInput && ACCOUNT_OPERATIONS.has(entry.operationInput.operation));
}

function parseOperations(value: unknown): NativeOperation[] {
  const container = isRecord(value) ? value : null;
  const rows = Array.isArray(value) ? value : Array.isArray(container?.operations) ? container.operations : [];
  return rows.flatMap((row): NativeOperation[] => {
    const parsed = parseOperation(row);
    return parsed ? [parsed] : [];
  });
}

function parseProfiles(value: unknown): NativeProfile[] {
  const container = isRecord(value) ? value : null;
  const rows = Array.isArray(value) ? value : Array.isArray(container?.profiles) ? container.profiles : [];
  return rows.flatMap((row): NativeProfile[] => {
    if (!isRecord(row) || typeof row.shadow_id !== "string" || !SHADOW_ID.test(row.shadow_id)) return [];
    return [row as unknown as NativeProfile];
  });
}

function requestReceiptBody(record: StockVibeRequestRecord): Record<string, unknown> | null {
  if (record.status !== "completed") return null;
  if (!record.receipt || !/^[a-f0-9]{64}$/i.test(record.receipt_sha256 ?? "")) return null;
  const code = record.receipt.status_code;
  if (!Number.isInteger(code) || code < 200 || code >= 300) return null;
  if (!isRecord(record.receipt.body)) return null;
  return record.receipt.body;
}

function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function operationLabel(input: StockVibeOperationInput): string {
  switch (input.operation) {
    case "backtest": return `原生回测 · 输入 ${input.run_id}`;
    case "strategy_oos_validation": return `独立验证 · 输入 ${input.run_id}`;
    case "strict_factor_validation": return `严格因子检验 · ${input.zoo === "alpha101" ? "Alpha101" : "Qlib158"}`;
    case "analyze_trade_journal": return `成交统计 · 附件 ${input.upload_id.slice(0, 8)}`;
    case "extract_shadow_strategy": return `提取规则 · 附件 ${input.upload_id.slice(0, 8)}`;
    case "run_shadow_backtest": return `画像回测 · ${input.shadow_id}`;
    case "render_shadow_report": return `生成报告 · ${input.shadow_id}`;
    case "scan_shadow_signals": return `扫描信号 · ${input.shadow_id}`;
  }
}

function operationTitle(operation: string): string {
  const titles: Record<string, string> = {
    backtest: "策略回测",
    strategy_oos_validation: "独立区间验证",
    strict_factor_validation: "严格因子检验",
    analyze_trade_journal: "成交复盘",
    extract_shadow_strategy: "提取交易规则",
    run_shadow_backtest: "历史模拟",
    render_shadow_report: "实验报告",
    scan_shadow_signals: "信号扫描",
  };
  return titles[operation] ?? operation;
}

function operationFailureMessage(operation: NativeOperation): string {
  const reason = isRecord(operation.tool_result) ? operation.tool_result.reason : null;
  const reasonCode = isRecord(operation.tool_result) ? operation.tool_result.reason_code : null;
  if (reasonCode === "tushare_token_unconfigured") return "尚未配置 Tushare Pro 行情服务；本次未发起网络取数。";
  if (reasonCode === "csi300_constituents_degraded") return "沪深 300 成分数据已降级，本次严格检验不可用。";
  if (reason === "backtest_cache_miss") return "没有与本次区间、来源、样本数和成交附件一致的回测，请先完成同输入回测。";
  if (reason === "no_usable_metrics") return "当前数据范围没有可用回测指标，请核对日期、行情来源和样本覆盖后重新验证。";
  return "本次任务未完成，请核对输入与服务状态后重新发起。";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    dispatching: "准备提交",
    checking_request: "核对提交回执",
    checking_operation: "读取任务状态",
    unknown: "结果未知 · 继续核对",
    pending: "等待提交确认",
    queued: "排队中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    interrupted: "服务重启后中断",
    rejected: "未接受",
    uploaded: "上传已确认",
  };
  return labels[status] ?? status;
}

function safeError(error: unknown): string {
  return error instanceof StockVibeApiError
    ? error.message
    : "股票服务暂时无法读取，请检查服务状态后再试。";
}

function jsonForDisplay(value: unknown): string {
  return JSON.stringify(sanitizeNative(value), null, 2);
}

function sanitizeNative(value: unknown, key = ""): unknown {
  if (/(?:path|dir|file_path|url)$/i.test(key) || /(?:^|_)(?:path|dir)(?:_|$)/i.test(key)) return "（本机路径已隐藏）";
  if (typeof value === "string") {
    if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)) return "（本机路径已隐藏）";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeNative(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitizeNative(child, childKey)]));
  }
  return value;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function encodeFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("file_encoding"));
      else resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error("file_read"));
    reader.readAsDataURL(file);
  });
}

export interface StockVibeReviewQuestion {
  operationId: string;
  filename?: string;
  question: string;
}

interface StockVibeOperationsProps {
  enabled: boolean;
  onReviewQuestion?: (input: StockVibeReviewQuestion) => void;
}

function displayNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "未提供";
}

function displayDate(value: unknown): string {
  return typeof value === "string" ? value.replace("T", " ").replace(/(?:\.\d+)?Z$/, " UTC").slice(0, 24) : "时间未提供";
}

export function StockVibeOperations({ enabled, onReviewQuestion }: StockVibeOperationsProps) {
  const [saved, setSaved] = useState<SavedState>(readSavedState);
  const savedRef = useRef(saved);
  const [serverOperations, setServerOperations] = useState<NativeOperation[]>([]);
  const [operationDetails, setOperationDetails] = useState<Record<string, NativeOperation>>({});
  const [profiles, setProfiles] = useState<NativeProfile[]>([]);
  const [selectedShadowId, setSelectedShadowId] = useState<string | null>(null);
  const [profileNative, setProfileNative] = useState<unknown>(null);
  const [portfolioNative, setPortfolioNative] = useState<unknown>(null);
  const [portfolioStatusNative, setPortfolioStatusNative] = useState<unknown>(null);
  const [portfolioReadError, setPortfolioReadError] = useState<string | null>(null);
  const [shadowReadError, setShadowReadError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedUploadId, setSelectedUploadId] = useState<string | null>(null);
  const [remoteUploads, setRemoteUploads] = useState<StockVibeUploadReceipt[]>([]);
  const [source, setSource] = useState<"auto" | "local" | "tencent" | "eastmoney">("auto");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [scanDate, setScanDate] = useState("");
  const [perMarketCountDraft, setPerMarketCountDraft] = useState("5");
  const [busy, setBusy] = useState(false);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [accountView, setAccountView] = useState("journal");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedJournalId, setSelectedJournalId] = useState<string | null>(null);
  const [reviewOperationId, setReviewOperationId] = useState<string | null>(null);
  const alertKeys = useRef(new Set<string>());
  const writeLock = useRef(false);

  const showAlert = useCallback((key: string, message: string) => {
    if (alertKeys.current.has(key)) return;
    alertKeys.current.add(key);
    setAlertMessage(message);
  }, []);

  const persist = useCallback((update: (current: SavedState) => SavedState, required = false): boolean => {
    const next = update(savedRef.current);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      if (required) {
        showAlert("storage", "无法保存请求核对信息，因此没有提交操作。请检查本机存储后再试。");
        return false;
      }
    }
    savedRef.current = next;
    setSaved(next);
    return true;
  }, [showAlert]);

  const patchWrite = useCallback((requestId: string, patch: Partial<TrackedWrite>) => {
    persist((current) => ({
      ...current,
      writes: current.writes.map((item) => item.requestId === requestId ? { ...item, ...patch } : item),
    }));
  }, [persist]);

  const acceptRequestRecord = useCallback((tracked: TrackedWrite, record: StockVibeRequestRecord) => {
    if (typeof record.request_id !== "string" || !REQUEST_ID.test(record.request_id)
      || normalizedRequestId(record.request_id) !== normalizedRequestId(tracked.requestId)) {
      patchWrite(tracked.requestId, { status: "unknown" });
      showAlert(`request-id:${tracked.requestId}`, "请求回执标识不匹配，结果尚未确认。系统不会自动重发。");
      return;
    }
    if (record.status === "pending" || record.status === "unknown") {
      patchWrite(tracked.requestId, { status: "unknown" });
      return;
    }
    if (record.status === "rejected") {
      if (record.error_category === "not_dispatched" && record.receipt === null && record.source === null) {
        patchWrite(tracked.requestId, { status: "rejected" });
        showAlert(`rejected:${tracked.requestId}`, tracked.kind === "upload"
          ? "股票服务尚未就绪，成交文件没有上传。请稍后重新导入。"
          : "股票服务尚未就绪，本次任务没有发起。请稍后再试。");
        return;
      }
      const code = record.receipt?.status_code;
      const valid = !!record.receipt && /^[a-f0-9]{64}$/i.test(record.receipt_sha256 ?? "")
        && typeof code === "number" && Number.isInteger(code) && code >= 400 && code < 500;
      if (!valid) {
        patchWrite(tracked.requestId, { status: "unknown" });
        showAlert(`rejected:${tracked.requestId}`, "未能确认这次操作是否被接受，正在继续核对。");
        return;
      }
      patchWrite(tracked.requestId, { status: "rejected" });
      showAlert(`rejected:${tracked.requestId}`, tracked.kind === "upload"
        ? "成交文件上传未成功。请核对文件格式和内容后重新导入。"
        : tracked.operationInput?.operation === "analyze_trade_journal"
          ? "本次读取未被接受，未生成新的复盘。请重新选择成交文件后再试。"
          : "本次实验未被接受，没有生成新结果。请核对设置后再试。");
      return;
    }
    const body = requestReceiptBody(record);
    if (!body) {
      patchWrite(tracked.requestId, { status: "unknown" });
      showAlert(`receipt:${tracked.requestId}`, "提交回执不完整，结果仍未知。系统不会自动重发。");
      return;
    }
    if (tracked.kind === "upload") {
      const filePath = stringValue(body.file_path);
      const matched = filePath?.match(UPLOAD_PATH);
      if (!matched) {
        patchWrite(tracked.requestId, { status: "unknown" });
        showAlert(`upload:${tracked.requestId}`, "上传结果尚未确认，正在继续核对；不会自动重复上传。");
        return;
      }
      const upload: StoredUpload = {
        uploadId: matched[1].toLowerCase(),
        filename: tracked.fileName ?? "成交文件",
        requestId: tracked.requestId,
        uploadedAt: new Date().toISOString(),
      };
      persist((current) => ({
        ...current,
        writes: current.writes.map((item) => item.requestId === tracked.requestId
          ? { ...item, status: "uploaded", uploadId: matched[1].toLowerCase() }
          : item),
        uploads: [upload, ...current.uploads.filter((item) => item.uploadId !== matched[1])].slice(0, 20),
      }));
      setSelectedUploadId(matched[1].toLowerCase());
      setSelectedFile(null);
      setRevision((value) => value + 1);
      return;
    }
    const operationId = body.operation_id;
    if (!objectId(operationId)) {
      patchWrite(tracked.requestId, { status: "unknown" });
      showAlert(`operation-id:${tracked.requestId}`, "已收到提交回执，但任务结果尚未确认。系统会继续核对，不会重发。");
      return;
    }
    patchWrite(tracked.requestId, { operationId, status: "checking_operation" });
    setSelectedOperationId(operationId);
    if (tracked.operationInput?.operation === "analyze_trade_journal") {
      setSelectedJournalId(operationId);
      setReviewOperationId(operationId);
      setAccountView("journal");
    }
  }, [patchWrite, persist, showAlert]);

  const loadView = useCallback(async () => {
    if (!enabled) return;
    await Promise.allSettled([
      getStockVibePortfolio().then((result) => {
        setPortfolioNative(result.native);
        setPortfolioReadError(null);
      }).catch(() => {
        setPortfolioReadError("暂时无法读取持仓数据，你仍可导入成交文件进行复盘。");
      }),
      getStockVibePortfolioStatus().then((result) => setPortfolioStatusNative(result.native))
        .catch(() => setPortfolioStatusNative(null)),
      listStockVibeShadowProfiles().then((result) => {
        const nextProfiles = parseProfiles(result.native);
        setProfiles(nextProfiles);
        setShadowReadError(null);
        setSelectedShadowId((current) => current && nextProfiles.some((item) => item.shadow_id === current)
          ? current : nextProfiles[0]?.shadow_id ?? null);
      }).catch(() => {
        setShadowReadError("暂时无法读取已保存的交易规则，你仍可导入成交文件进行复盘。");
      }),
      listStockVibeUploads().then((result) => setRemoteUploads(result.uploads))
        .catch((error: unknown) => showAlert("upload-list", safeError(error))),
    ]);
  }, [enabled, showAlert]);

  useEffect(() => {
    void loadView();
  }, [loadView, revision]);

  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const result = await listStockVibeOperations();
        const list = parseOperations(result.native);
        if (stopped) return;
        setServerOperations(list);
        const local = savedRef.current.writes.filter(isAccountWrite);
        for (const entry of local) {
          if (entry.kind === "upload" && entry.status === "uploaded") continue;
          if (entry.status === "rejected" || entry.status === "failed" || entry.status === "interrupted"
            || entry.status === "completed") continue;
          if (!entry.operationId) {
            if (entry.kind === "operation" && !entry.operationInput) continue;
            try {
              const record = await getStockVibeRequest(entry.requestId);
              if (!stopped) acceptRequestRecord(entry, record);
            } catch {
              if (!stopped) patchWrite(entry.requestId, { status: "unknown" });
            }
            continue;
          }
          try {
            const detail = await getStockVibeOperation(entry.operationId);
            const native = parseOperation(detail.native);
            if (!native || native.operation_id !== entry.operationId) {
              patchWrite(entry.requestId, { status: "unknown" });
              continue;
            }
            setOperationDetails((current) => ({ ...current, [native.operation_id]: native }));
            patchWrite(entry.requestId, { status: native.status });
            if (native.status === "completed") {
              const references = native.references ?? {};
              if (native.operation === "extract_shadow_strategy" && typeof references.shadow_id === "string"
                && SHADOW_ID.test(references.shadow_id)) {
                setSelectedShadowId(references.shadow_id);
                setRevision((value) => value + 1);
              }
            }
          } catch {
            if (!stopped) patchWrite(entry.requestId, { status: "unknown" });
          }
        }
        const selectedId = selectedOperationId;
        const activeIds = list.filter((item) => item.status === "queued" || item.status === "running")
          .map((item) => item.operation_id);
        const detailIds = Array.from(new Set([...activeIds, ...(selectedId ? [selectedId] : []), ...(selectedJournalId ? [selectedJournalId] : [])]));
        for (const id of detailIds) {
          if (stopped) return;
          try {
            const detail = await getStockVibeOperation(id);
            const native = parseOperation(detail.native);
            if (native?.operation_id === id) setOperationDetails((current) => ({ ...current, [id]: native }));
          } catch {
            // Keep the last server status; a later GET will reconcile it.
          }
        }
      } catch (error) {
        if (!stopped) showAlert("operation-list", safeError(error));
      }
      if (!stopped) timer = setTimeout(poll, 5000);
    };

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [acceptRequestRecord, enabled, patchWrite, selectedOperationId, selectedJournalId, showAlert]);

  useEffect(() => {
    if (!enabled || !selectedShadowId) {
      setProfileNative(null);
      return undefined;
    }
    let stopped = false;
    setProfileNative(null);
    getStockVibeShadowProfile(selectedShadowId)
      .then((profile) => {
        if (!stopped) {
          setProfileNative(profile.native);
          setShadowReadError(null);
        }
      })
      .catch(() => {
        if (!stopped) setShadowReadError("暂时无法读取所选交易规则，请稍后重新打开实验。");
      });
    return () => { stopped = true; };
  }, [enabled, revision, selectedShadowId, showAlert]);

  const nativeById = useMemo(() => {
    const map = new Map(serverOperations.map((operation) => [operation.operation_id, operation]));
    Object.values(operationDetails).forEach((operation) => map.set(operation.operation_id, operation));
    return map;
  }, [operationDetails, serverOperations]);

  const operationRows = useMemo(() => {
    const rows = new Map<string, { key: string; operationId?: string; label: string; status: string; requestId?: string; native?: NativeOperation }>();
    for (const operation of nativeById.values()) {
      const tracked = saved.writes.find((item) => item.operationId === operation.operation_id);
      rows.set(operation.operation_id, {
        key: operation.operation_id,
        operationId: operation.operation_id,
        label: operationTitle(operation.operation),
        status: operation.status,
        requestId: tracked?.requestId,
        native: operation,
      });
    }
    for (const entry of saved.writes.filter(isAccountWrite)) {
      const key = entry.operationId ?? entry.requestId;
      if (!rows.has(key)) rows.set(key, {
        key,
        operationId: entry.operationId,
        label: entry.label,
        status: entry.status,
        requestId: entry.requestId,
      });
    }
    return Array.from(rows.values()).sort((left, right) => {
      const a = left.native?.created_at ?? saved.writes.find((item) => item.requestId === left.requestId)?.createdAt ?? "";
      const b = right.native?.created_at ?? saved.writes.find((item) => item.requestId === right.requestId)?.createdAt ?? "";
      return b.localeCompare(a);
    });
  }, [nativeById, saved.writes]);

  const selectedOperation = selectedOperationId ? nativeById.get(selectedOperationId) ?? null : null;
  const activeServerOperation = serverOperations.some((item) => item.status === "queued" || item.status === "running");
  const pendingWrite = saved.writes.some((item) => isAccountWrite(item) && !TERMINAL_TRACKED.has(item.status));
  const writeDisabled = !enabled || busy || activeServerOperation || pendingWrite;

  const createWrite = useCallback((kind: TrackedWrite["kind"], label: string, operationInput?: StockVibeOperationInput, fileName?: string): TrackedWrite | null => {
    const requestId = newRequestId();
    const entry: TrackedWrite = {
      requestId,
      kind,
      label,
      status: "dispatching",
      createdAt: new Date().toISOString(),
      ...(operationInput ? { operationInput } : {}),
      ...(fileName ? { fileName } : {}),
    };
    const savedOk = persist((current) => ({ ...current, writes: [entry, ...current.writes].slice(0, 100) }), true);
    return savedOk ? entry : null;
  }, [persist]);

  const dispatchOperation = useCallback(async (input: StockVibeOperationInput) => {
    if (writeDisabled || writeLock.current) return;
    writeLock.current = true;
    setBusy(true);
    const entry = createWrite("operation", operationLabel(input), input);
    if (!entry) {
      writeLock.current = false;
      setBusy(false);
      return;
    }
    try {
      const record = await startStockVibeOperation(entry.requestId, input);
      acceptRequestRecord(entry, record);
    } catch (error) {
      patchWrite(entry.requestId, { status: "checking_request" });
      showAlert(`write:${entry.requestId}`, safeError(error));
    } finally {
      writeLock.current = false;
      setBusy(false);
    }
  }, [acceptRequestRecord, createWrite, patchWrite, showAlert, writeDisabled]);

  const uploadSelectedFile = useCallback(async () => {
    if (writeDisabled || writeLock.current || !selectedFile) return;
    const extension = selectedFile.name.toLowerCase().match(/\.(csv|xls|xlsx)$/)?.[1];
    if (!extension || selectedFile.size < 1 || selectedFile.size > MAX_UPLOAD_BYTES) {
      showAlert("upload-validation", "请选择非空 CSV、XLS 或 XLSX 文件，且大小不超过 8MB。");
      return;
    }
    writeLock.current = true;
    setBusy(true);
    let base64: string;
    try {
      base64 = await encodeFile(selectedFile);
    } catch {
      showAlert("upload-read", "无法读取所选文件，因此没有上传。");
      writeLock.current = false;
      setBusy(false);
      return;
    }
    const entry = createWrite("upload", `上传成交文件 · ${selectedFile.name}`, undefined, selectedFile.name);
    if (!entry) {
      writeLock.current = false;
      setBusy(false);
      return;
    }
    try {
      const record = await uploadStockVibeFile(entry.requestId, selectedFile.name, base64);
      acceptRequestRecord(entry, record);
      const body = requestReceiptBody(record);
      const uploadedPath = typeof body?.file_path === "string" ? body.file_path.match(UPLOAD_PATH) : null;
      if (normalizedRequestId(record.request_id) === normalizedRequestId(entry.requestId) && uploadedPath) {
        const input: StockVibeOperationInput = { operation: "analyze_trade_journal", upload_id: uploadedPath[1].toLowerCase() };
        const analysis = createWrite("operation", "读取成交文件", input);
        if (analysis) {
          try {
            acceptRequestRecord(analysis, await startStockVibeOperation(analysis.requestId, input));
          } catch (error) {
            patchWrite(analysis.requestId, { status: "checking_request" });
            showAlert(`write:${analysis.requestId}`, safeError(error));
          }
        }
      }
    } catch (error) {
      patchWrite(entry.requestId, { status: "checking_request" });
      showAlert(`upload:${entry.requestId}`, safeError(error));
    } finally {
      writeLock.current = false;
      setBusy(false);
    }
  }, [acceptRequestRecord, createWrite, patchWrite, selectedFile, showAlert, writeDisabled]);

  const exportArtifact = useCallback(async (artifact: ReportArtifact) => {
    if (!objectId(artifact.id)) {
      showAlert("artifact-id", "原生产物标识无效，无法下载。");
      return;
    }
    try {
      const blob = await downloadStockVibeArtifact(artifact.kind, artifact.id);
      downloadBlob(blob, artifact.filename);
    } catch (error) {
      showAlert(`artifact-download:${artifact.kind}:${artifact.id}`, safeError(error));
    }
  }, [showAlert]);

  const profileRecord = isRecord(profileNative) ? profileNative : null;
  const profileRules = Array.isArray(profileRecord?.rules) ? profileRecord.rules : [];
  const portfolioRecord = isRecord(portfolioNative) ? portfolioNative : null;
  const portfolioSnapshot = portfolioRecord?.snapshot;
  const portfolioIsEmpty = portfolioRecord?.status === "empty" || portfolioSnapshot === null;
  const availableUploads = useMemo(() => {
    const byId = new Map<string, AvailableUpload>();
    for (const upload of remoteUploads) {
      byId.set(upload.upload_id, {
        uploadId: upload.upload_id,
        filename: upload.filename,
        requestId: upload.request_id,
        uploadedAt: upload.uploaded_at,
        sizeBytes: upload.size_bytes,
        source: upload.source,
      });
    }
    return [...byId.values()];
  }, [remoteUploads]);
  const selectedUpload = availableUploads.find((upload) => upload.uploadId === selectedUploadId) ?? null;
  const unknownWriteCount = saved.writes.filter((item) => isAccountWrite(item) && (item.status === "unknown" || item.status === "checking_request")).length;
  const trackedActive = saved.writes.some((item) => item.kind === "operation" && isAccountWrite(item) && !TERMINAL_TRACKED.has(item.status));
  const latestUploadPending = saved.writes.some((item) => item.kind === "upload" && !TERMINAL_TRACKED.has(item.status));

  const accountDateError = useMemo(() => {
    if (windowStart && !isoDate(windowStart)) return "开始日期无效。";
    if (windowEnd && !isoDate(windowEnd)) return "结束日期无效。";
    if (windowStart && windowEnd && windowStart > windowEnd) return "开始日期不能晚于结束日期。";
    if (scanDate && !isoDate(scanDate)) return "扫描日期无效。";
    return null;
  }, [scanDate, windowEnd, windowStart]);

  const perMarketCount = Number(perMarketCountDraft);
  const perMarketCountValid = /^\d+$/.test(perMarketCountDraft)
    && Number.isInteger(perMarketCount) && perMarketCount >= 1 && perMarketCount <= 5;
  const perMarketCountError = perMarketCountValid ? null : "实验样本数必须为 1 到 5 的整数。";

  const runShadowAction = (operation: "run_shadow_backtest" | "render_shadow_report" | "scan_shadow_signals") => {
    const shadowId = operation === "render_shadow_report" ? stringValue(selectedOperation?.references?.shadow_id) : selectedShadowId;
    if (!shadowId || !SHADOW_ID.test(shadowId)) return;
    if (operation !== "render_shadow_report" && accountDateError) return;
    if (operation === "run_shadow_backtest" && !perMarketCountValid) return;
    const uploadId = profileUploadId;
    if (operation === "run_shadow_backtest") {
      void dispatchOperation({
        operation,
        shadow_id: shadowId,
        source,
        ...(windowStart ? { window_start: windowStart } : {}),
        ...(windowEnd ? { window_end: windowEnd } : {}),
        ...(uploadId ? { upload_id: uploadId } : {}),
        markets: ["china_a"],
        per_market_count: perMarketCount,
      });
    } else if (operation === "render_shadow_report") {
      const backtest = selectedOperation?.operation === "run_shadow_backtest" && selectedOperation.status === "completed"
        ? selectedOperation : null;
      const payload = backtest?.payload;
      const result = isRecord(backtest?.tool_result) ? backtest.tool_result : {};
      const window = Array.isArray(result.window) ? result.window : [];
      const start = stringValue(payload?.window_start) ?? stringValue(window[0]);
      const end = stringValue(payload?.window_end) ?? stringValue(window[1]);
      if (!backtest || !payload || !start || !end
        || !["auto", "local", "tencent", "eastmoney"].includes(String(payload.source))
        || !Array.isArray(payload.markets) || payload.markets.length !== 1 || payload.markets[0] !== "china_a"
        || typeof payload.per_market_count !== "number") {
        setAlertMessage("请先选择一份已完成、且保存了完整实验设置的历史模拟，再为它生成报告。");
        return;
      }
      void dispatchOperation({
        operation,
        shadow_id: shadowId,
        include_today_signals: false,
        source: payload.source as typeof source,
        markets: ["china_a"],
        per_market_count: payload.per_market_count,
        window_start: start,
        window_end: end,
        ...(typeof payload.upload_id === "string" ? { upload_id: payload.upload_id } : {}),
      });
    } else {
      void dispatchOperation({
        operation,
        shadow_id: shadowId,
        source,
        ...(scanDate ? { date: scanDate } : {}),
      });
    }
  };

  const uploadForOperation = (operation: NativeOperation) => {
    const uploadId = operation.references?.upload_id ?? operation.payload?.upload_id;
    return availableUploads.find((upload) => upload.uploadId === uploadId);
  };
  const journalOperations = Array.from(nativeById.values())
    .filter((operation) => operation.operation === "analyze_trade_journal")
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const selectedJournal = selectedJournalId ? nativeById.get(selectedJournalId) : null;
  const journalUpload = selectedJournal ? uploadForOperation(selectedJournal) : null;
  const profileOperation = Array.from(nativeById.values())
    .filter((operation) => operation.operation === "extract_shadow_strategy" && operation.status === "completed"
      && operation.references?.shadow_id === selectedShadowId)
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0];
  const profileUploadId = typeof profileOperation?.references?.upload_id === "string"
    ? profileOperation.references.upload_id : undefined;
  const profileUpload = availableUploads.find((upload) => upload.uploadId === profileUploadId);
  const shadowRows = operationRows.filter((row) => row.native?.operation !== "analyze_trade_journal"
    && row.native);
  const selectedShadowOperation = selectedOperation && selectedOperation.operation !== "analyze_trade_journal"
    ? selectedOperation : null;
  const frozenInput = selectedShadowOperation?.payload ?? {};
  const frozenResult = isRecord(selectedShadowOperation?.tool_result) ? selectedShadowOperation.tool_result : {};
  const frozenWindow = Array.isArray(frozenResult.window) ? frozenResult.window : [];
  const portfolioData = isRecord(portfolioSnapshot) ? portfolioSnapshot : null;
  const portfolioTotals = isRecord(portfolioData?.totals) ? portfolioData.totals : {};
  const portfolioValuation = isRecord(portfolioData?.valuation) ? portfolioData.valuation : {};
  const portfolioPositions = Array.isArray(portfolioData?.positions) ? portfolioData.positions.filter(isRecord) : [];
  const portfolioAccounts = Array.isArray(portfolioData?.accounts) ? portfolioData.accounts.filter(isRecord) : [];
  const reportExports: ReportArtifact[] = [];
  if (selectedShadowOperation?.operation === "render_shadow_report" && selectedShadowOperation.status === "completed") {
    const reportId = frozenResult.report_id;
    if (typeof reportId === "string" && objectId(reportId)) reportExports.push({
      kind: "report-pdf", id: reportId, filename: "交易方法实验报告.pdf", label: "下载实验报告",
    });
  }

  return <section className="stock-vibe-operations flex h-full min-h-0 min-w-0 flex-col gap-3">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
      <Tabs value={accountView} onValueChange={setAccountView}>
        <TabsList aria-label="账户与复盘视图" className="h-8 gap-4 rounded-none bg-transparent p-0 text-muted-foreground">
          <TabsTrigger value="journal" className="h-full rounded-none px-0 py-1 text-muted-foreground shadow-none data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none">成交复盘</TabsTrigger>
          <TabsTrigger value="holdings" className="h-full rounded-none px-0 py-1 text-muted-foreground shadow-none data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none">持仓</TabsTrigger>
        </TabsList>
      </Tabs>
      <Button size="sm" variant="ghost" disabled={!enabled} onClick={() => setAdvancedOpen(true)}>交易方法实验</Button>
    </div>

    {!enabled ? <EmptyState title="股票功能暂不可用" description="请查看功能资源与模型设置。" /> : <>
      {unknownWriteCount > 0 && <p role="status" className="text-caption text-muted-foreground">有 {unknownWriteCount} 个操作的结果尚未确认，正在核对；不会自动重复提交。</p>}
      {trackedActive && unknownWriteCount === 0 && <p role="status" className="text-caption text-muted-foreground">正在处理已提交的任务，可以离开页面，稍后从历史记录查看。</p>}
      {accountView === "journal" ? <div className="stock-vibe-account-layout">
        <aside className="stock-vibe-account-sidebar">
          <section className="space-y-3">
            <SectionHeader title="导入成交" />
            <label className="block space-y-2 text-caption" htmlFor="sv-trades-file"><span>选择成交文件</span>
              <Input id="sv-trades-file" type="file" accept=".csv,.xls,.xlsx" disabled={writeDisabled || latestUploadPending} onChange={(event: ChangeEvent<HTMLInputElement>) => setSelectedFile(event.target.files?.[0] ?? null)} />
            </label>
            <p className="text-micro text-muted-foreground">CSV、XLS、XLSX · 每份不超过 8MB</p>
            <Button size="sm" variant="secondary" disabled={writeDisabled || !selectedFile || latestUploadPending} onClick={() => void uploadSelectedFile()}>{busy ? "正在读取…" : "导入并核对"}</Button>
            {availableUploads.length > 0 && <div className="space-y-2">
              <Select value={selectedUploadId ?? undefined} onValueChange={(id) => { setSelectedUploadId(id); setSelectedJournalId(null); }}
                options={availableUploads.map((upload) => ({ value: upload.uploadId, label: upload.filename }))}
                placeholder="选择已上传文件" disabled={writeDisabled} aria-label="选择已上传成交文件" />
              <Button size="sm" variant="secondary" disabled={writeDisabled || !selectedUpload} onClick={() => selectedUpload && void dispatchOperation({ operation: "analyze_trade_journal", upload_id: selectedUpload.uploadId })}>读取并核对</Button>
            </div>}
          </section>
          <section className="space-y-3">
            <SectionHeader title="历史复盘" />
            {journalOperations.length > 0 ? <ul className="space-y-2">
              {journalOperations.map((operation) => <li key={operation.operation_id}>
                <Button variant="ghost" aria-pressed={selectedJournalId === operation.operation_id} className={`h-auto w-full justify-between gap-3 whitespace-normal px-2 py-3 text-left ${selectedJournalId === operation.operation_id ? "bg-card" : ""}`}
                  onClick={() => { setSelectedJournalId(operation.operation_id); setSelectedOperationId(operation.operation_id); setReviewOperationId(null); }}>
                  <span className="min-w-0"><span className="block break-words">{uploadForOperation(operation)?.filename ?? "成交复盘"}</span><span className="block text-micro font-normal text-muted-foreground">{displayDate(operation.created_at)}</span></span>
                  <span className="shrink-0 text-micro font-normal">{statusLabel(operation.status)}</span>
                </Button>
              </li>)}
            </ul> : <p className="text-caption text-muted-foreground">读取成交文件后，复盘会自动保存在这里。</p>}
          </section>
        </aside>
        <main className="stock-vibe-account-workspace">
          {selectedJournal ? <>
            <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-title-sm font-semibold">{journalUpload?.filename ?? "成交复盘"}</h3><span className="text-caption text-muted-foreground">{displayDate(selectedJournal.created_at)} · {statusLabel(selectedJournal.status)}</span></div>
            {selectedJournal.status === "completed" && selectedJournal.tool_result !== undefined
              ? <StockVibeJournalResult result={selectedJournal.tool_result} mode={reviewOperationId === selectedJournal.operation_id ? "review" : "result"}
                  onConfirm={() => setReviewOperationId(null)}
                  onExplain={onReviewQuestion ? () => onReviewQuestion({ operationId: selectedJournal.operation_id, ...(journalUpload ? { filename: journalUpload.filename } : {}), question: "请基于这份成交记录，解释本次交易表现和有依据的行为观察，指出信息不足。" }) : undefined} />
              : selectedJournal.status === "failed" || selectedJournal.status === "interrupted"
                ? <div className="space-y-3"><p className="text-caption">{operationFailureMessage(selectedJournal)}</p>{journalUpload && <Button variant="secondary" disabled={writeDisabled} onClick={() => void dispatchOperation({ operation: "analyze_trade_journal", upload_id: journalUpload.uploadId })}>重新读取此文件</Button>}</div>
                : <p role="status" className="text-caption text-muted-foreground">{selectedJournal.status === "completed" ? "正在读取这次复盘的完整结果…" : "正在读取并分析此文件，完成后可核对识别范围。"}</p>}
          </> : <EmptyState title={selectedUpload ? `准备复盘 ${selectedUpload.filename}` : "看看自己的交易表现"} description={selectedUpload ? "点击“读取并核对”，先确认识别到的成交范围。" : "导入券商成交文件，核对记录后查看盈亏与交易习惯。"} className="flex-1" />}
        </main>
      </div> : <section className="stock-vibe-account-workspace">
        <SectionHeader title="持仓快照" />
        {portfolioReadError ? <p role="status" className="text-caption text-muted-foreground">{portfolioReadError}</p> : portfolioIsEmpty ? <EmptyState title="还没有持仓数据" description="当前暂未接通普通东方财富交易账号。你可以先导入成交文件进行复盘。" action={<Button variant="secondary" onClick={() => setAccountView("journal")}>去导入成交</Button>} /> : portfolioRecord?.status === "ok" && portfolioData ? <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-muted-foreground"><span>更新于 {displayDate(portfolioData.created_at)}</span><span>{portfolioData.complete === true ? "已连接来源读取完整" : "部分来源或估值不完整"}</span></div>
          <dl className="grid gap-5 sm:grid-cols-3"><div><dt className="text-caption text-muted-foreground">资产合计（{stringValue(portfolioData.display_currency) ?? "币种未提供"}）</dt><dd className="mt-1 text-title-sm tabular-nums">{displayNumber(portfolioTotals.display)}</dd></div><div><dt className="text-caption text-muted-foreground">已识别现金（USD）</dt><dd className="mt-1 text-title-sm tabular-nums">{displayNumber(portfolioValuation.cash_usd)}</dd></div><div><dt className="text-caption text-muted-foreground">已识别估值覆盖</dt><dd className="mt-1 text-title-sm tabular-nums">{typeof portfolioValuation.identified_coverage === "number" ? `${(portfolioValuation.identified_coverage * 100).toFixed(1)}%` : "未提供"}</dd></div></dl>
          {portfolioAccounts.length > 0 && <p className="text-caption text-muted-foreground">来源：{portfolioAccounts.map((account) => `${stringValue(account.label) ?? stringValue(account.broker) ?? "未命名来源"}${account.status === "ok" ? "" : "（读取不完整）"}`).join("、")}</p>}
          {portfolioPositions.length > 0 ? <div className="overflow-x-auto"><table className="w-full text-left text-caption"><thead><tr className="border-b border-border text-muted-foreground"><th className="py-3 font-normal">证券</th><th className="px-3 font-normal">数量</th><th className="px-3 font-normal">成本 / 现价</th><th className="px-3 font-normal">市值（USD）</th><th className="px-3 font-normal">浮动盈亏（USD）</th><th className="py-3 font-normal">来源</th></tr></thead><tbody>{portfolioPositions.map((position, index) => <tr key={index} className="border-b border-border/60"><td className="py-3">{stringValue(position.symbol) ?? "未提供"}</td><td className="px-3 tabular-nums">{displayNumber(position.quantity)}</td><td className="px-3 tabular-nums">{displayNumber(position.cost_price)} / {displayNumber(position.market_price)} {stringValue(position.price_currency) ?? stringValue(position.currency)}</td><td className="px-3 tabular-nums">{position.priced === false ? "未估值" : displayNumber(position.market_value_usd)}</td><td className={`px-3 tabular-nums ${typeof position.unrealized_pnl_usd === "number" ? position.unrealized_pnl_usd > 0 ? "text-stock-up" : position.unrealized_pnl_usd < 0 ? "text-stock-down" : "" : ""}`}>{position.priced === false ? "未估值" : displayNumber(position.unrealized_pnl_usd)}</td><td className="py-3">{stringValue(position.source_label) ?? stringValue(position.broker) ?? "未提供"}</td></tr>)}</tbody></table></div> : <p className="text-caption text-muted-foreground">这份快照没有可展示的持仓明细。</p>}
          <StockVibeInfo title="快照来源与覆盖" label="查看来源与覆盖"><pre className="whitespace-pre-wrap break-all text-micro">{jsonForDisplay({ accounts: portfolioData.accounts, warnings: portfolioData.warnings, fx: portfolioData.fx, refresh: portfolioStatusNative })}</pre></StockVibeInfo>
          <StockVibeInfo title="查看原生快照字段"><pre className="whitespace-pre-wrap break-all text-micro">{jsonForDisplay(portfolioData)}</pre></StockVibeInfo>
        </> : <p className="text-caption text-muted-foreground">暂未能读取持仓状态，请稍后重新打开此页面。</p>}
      </section>}
    </>}

    <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}>
      <DialogContent className="scrollbar-scope max-h-[85vh] max-w-5xl overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>交易方法实验</DialogTitle></DialogHeader>
        <div className="space-y-6">
          {shadowReadError && <p role="status" className="text-caption text-muted-foreground">{shadowReadError}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-caption text-muted-foreground">提取盈利交易的共同规则，再检验这些规则的历史表现。</p><StockVibeInfo title="实验范围与限制" label="实验范围"><p>提取规则至少需要 5 组已配对且盈利的交易。它只归纳盈利样本，不代表全部交易习惯。</p><p>A 股固定样本依次为：贵州茅台 600519、五粮液 000858、宁德时代 300750、招商银行 600036、平安银行 000001。实验样本数最多 5，只决定使用这个篮子的前几只。</p><p>条件扫描使用规则对应的固定篮子，默认每市场最多返回 3 条匹配，与实验样本数独立，不代表全市场选股。</p><p>A 股模拟使用 100 万元初始资金。这些模拟没有还原你的本金、资金流和完整持仓，不能与真实账户收益直接比较。</p></StockVibeInfo></div>
          <section className="space-y-3">
            <SectionHeader title="1. 从成交中提取规则" />
            <div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1 space-y-1"><span className="text-caption">提取规则使用的成交文件</span><Select value={selectedUploadId ?? undefined} onValueChange={setSelectedUploadId} options={availableUploads.map((upload) => ({ value: upload.uploadId, label: upload.filename }))} placeholder="选择成交文件" disabled={writeDisabled} aria-label="实验成交文件" /></div><Button variant="secondary" disabled={writeDisabled || !selectedUpload} onClick={() => selectedUpload && void dispatchOperation({ operation: "extract_shadow_strategy", upload_id: selectedUpload.uploadId })}>提取交易规则</Button></div>
            <Select value={selectedShadowId ?? undefined} onValueChange={(value) => { setSelectedShadowId(value); setSelectedOperationId(null); }} options={profiles.map((profile) => ({ value: profile.shadow_id, label: `交易规则 · ${displayDate(profile.created_at)}` }))} placeholder="选择已保存交易规则" disabled={writeDisabled} aria-label="选择已保存交易规则" />
            {profileRecord && <div className="space-y-2 text-caption"><p className="text-muted-foreground">{profileUpload ? `规则来自 ${profileUpload.filename}` : "未保存可核对的文件关联；实验不附加其他成交文件。"} · 盈利往返 {displayNumber(profileRecord.profitable_roundtrips)} / 全部往返 {displayNumber(profileRecord.total_roundtrips)}</p>{profileRules.length > 0 && <ul className="space-y-2">{profileRules.map((rule, index) => { const item = isRecord(rule) ? rule : {}; return <li key={index}>{stringValue(item.human_text) ?? "未返回规则文本"}</li>; })}</ul>}</div>}
          </section>
          <section className="space-y-3 border-t border-border pt-5"><SectionHeader title="2. 设置并运行实验" />
            <div className="grid gap-3 md:grid-cols-2"><label className="space-y-1 text-caption" htmlFor="sv-window-start">实验开始日期（可选）<Input id="sv-window-start" type="date" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} disabled={writeDisabled} /></label><label className="space-y-1 text-caption" htmlFor="sv-window-end">实验结束日期（可选）<Input id="sv-window-end" type="date" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} disabled={writeDisabled} /></label><div className="space-y-1 text-caption"><span>行情来源</span><Select value={source} onValueChange={(value) => setSource(value as typeof source)} options={SOURCE_OPTIONS} disabled={writeDisabled} aria-label="实验行情来源" /></div><label className="space-y-1 text-caption" htmlFor="sv-per-market-count">实验样本数（1–5）<Input id="sv-per-market-count" type="number" min={1} max={5} step={1} value={perMarketCountDraft} onChange={(event) => setPerMarketCountDraft(event.target.value)} disabled={writeDisabled} /></label></div>
            {accountDateError && <p role="alert" className="text-caption text-destructive">{accountDateError}</p>}{perMarketCountError && <p role="alert" className="text-caption text-destructive">{perMarketCountError}</p>}
            <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={writeDisabled || !selectedShadowId || !!accountDateError || !perMarketCountValid} onClick={() => runShadowAction("run_shadow_backtest")}>运行历史模拟</Button><Button variant="secondary" disabled={writeDisabled || selectedShadowOperation?.operation !== "run_shadow_backtest" || selectedShadowOperation.status !== "completed"} onClick={() => runShadowAction("render_shadow_report")}>为选中模拟生成报告</Button></div>
            <div className="flex flex-wrap items-end gap-3"><label className="space-y-1 text-caption" htmlFor="sv-scan-date">扫描日期（可选）<Input id="sv-scan-date" type="date" value={scanDate} onChange={(event) => setScanDate(event.target.value)} disabled={writeDisabled} /></label><Button variant="secondary" disabled={writeDisabled || !selectedShadowId || !!accountDateError} onClick={() => runShadowAction("scan_shadow_signals")}>扫描条件信号</Button></div>
          </section>
          <section className="space-y-3 border-t border-border pt-5"><SectionHeader title="实验记录" />{shadowRows.length > 0 ? <ul className="divide-y divide-border">{shadowRows.map((row) => <li key={row.key}><Button variant="ghost" className="h-auto w-full justify-between gap-3 whitespace-normal px-1 py-3" onClick={() => { if (row.operationId) setSelectedOperationId(row.operationId); const shadowId = row.native?.references?.shadow_id; if (typeof shadowId === "string" && SHADOW_ID.test(shadowId)) setSelectedShadowId(shadowId); }}><span>{row.label} · {displayDate(row.native?.created_at)}</span><span>{statusLabel(row.status)}</span></Button></li>)}</ul> : <p className="text-caption text-muted-foreground">主动运行后，实验与扫描结果会保存在这里。</p>}
            {selectedShadowOperation && <section className="space-y-3 border-t border-border pt-4" aria-label="选中的实验结果"><h3 className="text-body font-medium">已保存结果 · {operationTitle(selectedShadowOperation.operation)}</h3><p className="text-caption text-muted-foreground">{displayDate(selectedShadowOperation.created_at)} · {statusLabel(selectedShadowOperation.status)}</p><dl className="grid gap-2 text-caption sm:grid-cols-2"><div><dt className="inline text-muted-foreground">本次区间：</dt><dd className="inline">{stringValue(frozenInput.window_start) ?? stringValue(frozenInput.date) ?? stringValue(frozenWindow[0]) ?? "未保存"} 至 {stringValue(frozenInput.window_end) ?? stringValue(frozenInput.date) ?? stringValue(frozenWindow[1]) ?? "未保存"}</dd></div><div><dt className="inline text-muted-foreground">行情来源：</dt><dd className="inline">{SOURCE_OPTIONS.find((option) => option.value === (frozenInput.source ?? frozenResult.source))?.label ?? "未保存"}</dd></div><div><dt className="inline text-muted-foreground">实验样本数：</dt><dd className="inline">{displayNumber(frozenInput.per_market_count)}</dd></div><div><dt className="inline text-muted-foreground">关联文件：</dt><dd className="inline">{uploadForOperation(selectedShadowOperation)?.filename ?? "未保存可核对关联"}</dd></div></dl><p className="text-micro text-muted-foreground">此结果属于上面的已保存任务；修改实验设置不会改变它。</p>
              {selectedShadowOperation.status === "completed" && selectedShadowOperation.tool_result !== undefined ? <><StockVibeShadowResult operation={selectedShadowOperation.operation} result={selectedShadowOperation.tool_result} />{reportExports.map((artifact) => <Button key={artifact.id} variant="secondary" onClick={() => void exportArtifact(artifact)}>{artifact.label}</Button>)}<StockVibeInfo title="实验详细依据"><pre className="whitespace-pre-wrap break-all text-micro">{jsonForDisplay(selectedShadowOperation)}</pre></StockVibeInfo></> : selectedShadowOperation.status === "failed" || selectedShadowOperation.status === "interrupted" ? <p className="text-caption">{operationFailureMessage(selectedShadowOperation)}</p> : <p role="status" className="text-caption text-muted-foreground">正在读取这次任务的结果…</p>}
            </section>}
          </section>
        </div>
      </DialogContent>
    </Dialog>
    <AlertDialog open={alertMessage !== null} onOpenChange={(open) => { if (!open) setAlertMessage(null); }}><AlertDialogContent className="scrollbar-scope"><AlertDialogHeader><AlertDialogTitle>股票操作提示</AlertDialogTitle><AlertDialogDescription>{alertMessage}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel onClick={() => setAlertMessage(null)}>关闭</AlertDialogCancel></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
