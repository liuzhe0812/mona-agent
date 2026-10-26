import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ModelSelector } from "@/components/models/ModelSelector";
import type { ModelOption } from "@/components/models/model-sources";
import { developmentApi, type DevExecutor, type ExecutorId } from "@/lib/development-api";
import {
  getStockVibeModelOptions,
  getStockVibeRequest,
  selectStockVibeModel,
  StockVibeApiError,
  type StockVibeModelBinding,
  type StockVibeModelOptions,
  type StockVibeRequestRecord,
} from "@/lib/stock-vibe-api";

export interface StockVibeModelSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onOpenEngineSettings?: () => void;
}

type PendingSelection = {
  requestId: string;
  modelPreset: string | null;
  modelBinding?: StockVibeModelBinding | null;
  phase: "dispatching" | "checking" | "blocked";
};

type ModelSelection = { modelPreset: string | null; modelBinding: StockVibeModelBinding | null };
type NativeExecutorId = Exclude<ExecutorId, "mona">;
type CanonicalBinding = { executor: NativeExecutorId; model: string; provider: null; effort: string | null };

const STORAGE_KEY = "mona.stock-vibe.model-selection.v1";
const UUID = /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
const HASH = /^[a-f0-9]{64}$/i;

function normalizeRequestId(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID().replace(/-/g, "").toLowerCase();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function readPending(): PendingSelection | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const pending = value as Record<string, unknown>;
    if (typeof pending.requestId !== "string" || !UUID.test(pending.requestId)) return null;
    if (pending.modelPreset !== null && typeof pending.modelPreset !== "string") return null;
    if (pending.modelBinding !== undefined && pending.modelBinding !== null && !canonicalBinding(pending.modelBinding)) return null;
    if (pending.modelBinding != null && pending.modelPreset !== null) return null;
    return {
      requestId: pending.requestId,
      modelPreset: pending.modelPreset as string | null,
      ...(pending.modelBinding !== undefined ? { modelBinding: pending.modelBinding as StockVibeModelBinding | null } : {}),
      phase: pending.phase === "blocked" ? "blocked" : "checking",
    };
  } catch {
    return null;
  }
}

function safeError(error: unknown): string {
  return error instanceof StockVibeApiError
    ? error.message
    : "无法读取或保存股票研究模型设置，请稍后重试。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalBinding(value: unknown): CanonicalBinding | null {
  if (!isRecord(value)
    || !(value.executor === "codex" || value.executor === "claude" || value.executor === "codebuddy")
    || typeof value.model !== "string" || !value.model.trim()
    || value.provider !== undefined && value.provider !== null
    || value.effort !== undefined && value.effort !== null && typeof value.effort !== "string") return null;
  return {
    executor: value.executor,
    model: value.model,
    provider: null,
    effort: typeof value.effort === "string" ? value.effort : null,
  };
}

function sameBinding(expected: unknown, actual: unknown): boolean {
  const left = canonicalBinding(expected);
  const right = canonicalBinding(actual);
  return !!left && !!right
    && left.executor === right.executor
    && left.model === right.model
    && left.provider === right.provider
    && left.effort === right.effort;
}

function successBody(record: StockVibeRequestRecord, expected: ModelSelection): Record<string, unknown> | null {
  const receipt = record.receipt;
  const statusCode = receipt?.status_code;
  if (record.status !== "completed"
    || record.receipt_owner !== "mona_settings"
    || record.source !== null
    || !receipt
    || typeof statusCode !== "number"
    || statusCode < 200 || statusCode >= 300
    || typeof record.receipt_sha256 !== "string"
    || !HASH.test(record.receipt_sha256)
    || !isRecord(receipt.body)
    || receipt.body.model_preset !== expected.modelPreset) return null;
  if (expected.modelBinding) {
    if (!sameBinding(expected.modelBinding, receipt.body.model_binding)) return null;
  } else if ("model_binding" in receipt.body && receipt.body.model_binding !== null) {
    return null;
  }
  return receipt.body;
}

