import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { StockVibeInfo } from "./StockVibeInfo";
import { Textarea } from "@/components/ui/textarea";
import { inferStockVibeExchange } from "@/lib/stock-vibe-symbol";
import { StockVibeReport } from "./StockVibeReport";
import {
  cancelStockVibeSwarm,
  createStockVibeSwarm,
  downloadStockVibeSwarmArtifact,
  getStockVibeRequest,
  getStockVibeSwarmRun,
  listStockVibeSwarmArtifacts,
  listStockVibeSwarmPresets,
  listStockVibeSwarmRuns,
  resumeStockVibeSwarm,
  StockVibeApiError,
  type StockVibeStartSwarmInput,
} from "@/lib/stock-vibe-api";

type Mode = "ultrashort" | "swing" | "medium";
type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
type WriteKind = "create" | "cancel" | "resume";
type WritePhase = "dispatching" | "checking" | "unknown" | "accepted" | "rejected" | "finished";

interface TrackedWrite {
  requestId: string;
  kind: WriteKind;
  phase: WritePhase;
  createdAt: string;
  label: string;
  runId?: string;
  relatedRunId?: string;
}

interface RunSummary {
  id: string;
  preset_name?: string;
  status: string;
  created_at?: string;
  completed_at?: string | null;
  task_count?: number;
  completed_count?: number;
  is_stale?: boolean;
}

interface SwarmArtifact {
  artifact_id: string;
  task_id: string;
  filename: string;
  bytes?: number;
  sha256?: string | null;
}

interface SavedState {
  writes: TrackedWrite[];
}

const STORAGE_KEY = "mona.stock-vibe.team.v1";
const REQUEST_ID = /^[a-f0-9]{32}$/i;
const OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL_RUNS = new Set<RunStatus>(["completed", "failed", "cancelled"]);
const MODES: Record<Mode, string> = {
  ultrashort: "观察期限：超短线，当日及随后数个交易日。",
  swing: "观察期限：波段，3、5、10个交易日。",
  medium: "观察期限：中短线，10、20、40个交易日。",
};
const MODE_LABELS: Record<Mode, string> = {
  ultrashort: "超短线",
  swing: "波段",
  medium: "中短线",
};

function emptySaved(): SavedState {
  return { writes: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID.test(value);
}

function normalizeRequestId(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function readSaved(): SavedState {
  if (typeof window === "undefined") return emptySaved();
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!isRecord(value) || !Array.isArray(value.writes)) return emptySaved();
    const writes = value.writes.flatMap((item): TrackedWrite[] => {
      if (!isRecord(item) || typeof item.requestId !== "string" || !REQUEST_ID.test(item.requestId)
        || !["create", "cancel", "resume"].includes(String(item.kind))
        || !["dispatching", "checking", "unknown", "accepted", "rejected", "finished"].includes(String(item.phase))
        || typeof item.createdAt !== "string" || typeof item.label !== "string") return [];
      return [{
        requestId: item.requestId.toLowerCase(),
        kind: item.kind as WriteKind,
        phase: item.phase === "dispatching" ? "checking" : item.phase as WritePhase,
        createdAt: item.createdAt,
        label: item.label,
        ...(safeId(item.runId) ? { runId: item.runId } : {}),
        ...(safeId(item.relatedRunId) ? { relatedRunId: item.relatedRunId } : {}),
      }];
    });
    return { writes };
  } catch {
    return emptySaved();
  }
}

function parseRuns(value: unknown): RunSummary[] {
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.runs) ? value.runs : [];
  return rows.flatMap((item): RunSummary[] => {
    if (!isRecord(item) || !safeId(item.id) || typeof item.status !== "string") return [];
    return [{
      id: item.id,
      status: item.status,
      ...(typeof item.preset_name === "string" ? { preset_name: item.preset_name } : {}),
      ...(typeof item.created_at === "string" ? { created_at: item.created_at } : {}),
      ...(typeof item.completed_at === "string" || item.completed_at === null ? { completed_at: item.completed_at } : {}),
      ...(typeof item.task_count === "number" ? { task_count: item.task_count } : {}),
      ...(typeof item.completed_count === "number" ? { completed_count: item.completed_count } : {}),
      ...(typeof item.is_stale === "boolean" ? { is_stale: item.is_stale } : {}),
    }];
  });
}

function parseArtifacts(value: unknown): SwarmArtifact[] {
  const rows = isRecord(value) && Array.isArray(value.artifacts) ? value.artifacts : [];
  return rows.flatMap((item): SwarmArtifact[] => {
    if (!isRecord(item) || typeof item.artifact_id !== "string" || !/^[a-f0-9]{64}$/.test(item.artifact_id)
      || !safeId(item.task_id) || typeof item.filename !== "string"
      || item.filename.includes("/") || item.filename.includes("\\")) return [];
    return [{
      artifact_id: item.artifact_id,
      task_id: item.task_id,
      filename: item.filename,
      ...(typeof item.bytes === "number" ? { bytes: item.bytes } : {}),
      ...(typeof item.sha256 === "string" || item.sha256 === null ? { sha256: item.sha256 } : {}),
    }];
  });
}

function parsePresetExists(value: unknown): boolean {
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.presets) ? value.presets : [];
  return rows.some((item) => isRecord(item) && item.name === "mona_ashare_research");
}

function requestBody(record: Awaited<ReturnType<typeof getStockVibeRequest>>): Record<string, unknown> | null {
  if (record.status !== "completed" || !record.receipt || !/^[a-f0-9]{64}$/i.test(record.receipt_sha256 ?? "")) return null;
  const code = record.receipt.status_code;
  if (!Number.isInteger(code) || code < 200 || code >= 300 || !isRecord(record.receipt.body)) return null;
  return record.receipt.body;
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    pending: "等待中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    dispatching: "正在提交",
    checking: "正在确认提交结果",
    unknown: "提交结果待确认",
    accepted: "已提交",
    rejected: "未提交成功",
    finished: "已完成",
  };
  return labels[value] ?? "状态待确认";
}

function bareStockCode(symbol: string | null): string {
  return /^([0-9]{6})\.(?:SH|SZ|BJ)$/.exec(symbol ?? "")?.[1] ?? "";
}

function displaySource(value: unknown): string {
  if (typeof value !== "string") return "来源待确认";
  const labels: Record<string, string> = {
    tencent: "腾讯行情",
    eastmoney: "东方财富行情",
    akshare: "公开行情数据",
  };
  return labels[value.toLowerCase()] ?? "其他行情来源";
}

function taskStatusLabel(value: unknown): string {
  const labels: Record<string, string> = {
    pending: "等待中",
    blocked: "等待前序步骤",
    in_progress: "进行中",
    completed: "已完成",
    failed: "未完成",
    cancelled: "已取消",
  };
  return typeof value === "string" ? labels[value] ?? "状态待确认" : "状态待确认";
}

function taskStageLabel(index: number): string {
  return ["行情研究", "证据复核"][index] ?? `补充研究阶段 ${index + 1}`;
}

function runLabel(run: RunSummary, details: Record<string, unknown>): string {
  const detail = details[run.id];
  const vars = isRecord(detail) && isRecord(detail.user_vars) ? detail.user_vars : null;
  const symbol = typeof vars?.symbol === "string" ? bareStockCode(vars.symbol) : "";
  const start = typeof vars?.start_date === "string" ? vars.start_date : "";
  const end = typeof vars?.end_date === "string" ? vars.end_date : "";
  const period = start && end ? `${start} 至 ${end}` : run.created_at?.slice(0, 10) ?? "";
  const name = [symbol, period].filter(Boolean).join(" · ") || "行情证据复核";
  return `${name} · ${statusLabel(run.status)}`;
}

function writeKindLabel(kind: WriteKind): string {
  return {
    create: "开始行情证据复核",
    cancel: "停止行情证据复核",
    resume: "重新发起行情证据复核",
  }[kind];
}