function rejectedBody(record: StockVibeRequestRecord): Record<string, unknown> | null {
  const receipt = record.receipt;
  const statusCode = receipt?.status_code;
  if (record.status !== "rejected"
    || record.receipt_owner !== "mona_settings"
    || record.source !== null
    || !receipt
    || typeof statusCode !== "number"
    || !Number.isInteger(statusCode)
    || statusCode < 400 || statusCode >= 500
    || typeof record.receipt_sha256 !== "string"
    || !HASH.test(record.receipt_sha256)
    || !isRecord(receipt.body)) return null;
  return receipt.body;
}

function rejectedMessage(record: StockVibeRequestRecord): string {
  const body = isRecord(record.receipt?.body) ? record.receipt.body : null;
  const code = typeof body?.error === "string" ? body.error : "";
  if (record.error_category === "not_dispatched" && record.receipt === null && record.source === null) {
    return "这次保存请求已确认未发出。你可以检查后手动重试。";
  }
  if (code === "model_busy") return "股票研究任务正在运行，暂时不能切换模型。任务结束后可手动重试。";
  if (code === "unsupported_model") return "此模型当前不可用，请选择其他模型或检查引擎设置。";
  return "模型设置未被接受。检查选择后，可由你手动重试。";
}

function choiceLabel(choice: StockVibeModelOptions["choices"][number]): string {
  const name = choice.preset === "default" ? "默认" : choice.label.replace(/^股票研究\s*[:：·]\s*/, "");
  return name === choice.model ? name : `${name} · ${choice.model}`;
}

function selectionKey(selection: ModelSelection): string | null {
  const binding = canonicalBinding(selection.modelBinding);
  if (binding) return `native:${binding.executor}:${binding.model}`;
  return selection.modelPreset ? `api:${selection.modelPreset}` : null;
}

function sameSelection(left: ModelSelection, right: ModelSelection): boolean {
  const leftBinding = canonicalBinding(left.modelBinding);
  const rightBinding = canonicalBinding(right.modelBinding);
  if (leftBinding || rightBinding) {
    return left.modelPreset === null && right.modelPreset === null
      && !!leftBinding && !!rightBinding && sameBinding(leftBinding, rightBinding);
  }
  return left.modelPreset === right.modelPreset;
}

function optionKey(option: ModelOption): string | null {
  if (option.executor === "mona") return option.selectionId ? `api:${option.selectionId}` : null;
  return option.executor && option.model ? `native:${option.executor}:${option.model}` : null;
}

function nativeDisabledReason(executor: DevExecutor): string | null {
  if (executor.enabled === false) return "请先在引擎设置中启用此引擎。";
  if (executor.available === false || executor.programAvailable === false) return "此引擎当前不可用，请在设置中检查连接。";
  if (executor.probe?.authentication !== "ready") return "请先连接此引擎账号。";
  return null;
}

function nativeModelOptions(executors: DevExecutor[]): ModelOption[] {
  return executors.flatMap((executor) => {
    if (executor.id === "mona") return [];
    const disabledReason = nativeDisabledReason(executor);
    return (Array.isArray(executor.models) ? executor.models : []).flatMap((model) => {
      if (typeof model.id !== "string" || !model.id.trim()) return [];
      const alias = typeof model.label === "string" && model.label.trim() ? model.label.trim() : model.id;
      const label = alias === model.id ? alias : `${alias} · ${model.id}`;
      return [{
        provider: `native:${executor.id}`,
        providerLabel: executor.name,
        executor: executor.id,
        model: model.id,
        label,
        active: false,
        disabledReason,
        description: model.description,
        contextWindow: model.contextWindow,
        reasoningEfforts: model.reasoningEfforts,
        reasoningEffort: model.reasoningEffort,
        defaultReasoningEffort: model.reasoningEffort,
      }];
    });
  });
}