function safeError(error: unknown): string {
  return error instanceof StockVibeApiError ? error.message : "行情复核暂时无法读取，请检查服务状态后再试。";
}

export function hiddenPathText(value: string): string {
  return value.replace(/(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`]+/g, "（本机路径已隐藏）")
    .replace(/(^|[\s"'`=(])\/(?:[A-Za-z._-][A-Za-z0-9._-]*\/)+[^\s"'`)]*/gm, "$1（本机路径已隐藏）");
}

function safeJson(value: unknown): string {
  return JSON.stringify(sanitize(value), null, 2);
}

function sanitize(value: unknown, key = ""): unknown {
  if (/(?:path|dir|url)$/i.test(key) || /(?:^|_)(?:path|dir)(?:_|$)/i.test(key)) return "（本机路径已隐藏）";
  if (typeof value === "string") return hiddenPathText(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  return value;
}

function pickNativeFields(source: Record<string, unknown> | null, names: string[]): Record<string, unknown> {
  if (!source) return {};
  return Object.fromEntries(names.filter((name) => name in source).map((name) => [name, source[name]]));
}

export function StockVibeTeam({ symbol, mode, enabled }: {
  symbol: string | null;
  mode: Mode;
  enabled: boolean;
}) {
  const [saved, setSaved] = useState<SavedState>(readSaved);
  const savedRef = useRef(saved);
  const [presets, setPresets] = useState<unknown>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runDetails, setRunDetails] = useState<Record<string, unknown>>({});
  const [artifacts, setArtifacts] = useState<SwarmArtifact[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [symbolDraft, setSymbolDraft] = useState(() => bareStockCode(symbol));
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
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

  const updateWrite = useCallback((requestId: string, patch: Partial<TrackedWrite>) => {
    persist((current) => ({ ...current, writes: current.writes.map((item) => item.requestId === requestId ? { ...item, ...patch } : item) }));
  }, [persist]);

  const acceptReceipt = useCallback((tracked: TrackedWrite, record: Awaited<ReturnType<typeof getStockVibeRequest>>) => {
    if (normalizeRequestId(record.request_id) !== normalizeRequestId(tracked.requestId)) {
      updateWrite(tracked.requestId, { phase: "unknown" });
      showAlert(`request-id:${tracked.requestId}`, "提交结果暂时无法确认。系统会继续查询，不会自动重复提交。");
      return;
    }
    if (record.status === "unknown" || record.status === "pending") {
      updateWrite(tracked.requestId, { phase: "unknown" });
      return;
    }
    if (record.status === "rejected") {
      if (record.error_category === "not_dispatched" && record.receipt === null && record.source === null) {
        updateWrite(tracked.requestId, { phase: "rejected" });
        return;
      }
      const code = record.receipt?.status_code;
      const valid = !!record.receipt && typeof code === "number" && Number.isInteger(code)
        && code >= 400 && code < 500 && /^[a-f0-9]{64}$/i.test(record.receipt_sha256 ?? "");
      if (valid) updateWrite(tracked.requestId, { phase: "rejected" });
      else {
        updateWrite(tracked.requestId, { phase: "unknown" });
        showAlert(`rejected:${tracked.requestId}`, "拒绝状态缺少可核对回执，结果仍未知。");
      }
      return;
    }
    const body = requestBody(record);
    if (!body) {
      updateWrite(tracked.requestId, { phase: "unknown" });
      showAlert(`receipt:${tracked.requestId}`, "提交回执不完整，结果仍未知。系统不会自动重发。");
      return;
    }
    if (tracked.kind === "cancel") {
      if (body.status !== "cancelled") {
        updateWrite(tracked.requestId, { phase: "unknown" });
        showAlert(`cancel:${tracked.requestId}`, "停止结果暂时无法确认；系统会继续查询当前复核状态。");
        return;
      }
      updateWrite(tracked.requestId, { phase: "accepted" });
      if (tracked.runId) setSelectedRunId(tracked.runId);
      return;
    }
    const newRunId = body.id;
    if (!safeId(newRunId) || tracked.kind === "resume" && newRunId === tracked.relatedRunId) {
      updateWrite(tracked.requestId, { phase: "unknown" });
      showAlert(`run-id:${tracked.requestId}`, "系统暂未返回新的研究记录，提交结果仍待确认。");
      return;
    }
    updateWrite(tracked.requestId, { phase: "accepted", runId: newRunId });
    setSelectedRunId(newRunId);
    setRevision((value) => value + 1);
  }, [showAlert, updateWrite]);

  useEffect(() => {
    if (symbol && /^[0-9]{6}\.(SH|SZ|BJ)$/.test(symbol)) setSymbolDraft(bareStockCode(symbol));
  }, [symbol]);

  const submitWrite = useCallback(async (
    kind: WriteKind,
    label: string,
    write: (requestId: string) => Promise<Awaited<ReturnType<typeof getStockVibeRequest>>>,
    runId?: string,
    relatedRunId?: string,
  ) => {
    if (!enabled || busy || writeLock.current) return;
    const requestId = newRequestId();
    const tracked: TrackedWrite = {
      requestId,
      kind,
      phase: "dispatching",
      createdAt: new Date().toISOString(),
      label,
      ...(runId ? { runId } : {}),
      ...(relatedRunId ? { relatedRunId } : {}),
    };
    if (!persist((current) => ({ ...current, writes: [tracked, ...current.writes].slice(0, 100) }), true)) return;
    writeLock.current = true;
    setBusy(true);
    try {
      const record = await write(requestId);
      acceptReceipt(tracked, record);
    } catch (error) {
      updateWrite(requestId, { phase: "checking" });
      showAlert(`write:${requestId}`, safeError(error));
    } finally {
      writeLock.current = false;
      setBusy(false);
    }
  }, [acceptReceipt, busy, enabled, persist, showAlert, updateWrite]);

  const loadReads = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const [presetResult, runResult] = await Promise.all([
        listStockVibeSwarmPresets(),
        listStockVibeSwarmRuns(100),
      ]);
      setPresets(presetResult.native);
      const nextRuns = parseRuns(runResult.native);
      setRuns(nextRuns);
      setSelectedRunId((current) => current && (nextRuns.some((run) => run.id === current)
        || savedRef.current.writes.some((write) => write.runId === current)
        || savedRef.current.writes.some((write) => write.relatedRunId === current))
        ? current
        : nextRuns[0]?.id ?? null);
    } catch (error) {
      showAlert("swarm-list", safeError(error));
    } finally {
      setLoading(false);
    }
  }, [enabled, showAlert]);

  useEffect(() => { void loadReads(); }, [loadReads, revision]);

  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const list = await listStockVibeSwarmRuns(100);
        const nextRuns = parseRuns(list.native);
        if (stopped) return;
        setRuns(nextRuns);
        for (const tracked of savedRef.current.writes) {
          if (["dispatching", "checking", "unknown"].includes(tracked.phase)) {
            try {
              const request = await getStockVibeRequest(tracked.requestId);
              if (!stopped) acceptReceipt(tracked, request);
            } catch {
              if (!stopped) updateWrite(tracked.requestId, { phase: "unknown" });
            }
          }
        }
        const ids = new Set<string>([
          ...(selectedRunId ? [selectedRunId] : []),
          ...savedRef.current.writes
            .filter((write) => write.phase === "accepted" && write.runId)
            .map((write) => write.runId as string),
        ]);
        for (const id of ids) {
          if (stopped) return;
          try {
            const result = await getStockVibeSwarmRun(id);
            if (!isRecord(result.native) || result.native.id !== id) continue;
            const detail = result.native;
            setRunDetails((current) => ({ ...current, [id]: detail }));
            const status = stringValue(detail.status);
            if (status && TERMINAL_RUNS.has(status as RunStatus)) {
              persist((current) => ({
                ...current,
                writes: current.writes.map((write) => write.phase === "accepted" && write.runId === id
                  ? { ...write, phase: "finished" }
                  : write),
              }));
            }
            if (id === selectedRunId) {
              const artifactResult = await listStockVibeSwarmArtifacts(id);
              if (!stopped) setArtifacts(parseArtifacts(artifactResult.native));
            }
          } catch {
            // Preserve the last displayed state; the next read reconciles it.
          }
        }
      } catch (error) {
        if (!stopped) showAlert("swarm-poll", safeError(error));
      }
      if (!stopped) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [acceptReceipt, enabled, persist, selectedRunId, showAlert, updateWrite, revision]);

  useEffect(() => {
    if (!enabled || !selectedRunId) {
      setRunDetails({});
      setArtifacts([]);
      return undefined;
    }
    let stopped = false;
    setArtifacts([]);
    Promise.all([getStockVibeSwarmRun(selectedRunId), listStockVibeSwarmArtifacts(selectedRunId)])
      .then(([run, artifactList]) => {
        if (stopped) return;
        if (isRecord(run.native) && run.native.id === selectedRunId) {
          setRunDetails((current) => ({ ...current, [selectedRunId]: run.native }));
        }
        setArtifacts(parseArtifacts(artifactList.native));
      })
      .catch((error: unknown) => {
        if (!stopped) showAlert(`run:${selectedRunId}`, safeError(error));
      });
    return () => { stopped = true; };
  }, [enabled, selectedRunId, showAlert]);

  const presetAvailable = parsePresetExists(presets);
  const activeRuns = runs.filter((run) => run.status === "pending" || run.status === "running");
  const uncertainWrite = saved.writes.some((write) => write.phase === "dispatching" || write.phase === "checking" || write.phase === "unknown");
  const trackedRunPending = saved.writes.some((write) => {
    if (write.phase !== "accepted" || !write.runId) return false;
    const runDetail = runDetails[write.runId];
    const status = isRecord(runDetail) && typeof runDetail.status === "string" ? runDetail.status : "pending";
    return !TERMINAL_RUNS.has(status as RunStatus);
  });
  const writeDisabled = !enabled || busy || uncertainWrite;
  const startDisabled = writeDisabled || trackedRunPending || activeRuns.length > 0;
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  const detail = selectedRunId && isRecord(runDetails[selectedRunId]) ? runDetails[selectedRunId] : null;
  const detailStatus = stringValue(detail?.status) ?? selectedRun?.status ?? "unknown";
  const tasks = Array.isArray(detail?.tasks) ? detail.tasks : [];
  const agents = Array.isArray(detail?.agents) ? detail.agents : [];
  const groundingMetadata = isRecord(detail?.grounding_metadata) ? detail.grounding_metadata : {};
  const actualSource = Object.keys(groundingMetadata).length
    ? Object.fromEntries(Object.entries(groundingMetadata).map(([code, value]) => [code, isRecord(value) ? value.provenance : null]))
    : pickNativeFields(detail, ["source", "actual_source", "data_sources", "source_metadata", "grounding_source"]);
  const actualWindow = Object.keys(groundingMetadata).length
    ? Object.fromEntries(Object.entries(groundingMetadata).map(([code, value]) => [code, isRecord(value) ? value.coverage : null]))
    : pickNativeFields(detail, ["actual_start_date", "actual_end_date", "actual_window", "actual_date_range", "coverage_window", "grounding_window"]);
  const groundingFields = detail ? Object.fromEntries(Object.entries(detail).filter(([key]) => key.startsWith("grounding_"))) : {};
  const requestedVars = isRecord(detail?.user_vars) ? detail.user_vars : null;
  const finalReport = stringValue(detail?.final_report);
  const taskStates = tasks.map((task) => isRecord(task) ? stringValue(task.status) : null).filter(Boolean);
  const completedTaskCount = taskStates.filter((state) => state === "completed").length;
  const requestedSymbol = typeof requestedVars?.symbol === "string" ? bareStockCode(requestedVars.symbol) : "";
  const requestedStartDate = typeof requestedVars?.start_date === "string" ? requestedVars.start_date : "";
  const requestedEndDate = typeof requestedVars?.end_date === "string" ? requestedVars.end_date : "";
  const selectedRecordLabel = selectedRun ? runLabel(selectedRun, runDetails) : "研究记录";
  const busyForRun = (runId: string) => saved.writes.some((write) => write.runId === runId
    && (write.phase === "dispatching" || write.phase === "checking" || write.phase === "unknown"
      || write.kind === "cancel" && write.phase === "accepted"));

  const formError = useMemo(() => {
    const code = symbolDraft.trim();
    if (code && !/^[0-9]{6}$/.test(code)) return "证券代码需为六位数字。";
    if (code && !inferStockVibeExchange(code)) return "暂无法识别该代码，请核对六位 A 股代码。";
    if (startDate && !validDate(startDate)) return "起始日期无效。";
    if (endDate && !validDate(endDate)) return "结束日期无效。";
    if (startDate && endDate && startDate > endDate) return "起始日期不能晚于结束日期。";
    if (!code || !startDate || !endDate) return "请填写证券代码和日期区间。";
    return null;
  }, [endDate, startDate, symbolDraft]);

  const startRun = () => {
    const code = symbolDraft.trim();
    const exchange = inferStockVibeExchange(code);
    if (formError || !presetAvailable || !exchange) return;
    const normalized = `${code}.${exchange}`;
    const composedQuestion = [MODES[mode], question.trim()].filter(Boolean).join("\n\n").slice(0, 5000);
    const input: StockVibeStartSwarmInput = {
      preset_name: "mona_ashare_research",
      user_vars: { symbol: normalized, start_date: startDate, end_date: endDate, question: composedQuestion },
    };
    const label = `行情证据复核 · ${code} · ${startDate} 至 ${endDate}`;
    void submitWrite("create", label, (requestId) => createStockVibeSwarm(requestId, input));
  };

  const cancelRun = (runId: string) => {
    void submitWrite("cancel", `停止复核 · ${selectedRecordLabel}`, (requestId) => cancelStockVibeSwarm(runId, requestId), runId);
  };

  const resumeRun = (runId: string) => {
    void submitWrite("resume", `重新发起复核 · ${selectedRecordLabel}`, (requestId) => resumeStockVibeSwarm(runId, requestId), undefined, runId);
  };

  const downloadArtifact = async (artifact: SwarmArtifact) => {
    if (!selectedRunId || !/^[a-f0-9]{64}$/.test(artifact.artifact_id)) return;
    try {
      const blob = await downloadStockVibeSwarmArtifact(selectedRunId, artifact.artifact_id);
      const safeFilename = artifact.filename.replace(/[<>:"|?*]/g, "_");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = safeFilename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      showAlert(`artifact:${artifact.artifact_id}`, safeError(error));
    }
  };

  return (
    <section className="space-y-6">
      <SectionHeader
        title="行情证据复核"
        description="基于指定日期内的行情，研究并核对你的问题。"
      />
      {!enabled ? (
        <EmptyState title="行情证据复核暂不可用" description="请检查功能资源和模型设置。" />
      ) : (
        <>
          <section className="space-y-4">
            <SectionHeader title="开始复核" />
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-caption font-medium" htmlFor="sv-team-symbol">证券代码
                <Input id="sv-team-symbol" value={symbolDraft} maxLength={6} inputMode="numeric" placeholder="例如 002460" autoComplete="off" spellCheck={false} onChange={(event) => setSymbolDraft(event.target.value)} disabled={startDisabled} />
              </label>
              <p className="self-end pb-2 text-caption text-muted-foreground">观察周期：{MODE_LABELS[mode]}</p>
              <label className="space-y-1 text-caption font-medium" htmlFor="sv-team-start">开始日期
                <Input id="sv-team-start" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} disabled={startDisabled} />
              </label>
              <label className="space-y-1 text-caption font-medium" htmlFor="sv-team-end">结束日期
                <Input id="sv-team-end" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} disabled={startDisabled} />
              </label>
            </div>
            <label className="block space-y-1 text-caption font-medium" htmlFor="sv-team-question">想核对的问题（可选）
              <Textarea id="sv-team-question" className="min-h-24" maxLength={4500} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：这段行情上涨时，成交量有没有同步放大？" disabled={startDisabled} />
            </label>
            {formError && (symbolDraft || startDate || endDate) && <p className="text-caption text-destructive" role="alert">{formError}</p>}
            {!presetAvailable && <p className="text-caption text-muted-foreground">行情复核暂不可用，请稍后再试。</p>}
            <Button type="button" variant="interaction" onClick={startRun} disabled={startDisabled || !!formError || !presetAvailable}>
              {busy ? "正在提交…" : "开始行情证据复核"}
            </Button>
          </section>

          <section className="space-y-4 border-t border-border pt-4">
            <SectionHeader title="研究记录" />
            {runs.length ? (
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                <div className="space-y-1 text-caption font-medium">
                  <span>选择记录</span>
                  <Select
                    value={selectedRunId ?? undefined}
                    onValueChange={setSelectedRunId}
                    options={runs.map((run) => ({ value: run.id, label: runLabel(run, runDetails) }))}
                    placeholder="选择研究记录"
                    disabled={loading}
                    aria-label="选择研究记录"
                  />
                </div>
                {selectedRun && <p className="text-caption text-muted-foreground">状态：{statusLabel(detailStatus)}</p>}
              </div>
            ) : (
              <EmptyState
                title="暂无研究记录"
                description={loading ? "正在读取记录…" : "完成一次复核后，研究结果会显示在这里。"}
                className="py-6"
              />
            )}

            {selectedRunId && detail && (
              <div className="space-y-4">
                <header className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h3 className="font-semibold">
                      {requestedSymbol && requestedStartDate && requestedEndDate
                        ? requestedSymbol + " · " + requestedStartDate + " 至 " + requestedEndDate
                        : selectedRecordLabel}
                    </h3>
                    <p className="text-caption text-muted-foreground">状态：{statusLabel(detailStatus)}</p>
                    {tasks.length > 0 && <p className="text-caption text-muted-foreground">已完成 {completedTaskCount} / {tasks.length} 个步骤</p>}
                  </div>
                  <div className="flex gap-2">
                    {(detailStatus === "running" || detailStatus === "pending") && (
                      <Button type="button" variant="secondary" disabled={writeDisabled || busyForRun(selectedRunId)} onClick={() => cancelRun(selectedRunId)}>停止复核</Button>
                    )}
                    {(detailStatus === "failed" || detailStatus === "cancelled") && (
                      <Button type="button" variant="secondary" disabled={writeDisabled || activeRuns.length > 0 || busyForRun(selectedRunId)} onClick={() => resumeRun(selectedRunId)}>重新发起复核</Button>
                    )}
                  </div>
                </header>

                <p className="whitespace-pre-wrap text-caption"><span className="font-medium">本次核对问题：</span>{typeof requestedVars?.question === "string" && requestedVars.question.trim()
                  ? requestedVars.question : "原记录未保存问题，请结合本次数据区间和报告查看。"}</p>

                <section className="space-y-2">
                  <SectionHeader title="数据来源与覆盖范围" />
                  {Object.entries(groundingMetadata).map(([code, value]) => {
                    const metadata = isRecord(value) ? value : {};
                    const provenance = isRecord(metadata.provenance) ? metadata.provenance : {};
                    const coverage = isRecord(metadata.coverage) ? metadata.coverage : {};
                    const displayCode = bareStockCode(code) || code.replace(/\.(SH|SZ|BJ)$/i, "");
                    const rowCount = coverage.row_count;
                    return (
                      <p key={code} className="text-caption">
                        {displayCode} · {displaySource(provenance.source)} · {String(coverage.start_date ?? "起始日期待确认")} 至 {String(coverage.end_date ?? "结束日期待确认")} · {rowCount === undefined ? "数据条数待确认" : String(rowCount) + " 个交易日"}
                      </p>
                    );
                  })}
                  {!Object.keys(groundingMetadata).length && <p className="text-caption text-muted-foreground">研究完成后会显示本次实际使用的数据范围。</p>}
                  <StockVibeInfo title="数据来源详情" label="查看来源详情">
                    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-micro">{safeJson({ sources: actualSource, windows: actualWindow, ...groundingFields })}</pre>
                  </StockVibeInfo>
                </section>

                <section className="space-y-2 border-t border-border pt-4">
                  <SectionHeader title="研究报告" />
                  {detailStatus === "completed"
                    ? <StockVibeReport>{finalReport ? hiddenPathText(finalReport) : "本次没有生成报告正文。"}</StockVibeReport>
                    : <p className="text-caption text-muted-foreground">研究完成后会在这里显示报告。</p>}
                </section>

                <section className="space-y-2 border-t border-border pt-4">
                  <SectionHeader title="可下载文件" />
                  {artifacts.length ? (
                    <ul className="divide-y divide-border">
                      {artifacts.map((artifact) => (
                        <li key={artifact.artifact_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                          <span className="min-w-0 text-caption">{artifact.filename}</span>
                          <Button type="button" size="sm" variant="secondary" onClick={() => void downloadArtifact(artifact)}>下载</Button>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-caption text-muted-foreground">暂无可下载文件。</p>}
                </section>

                <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3">
                  <StockVibeInfo
                    title="研究阶段进度"
                    label={"查看研究进度（" + completedTaskCount + "/" + tasks.length + "）"}
                  >
                    {tasks.length ? (
                      <ul className="divide-y divide-border">
                        {tasks.map((item, index) => {
                          const task = isRecord(item) ? item : {};
                          return (
                            <li key={String(task.id ?? index)} className="py-3 first:pt-0 last:pb-0">
                              <div className="flex flex-wrap justify-between gap-2 text-caption">
                                <span className="font-medium">{taskStageLabel(index)}</span>
                                <span>{taskStatusLabel(task.status)}</span>
                              </div>
                              {typeof task.summary === "string" && <p className="mt-1 whitespace-pre-wrap text-caption text-muted-foreground">{hiddenPathText(task.summary)}</p>}
                              {typeof task.error === "string" && <p className="mt-1 whitespace-pre-wrap text-caption text-destructive">{hiddenPathText(task.error)}</p>}
                            </li>
                          );
                        })}
                      </ul>
                    ) : <p className="text-caption text-muted-foreground">暂未收到阶段进度。</p>}
                  </StockVibeInfo>
                  <StockVibeInfo title="研究记录详情" label="查看研究记录详情">
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-micro">{safeJson({ id: selectedRunId, agents, tasks, user_vars: requestedVars })}</pre>
                  </StockVibeInfo>
                </div>
              </div>
            )}
            {selectedRunId && !detail && <p className="text-caption text-muted-foreground">正在读取研究结果…</p>}
          </section>
          <StockVibeInfo title="提交情况" label="查看提交情况">
            {saved.writes.length ? (
              <ul className="divide-y divide-border">
                {saved.writes.map((item) => (
                  <li key={item.requestId} className="flex justify-between gap-3 py-2 first:pt-0 last:pb-0">
                    <span>{writeKindLabel(item.kind)}</span>
                    <span className="text-muted-foreground">{statusLabel(item.phase)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-caption text-muted-foreground">暂无提交记录。</p>}
          </StockVibeInfo>
        </>
      )}

      <AlertDialog open={alertMessage !== null} onOpenChange={(open) => { if (!open) setAlertMessage(null); }}>
        <AlertDialogContent className="scrollbar-scope">
          <AlertDialogHeader>
            <AlertDialogTitle>行情证据复核提示</AlertDialogTitle>
            <AlertDialogDescription>{alertMessage}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel onClick={() => setAlertMessage(null)}>关闭</AlertDialogCancel></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