function apiModelOptions(options: StockVibeModelOptions | null): ModelOption[] {
  return (options?.choices ?? []).filter((choice) => choice.protocol_supported).map((choice) => ({
    provider: "mona-api",
    providerLabel: "Mona API",
    executor: "mona",
    selectionId: choice.preset,
    model: choice.model,
    label: choiceLabel(choice),
    active: false,
  }));
}

export function StockVibeModelSettings({
  open,
  onOpenChange,
  onSaved,
  onOpenEngineSettings,
}: StockVibeModelSettingsProps) {
  const [options, setOptions] = useState<StockVibeModelOptions | null>(null);
  const [nativeExecutors, setNativeExecutors] = useState<DevExecutor[]>([]);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelSelection | null>(null);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const pendingRef = useRef<PendingSelection | null>(null);
  const completedIds = useRef(new Set<string>());
  const shownErrors = useRef(new Set<string>());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const showErrorRef = useRef<(key: string, message: string) => void>(() => undefined);

  const showError = (key: string, message: string) => {
    if (shownErrors.current.has(key)) return;
    shownErrors.current.add(key);
    setError(message);
  };
  showErrorRef.current = showError;

  const savePending = (value: PendingSelection): boolean => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      setError("无法安全保存请求核对信息，因此没有提交模型设置。");
      return false;
    }
    pendingRef.current = value;
    setPending(value);
    return true;
  };

  const updatePendingPhase = (value: PendingSelection, phase: PendingSelection["phase"]) => {
    const next = { ...value, phase };
    savePending(next);
  };

  const clearPending = (requestId: string) => {
    if (pendingRef.current?.requestId !== requestId) return;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // The in-memory state still prevents a second write during this dialog session.
    }
    pendingRef.current = null;
    setPending(null);
  };

  const finishSaved = (record: StockVibeRequestRecord, value: PendingSelection) => {
    if (completedIds.current.has(value.requestId)) return;
    const selection = { modelPreset: value.modelPreset, modelBinding: value.modelBinding ?? null };
    if (!successBody(record, selection)) {
      updatePendingPhase(value, "blocked");
      showErrorRef.current(value.requestId, "模型设置回执未能确认，系统不会重复提交。请稍后核对状态。");
      return;
    }
    completedIds.current.add(value.requestId);
    clearPending(value.requestId);
    setOptions((current) => current ? {
      ...current,
      model_preset: value.modelPreset,
      model_binding: value.modelBinding ?? null,
    } : current);
    setDraft(selection);
    setError(null);
    setStatus("已保存。");
    onSaved();
    onOpenChange(false);
  };

  const processRecord = (record: StockVibeRequestRecord, value: PendingSelection) => {
    if (normalizeRequestId(record.request_id) !== normalizeRequestId(value.requestId)) {
      updatePendingPhase(value, "blocked");
      showErrorRef.current(value.requestId, "请求回执标识不匹配，模型设置结果尚未确认。");
      return;
    }
    if (record.status === "pending" || record.status === "unknown") {
      updatePendingPhase(value, "checking");
      setStatus("正在核对保存状态；不会重复提交。");
      return;
    }
    if (record.status === "rejected") {
      if (record.error_category === "not_dispatched" && record.receipt === null && record.source === null) {
        clearPending(value.requestId);
        setStatus(null);
        showErrorRef.current(value.requestId, "这次模型设置请求已确认未发出，你可以手动重新保存。");
        return;
      }
      if (!rejectedBody(record)) {
        savePending({ ...value, phase: "blocked" });
        showErrorRef.current(value.requestId, "模型设置拒绝回执无法确认，系统不会重复提交。请稍后核对状态。");
        return;
      }
      clearPending(value.requestId);
      setStatus(null);
      showErrorRef.current(value.requestId, rejectedMessage(record));
      return;
    }
    finishSaved(record, value);
  };

  const processRecordRef = useRef(processRecord);
  processRecordRef.current = processRecord;

  useEffect(() => {
    if (!open) return undefined;
    let stopped = false;
    const restored = readPending();
    if (restored) {
      pendingRef.current = restored;
      setPending(restored);
      setDraft({ modelPreset: restored.modelPreset, modelBinding: restored.modelBinding ?? null });
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(restored));
      } catch {
        // The saved request remains query-only; no write is ever replayed.
      }
    } else {
      pendingRef.current = null;
      setPending(null);
    }
    setLoading(true);
    setError(null);
    setNativeError(null);
    setStatus(null);
    setNativeExecutors([]);
    void getStockVibeModelOptions().then((value) => {
      if (stopped) return;
      setOptions(value);
      const saved = readPending();
      if (saved) {
        pendingRef.current = saved;
        setPending(saved);
        setDraft({ modelPreset: saved.modelPreset, modelBinding: saved.modelBinding ?? null });
      } else {
        const compatibleDefault = value.choices.some((choice) => choice.preset === "default" && choice.protocol_supported);
        const binding = canonicalBinding(value.model_binding);
        setDraft({
          modelPreset: binding ? null : value.model_preset ?? (compatibleDefault ? "default" : null),
          modelBinding: binding,
        });
      }
    }).catch((reason: unknown) => {
      if (!stopped) showErrorRef.current("options", safeError(reason));
    }).finally(() => {
      if (!stopped) setLoading(false);
    });
    void developmentApi.providerExecutors().then(({ executors }) => {
      if (stopped) return;
      setNativeExecutors(Array.isArray(executors) ? executors : []);
    }).catch(() => {
      if (!stopped) setNativeError("本机模型列表暂不可用，可在引擎设置中检查连接。");
    });
    return () => {
      stopped = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !pending || pending.phase !== "checking") return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const current = pendingRef.current;
      if (!current || current.requestId !== pending.requestId || current.phase !== "checking") return;
      try {
        const record = await getStockVibeRequest(current.requestId);
        if (stopped) return;
        processRecordRef.current(record, current);
      } catch {
        if (stopped) return;
        showErrorRef.current(current.requestId, "暂时无法核对模型设置状态；系统会继续查询，不会重复提交。");
      }
      if (!stopped && pendingRef.current?.requestId === current.requestId && pendingRef.current.phase === "checking") {
        timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, pending?.phase, pending?.requestId]);

  const apiOptions = apiModelOptions(options);
  const nativeOptions = nativeModelOptions(nativeExecutors);
  const draftKey = draft ? selectionKey(draft) : null;
  const modelOptions = [...apiOptions, ...nativeOptions].map((option) => {
    const active = optionKey(option) === draftKey;
    return {
      ...option,
      active,
      ...(active && draft?.modelBinding ? {
        reasoningEffort: draft.modelBinding.effort ?? null,
        defaultReasoningEffort: draft.modelBinding.effort ?? null,
      } : {}),
    };
  });
  const selected = modelOptions.find((option) => option.active) ?? null;
  const savedSelection = {
    modelPreset: options?.model_preset ?? null,
    modelBinding: canonicalBinding(options?.model_binding),
  };
  const dirty = Boolean(selected && draft && !sameSelection(draft, savedSelection));
  const currentChoice = options?.model_preset ?? null;
  const currentUnsupported = Boolean(options && currentChoice && !options.choices.some((choice) => choice.preset === currentChoice && choice.protocol_supported));
  const selectedNeedsCredentials = selected?.executor === "mona"
    && !options?.choices.find((choice) => choice.preset === selected.selectionId)?.credentials_configured;
  const sourceExecutors = nativeExecutors.filter((executor) => executor.id !== "mona");
  const hasNativeModels = sourceExecutors.some((executor) => Array.isArray(executor.models)
    && executor.models.some((model) => typeof model.id === "string" && !!model.id.trim()));
  const nativeNotice = nativeError ?? (sourceExecutors.length > 0 && !hasNativeModels
    ? "本机引擎暂无可用模型，可在引擎设置中检查连接。"
    : null);

  const save = async () => {
    if (!open || !selected || !draft || !dirty || selected.disabledReason || pendingRef.current || saving) return;
    const binding = canonicalBinding(draft.modelBinding);
    if (!binding && !draft.modelPreset) return;
    const value: PendingSelection = {
      requestId: newRequestId(),
      modelPreset: binding ? null : draft.modelPreset,
      ...(binding ? { modelBinding: binding } : {}),
      phase: "dispatching",
    };
    if (!savePending(value)) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const record = value.modelBinding
        ? await selectStockVibeModel(value.requestId, null, value.modelBinding)
        : await selectStockVibeModel(value.requestId, value.modelPreset);
      processRecordRef.current(record, value);
    } catch (reason) {
      updatePendingPhase(value, "checking");
      showError(value.requestId, safeError(reason));
    } finally {
      setSaving(false);
    }
  };

  const retryCheck = () => {
    const current = pendingRef.current;
    if (!open || !current || current.phase !== "blocked") return;
    updatePendingPhase(current, "checking");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="scrollbar-scope">
        <DialogHeader>
          <DialogTitle>股票研究模型</DialogTitle>
        </DialogHeader>

        {loading ? <p className="text-caption text-muted-foreground" role="status">正在读取模型选项…</p> : null}
        {error ? <p className="text-caption text-destructive" role="alert">{error}</p> : null}
        {status ? <p className="text-caption text-muted-foreground" role="status">{status}</p> : null}
        {pending ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-caption" role="status">
            <span>保存请求尚未确认。只会查询原请求，不会重复提交。</span>
            {pending.phase === "blocked" && <Button type="button" size="sm" variant="secondary" onClick={retryCheck}>再次核对</Button>}
          </div>
        ) : null}

        {nativeNotice ? <p className="text-caption text-muted-foreground" role="status">{nativeNotice}</p> : null}

        {options && modelOptions.length ? (
          <div className="space-y-2">
            <p className="text-ui font-medium">可用模型</p>
            <ModelSelector
              options={modelOptions}
              disabled={loading || saving || Boolean(pending)}
              onSelect={(option, effort) => {
                if (option.executor === "mona") {
                  setDraft({ modelPreset: option.selectionId ?? null, modelBinding: null });
                } else if (option.executor === "codex" || option.executor === "claude" || option.executor === "codebuddy") {
                  setDraft({ modelPreset: null, modelBinding: {
                    executor: option.executor,
                    model: option.model,
                    provider: null,
                    effort: effort ?? null,
                  } });
                }
                setError(null);
                setStatus(null);
              }}
              onManage={onOpenEngineSettings}
            />
            {currentUnsupported ? (
              <p className="text-caption text-destructive" role="alert">当前预设不支持股票研究协议，请选择兼容预设。</p>
            ) : null}
            {selected?.disabledReason ? <p className="text-caption text-muted-foreground" role="status">{selected.disabledReason}</p> : null}
            {selectedNeedsCredentials ? (
              <div className="space-y-1">
                <p className="text-caption text-muted-foreground">请在引擎设置中配置该模型的 API 密钥。</p>
                {onOpenEngineSettings && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => {
                    onOpenChange(false);
                    onOpenEngineSettings();
                  }}>
                    打开引擎设置
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {options && modelOptions.length === 0 ? (
          <EmptyState
            className="py-5"
            title="暂无兼容模型"
            description="请在引擎设置中选择可用模型。"
            action={onOpenEngineSettings && (
              <Button type="button" variant="secondary" onClick={() => {
                onOpenChange(false);
                onOpenEngineSettings();
              }}>
                打开引擎设置
              </Button>
            )}
          />
        ) : null}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button type="button" disabled={!selected || !dirty || !!selected.disabledReason || loading || saving || Boolean(pending)} onClick={() => void save()}>
            {saving ? "正在保存…" : "保存模型选择"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
