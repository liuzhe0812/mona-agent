import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  cancelStockVibeSchedule,
  createStockVibeRequestId,
  createStockVibeSchedule,
  getStockVibeRequest,
  updateStockVibeSchedule,
  StockVibeApiError,
  type StockVibeResearchTask,
  type StockVibeScenarioMode,
  type StockVibeSchedule,
  type StockVibeRequestRecord,
} from "@/lib/stock-vibe-api";
import { STOCK_RESEARCH_MODES, STOCK_RESEARCH_TASKS, stockResearchPrompt } from "@/lib/stock-vibe-workbench";

type FollowupAction = "create" | "cancel" | "update";

interface PendingFollowupWrite {
  requestId: string;
  jobId: string;
  action: FollowupAction;
}

type StoredFollowupWrite = PendingFollowupWrite | "invalid" | "unavailable" | null;
type ReceiptResult = "completed" | "rejected" | "unknown";

const STORAGE_PREFIX = "mona.stock-vibe.followup.v1:";
const requestIdPattern = /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
const jobIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const completedJobStatuses = new Set(["completed", "failed", "cancelled", "expired"]);

type Cadence = { time: string; frequency: "daily" | "weekdays" | "weekly" | "custom"; days?: number[] };
const weekDays = [1, 2, 3, 4, 5, 6, 0];
const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
const validDays = (value: unknown): value is number[] => Array.isArray(value) && value.length > 0 && value.length <= 7
  && value.every((day) => Number.isInteger(day) && weekDays.includes(day)) && new Set(value).size === value.length;
const tasks = Object.keys(STOCK_RESEARCH_TASKS) as StockVibeResearchTask[];
const defaultCadence: Cadence = { time: "16:00", frequency: "weekdays" };
const validTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const preferencesKey = (symbol: string) => `mona.stock-vibe.followup-times.v1:${encodeURIComponent(symbol)}`;

function readCadences(symbol: string): Partial<Record<StockVibeResearchTask, Cadence>> {
  try {
    const saved = JSON.parse(localStorage.getItem(preferencesKey(symbol)) || "{}");
    return Object.fromEntries(tasks.filter((task) => {
      const value = saved?.[task];
      return validTime(value?.time) && (["daily", "weekdays"].includes(value?.frequency)
        || ["weekly", "custom"].includes(value?.frequency) && validDays(value?.days) && (value.frequency !== "weekly" || value.days.length === 1));
    })
      .map((task) => [task, saved[task]]));
  } catch { return {}; }
}

function jobCadence(job?: StockVibeSchedule): Cadence | null {
  const match = job?.schedule.match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6](?:,[0-6])*)$/);
  if (!match || job?.timezone !== "Asia/Shanghai") return null;
  const time = `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`;
  if (!validTime(time)) return null;
  if (match[3] === "*" || match[3] === "1-5") return { time, frequency: match[3] === "*" ? "daily" : "weekdays" };
  const days = weekDays.filter((day) => match[3].split(",").map(Number).includes(day));
  return { time, frequency: days.length === 1 ? "weekly" : "custom", days };
}

const cadenceText = (value: Cadence) => `${value.frequency === "daily" ? "每天" : value.frequency === "weekdays" ? "周一至周五"
  : `每周${(value.days ?? [1]).map((day) => dayNames[day]).join("、")}`} ${value.time}`;
const cron = (value: Cadence) => {
  const [hour, minute] = value.time.split(":").map(Number);
  return `${minute} ${hour} * * ${value.frequency === "daily" ? "*" : value.frequency === "weekdays" ? "1-5" : value.days!.join(",")}`;
};

function isPendingFollowupWrite(value: unknown): value is PendingFollowupWrite {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.requestId === "string" && requestIdPattern.test(row.requestId)
    && typeof row.jobId === "string" && jobIdPattern.test(row.jobId)
    && (row.action === "create" || row.action === "cancel" || row.action === "update");
}

function readPending(key: string): StoredFollowupWrite {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return isPendingFollowupWrite(value) ? value : "invalid";
  } catch {
    return "unavailable";
  }
}

function savePending(key: string, value: PendingFollowupWrite): boolean {
  try {
    if (window.localStorage.getItem(key) !== null) return false;
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function clearPending(key: string, requestId: string): void {
  try {
    const saved = readPending(key);
    if (saved && saved !== "invalid" && saved !== "unavailable" && saved.requestId === requestId) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Keep the stored request if local storage cannot confirm its identity.
  }
}

function storageKey(symbol: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(symbol.toUpperCase())}`;
}

function expectedPath(write: PendingFollowupWrite): string {
  return write.action === "create" ? "/scheduled-runs" : `/scheduled-runs/${write.jobId}`;
}

function receiptResult(record: StockVibeRequestRecord, write: PendingFollowupWrite): ReceiptResult {
  if (record.request_id.toLowerCase() !== write.requestId.toLowerCase()
    || record.method.toUpperCase() !== (write.action === "create" ? "POST" : write.action === "update" ? "PATCH" : "DELETE")
    || record.path !== expectedPath(write)) return "unknown";

  if (record.status === "completed") {
    const code = record.receipt?.status_code;
    if (!record.receipt || !/^[a-f0-9]{64}$/i.test(record.receipt_sha256 ?? "")
      || typeof code !== "number" || !Number.isInteger(code) || code < 200 || code >= 300) return "unknown";
    if (write.action !== "cancel") {
      const body = record.receipt.body;
      if (!body || typeof body !== "object" || Array.isArray(body)
        || (body as Record<string, unknown>).id !== write.jobId) return "unknown";
    }
    return "completed";
  }

  if (record.status === "rejected") {
    const code = record.receipt?.status_code;
    const receiptRejected = !!record.receipt && /^[a-f0-9]{64}$/i.test(record.receipt_sha256 ?? "")
      && typeof code === "number" && Number.isInteger(code) && code >= 400 && code < 500;
    const notDispatched = record.error_category === "not_dispatched" && record.receipt === null && record.source === null;
    if (receiptRejected || notDispatched) return "rejected";
  }

  return "unknown";
}

function scheduleStatus(status: string): string {
  const labels: Record<string, string> = {
    pending: "已安排",
    running: "运行中",
    completed: "已结束",
    failed: "执行失败",
    cancelled: "已取消",
    expired: "已过期",
  };
  return labels[status] ?? "状态待更新";
}

function visibleSymbol(symbol: string): string {
  return symbol.replace(/\.(?:SH|SZ|BJ)$/i, "");
}

function errorMessage(error: unknown): string {
  return error instanceof StockVibeApiError ? error.message : "定时跟进服务暂时无法完成此请求。";
}

export interface StockVibeFollowupProps {
  symbol: string;
  mode: StockVibeScenarioMode;
  jobs: StockVibeSchedule[];
  scheduler: { executable?: boolean } | null;
  readState?: "ready" | "loading" | "unavailable";
  onChanged: () => void;
  onError: (message: string) => void;
}

export function StockVibeFollowup({ symbol, mode, jobs, scheduler, readState = "ready", onChanged, onError }: StockVibeFollowupProps) {
  const key = storageKey(symbol);
  const currentKeyRef = useRef(key);
  currentKeyRef.current = key;
  const pendingRef = useRef<PendingFollowupWrite | null>(null);
  const writeLocks = useRef(new Set<string>());
  const checkingRequests = useRef(new Set<string>());
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [pending, setPending] = useState<PendingFollowupWrite | null>(null);
  const [storageIssue, setStorageIssue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [task, setTask] = useState<StockVibeResearchTask>("comprehensive");
  const [editJobId, setEditJobId] = useState<string | null>(null);
  const [cadences, setCadences] = useState(() => readCadences(symbol));
  const [time, setTime] = useState("16:00");
  const [frequency, setFrequency] = useState<Cadence["frequency"]>("weekdays");
  const [days, setDays] = useState<number[]>([1]);
  const [daysError, setDaysError] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [locallyCancelledJobs, setLocallyCancelledJobs] = useState<string[]>([]);

  const markUnknown = useCallback((write: PendingFollowupWrite, currentKey: string) => {
    if (currentKeyRef.current !== currentKey) return;
    pendingRef.current = write;
    setPending(write);
    setMessage("结果尚未确认，请核对原请求；系统不会自动重发。");
  }, []);

  const acceptRecord = useCallback((record: StockVibeRequestRecord, write: PendingFollowupWrite, currentKey: string): ReceiptResult => {
    const result = receiptResult(record, write);
    if (result === "unknown") {
      markUnknown(write, currentKey);
      return result;
    }

    clearPending(currentKey, write.requestId);
    if (currentKeyRef.current === currentKey && pendingRef.current?.requestId === write.requestId) {
      pendingRef.current = null;
      setPending(null);
      if (result === "completed") {
        if (write.action === "cancel") {
          setLocallyCancelledJobs((current) => current.includes(write.jobId) ? current : [...current, write.jobId]);
          setMessage("定时跟进已取消；已开始的研究会继续。");
        } else {
          setMessage(write.action === "update" ? "跟进时间已更新。" : "已开启定时跟进。");
          setDialogOpen(false);
        }
      } else {
        setMessage("这次操作被拒绝，可以检查设置后重新尝试。");
      }
    }
    if (result === "completed") onChangedRef.current();
    else onErrorRef.current(write.action === "create" ? "定时跟进请求被拒绝，请检查服务状态后重试。" : "取消定时跟进的请求被拒绝，请稍后重试。");
    return result;
  }, [markUnknown]);

  const reconcile = useCallback(async (write: PendingFollowupWrite, currentKey: string): Promise<ReceiptResult> => {
    if (checkingRequests.current.has(write.requestId)) return "unknown";
    checkingRequests.current.add(write.requestId);
    if (currentKeyRef.current === currentKey) setChecking(true);
    try {
      const record = await getStockVibeRequest(write.requestId);
      return acceptRecord(record, write, currentKey);
    } catch {
      markUnknown(write, currentKey);
      return "unknown";
    } finally {
      checkingRequests.current.delete(write.requestId);
      if (currentKeyRef.current === currentKey) setChecking(false);
    }
  }, [acceptRecord, markUnknown]);

  useEffect(() => {
    pendingRef.current = null;
    setPending(null);
    setStorageIssue(false);
    setSaving(false);
    setChecking(false);
    setLocallyCancelledJobs([]);
    setCadences(readCadences(symbol));
    setMessage(null);
    const stored = readPending(key);
    if (stored === "invalid" || stored === "unavailable") {
      setStorageIssue(true);
      setMessage("无法读取上次操作记录，暂不能保存或取消。");
      return;
    }
    if (!stored) return;
    pendingRef.current = stored;
    setPending(stored);
    setMessage("正在核对上次操作结果…");
    void reconcile(stored, key);
  }, [key, reconcile]);

  const beginWrite = async (write: PendingFollowupWrite, currentKey: string, dispatch: () => Promise<StockVibeRequestRecord>) => {
    if (writeLocks.current.has(currentKey) || pendingRef.current || storageIssue) return;
    const stored = readPending(currentKey);
    if (stored === "invalid" || stored === "unavailable") {
      setStorageIssue(true);
      setMessage("无法读取上次操作记录，暂不能保存或取消。");
      onErrorRef.current("无法安全读取上次操作记录，因此没有提交新操作。");
      return;
    }
    if (stored) {
      pendingRef.current = stored;
      setPending(stored);
      setMessage("上次操作结果尚未核对，请先查询原请求。");
      void reconcile(stored, currentKey);
      return;
    }
    if (!savePending(currentKey, write)) {
      onErrorRef.current("无法保存本次请求的核对信息，因此没有提交操作。");
      return;
    }

    pendingRef.current = write;
    setPending(write);
    setMessage("正在保存定时跟进…");
    setSaving(true);
    writeLocks.current.add(currentKey);
    try {
      const record = await dispatch();
      let result = acceptRecord(record, write, currentKey);
      if (result === "unknown") result = await reconcile(write, currentKey);
      if (result === "unknown" && currentKeyRef.current === currentKey) {
        setDialogOpen(false);
        onErrorRef.current("本次操作结果尚未确认。系统不会重发，请先核对原请求。");
      }
      return result;
    } catch (error) {
      const result = await reconcile(write, currentKey);
      if (result === "unknown") {
        if (currentKeyRef.current === currentKey) setDialogOpen(false);
        onErrorRef.current(errorMessage(error));
      }
      return result;
    } finally {
      writeLocks.current.delete(currentKey);
      if (currentKeyRef.current === currentKey) setSaving(false);
    }
  };

  const visibleJobs = jobs.filter((job) => !locallyCancelledJobs.includes(job.id));
  const taskJobs = (value: StockVibeResearchTask) => visibleJobs.filter((job) =>
    job.config?.mona_workbench?.symbol === symbol && job.config.mona_workbench.task === value
    && !completedJobStatuses.has(job.status));
  const selectedJobs = taskJobs(task);
  const editing = selectedJobs.find((job) => job.id === editJobId);
  const writeBlocked = saving || checking || pending !== null || storageIssue;

  const rememberCadence = (value: StockVibeResearchTask, cadence: Cadence) => {
    const next = { ...cadences, [value]: cadence };
    try {
      localStorage.setItem(preferencesKey(symbol), JSON.stringify(next));
      setCadences(next);
      return true;
    } catch {
      onErrorRef.current("未能保存跟进时间，请稍后重试。");
      return false;
    }
  };

  const enableTask = async (value: StockVibeResearchTask) => {
    const cadence = cadences[value] ?? defaultCadence;
    const write: PendingFollowupWrite = { requestId: createStockVibeRequestId(), jobId: createStockVibeRequestId(), action: "create" };
    return beginWrite(write, key, () => createStockVibeSchedule(write.requestId, {
      id: write.jobId,
      title: `${visibleSymbol(symbol)} ${STOCK_RESEARCH_TASKS[value].label}跟进`,
      prompt: stockResearchPrompt(symbol, mode, value),
      schedule: cron(cadence), timezone: "Asia/Shanghai", workbench: { symbol, task: value, mode },
    }));
  };

  const disableTask = async (value: StockVibeResearchTask) => {
    for (const job of taskJobs(value)) {
      if (!jobIdPattern.test(job.id)) { onErrorRef.current("无法识别这项跟进计划，未提交关闭操作。"); return; }
      const cadence = jobCadence(job);
      if (cadence && !rememberCadence(value, cadence)) return;
      const write: PendingFollowupWrite = { requestId: createStockVibeRequestId(), jobId: job.id, action: "cancel" };
      if (await beginWrite(write, key, () => cancelStockVibeSchedule(job.id, write.requestId)) !== "completed") return;
      if (currentKeyRef.current !== key) return;
    }
  };

  const openSettings = (value: StockVibeResearchTask) => {
    const job = taskJobs(value)[0];
    const cadence = jobCadence(job) ?? cadences[value] ?? defaultCadence;
    setTask(value); setEditJobId(job?.id ?? null);
    setTime(cadence.time); setFrequency(cadence.frequency); setDays(cadence.days ?? [1]); setDaysError(false); setDialogOpen(true);
  };

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validTime(time)) { onErrorRef.current("请选择有效的北京时间。"); return; }
    if (frequency === "custom" && days.length === 0) { setDaysError(true); return; }
    const cadence: Cadence = { time, frequency, ...(["weekly", "custom"].includes(frequency) ? { days: frequency === "weekly" ? [days[0] ?? 1] : days } : {}) };
    if (!rememberCadence(task, cadence)) return;
    if (!editJobId) { setDialogOpen(false); return; }
    if (!editing) { onErrorRef.current("这项计划已发生变化，请关闭设置后重新打开。"); return; }
    const write: PendingFollowupWrite = { requestId: createStockVibeRequestId(), jobId: editing.id, action: "update" };
    await beginWrite(write, key, () => updateStockVibeSchedule(editing.id, write.requestId, { schedule: cron(cadence), timezone: "Asia/Shanghai" }));
  };

  const checkPending = () => {
    const current = pendingRef.current;
    if (current) void reconcile(current, key);
  };

  return <section className="space-y-3" aria-label="定时跟进">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-ui font-semibold">定时跟进</h3>
      {readState === "unavailable" ? <Button size="sm" variant="ghost" onClick={onChanged}>重试</Button>
        : <span className="text-caption text-muted-foreground">{readState === "loading" ? "正在读取…" : "北京时间"}</span>}
    </div>
    {readState === "unavailable" && <p className="text-caption text-muted-foreground">计划暂未取得</p>}
    <ul className="space-y-3">
      {tasks.map((value) => {
        const active = taskJobs(value), job = active[0];
        const cadence = jobCadence(job) ?? (!job ? cadences[value] ?? defaultCadence : null);
        const context = job?.config?.mona_workbench;
        return <li key={value} className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-ui font-medium">{STOCK_RESEARCH_TASKS[value].label}</p>
            <p className="truncate text-caption text-muted-foreground">
              {cadence ? cadenceText(cadence) : "自定义时间"}
              {job ? active.length > 1 ? ` · ${active.length} 项` : context ? ` · ${STOCK_RESEARCH_MODES[context.mode]}` : "" : " · 未开启"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Switch aria-label={`开启${STOCK_RESEARCH_TASKS[value].label}跟进`}
              checked={active.length > 0} disabled={writeBlocked || readState !== "ready"}
              onCheckedChange={(checked) => void (checked ? enableTask(value) : disableTask(value))} />
            <Button size="icon" variant="ghost" aria-label={`设置${STOCK_RESEARCH_TASKS[value].label}跟进`} title={`设置${STOCK_RESEARCH_TASKS[value].label}跟进`}
              disabled={writeBlocked || readState !== "ready"} onClick={() => openSettings(value)}><Settings className="h-4 w-4" aria-hidden="true" /></Button>
          </div>
        </li>;
      })}
    </ul>
    {scheduler?.executable === false && tasks.some((value) => taskJobs(value).length) &&
      <p className="text-caption text-muted-foreground">计划已保存，暂不能自动执行。</p>}
    {(message || pending) && <div className="flex flex-wrap items-center gap-x-2 text-caption">
      {message && <p className="text-muted-foreground" role="status">{message}</p>}
      {pending && <Button size="sm" variant="ghost" disabled={checking} onClick={checkPending}>{checking ? "正在核对…" : "核对结果"}</Button>}
    </div>}
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent className="scrollbar-scope stock-vibe-workbench relative max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{STOCK_RESEARCH_TASKS[task].label}跟进设置</DialogTitle>
          <DialogDescription>应用运行时按北京时间生成 {visibleSymbol(symbol)} 的研究报告。执行日期按日历安排，不会自动跳过 A 股休市日。</DialogDescription>
        </DialogHeader>
        <form id="stock-vibe-followup-form" className="space-y-4" onSubmit={(event) => void saveSettings(event)}>
          {selectedJobs.length > 1 && <Select aria-label="跟进计划" value={editJobId ?? ""}
            options={selectedJobs.map((job) => ({ value: job.id, label: `${job.title} · ${jobCadence(job) ? cadenceText(jobCadence(job)!) : "自定义时间"} · ${scheduleStatus(job.status)}` }))}
            disabled={writeBlocked} onValueChange={(id) => {
              setEditJobId(id);
              const cadence = jobCadence(selectedJobs.find((job) => job.id === id)) ?? defaultCadence;
              setTime(cadence.time); setFrequency(cadence.frequency); setDays(cadence.days ?? [1]); setDaysError(false);
            }} />}
          {editing && !jobCadence(editing) && <p className="text-caption text-muted-foreground">当前为自定义时间，保存后改为下方选择的北京时间和频率。</p>}
          <div className="space-y-1">
            <label className="text-ui font-medium" htmlFor="stock-vibe-followup-time">执行时间（北京时间）</label>
            <Input id="stock-vibe-followup-time" type="time" value={time} required disabled={writeBlocked}
              onChange={(event) => setTime(event.target.value)} />
          </div>
          <fieldset className="space-y-2" disabled={writeBlocked}>
            <legend className="text-ui font-medium">执行频率</legend>
            <div className="grid grid-cols-2 gap-2 text-caption">
              {([["daily", "每天"], ["weekdays", "周一至周五"], ["weekly", "每周"], ["custom", "自定义星期"]] as const).map(([value, label]) =>
                <label key={value} className="flex items-center gap-2"><input type="radio" name="stock-vibe-followup-frequency" checked={frequency === value}
                  onChange={() => { setFrequency(value); setDaysError(false); }} />{label}</label>)}
            </div>
          </fieldset>
          {frequency === "weekly" && <div className="space-y-1">
            <label className="text-ui font-medium">执行日</label>
            <Select aria-label="每周执行日" value={String(days[0] ?? 1)} disabled={writeBlocked}
              options={weekDays.map((day) => ({ value: String(day), label: `周${dayNames[day]}` }))}
              onValueChange={(value) => setDays([Number(value)])} />
          </div>}
          {frequency === "custom" && <fieldset className="space-y-2" disabled={writeBlocked}>
            <legend className="text-ui font-medium">执行日（可多选）</legend>
            <div className="flex flex-wrap gap-3 text-caption">
              {weekDays.map((day) => <label key={day} className="flex items-center gap-1"><input type="checkbox" checked={days.includes(day)}
                onChange={(event) => { setDays(weekDays.filter((value) => value === day ? event.target.checked : days.includes(value))); setDaysError(false); }} />周{dayNames[day]}</label>)}
            </div>
            {daysError && <p className="text-caption text-destructive" role="alert">请至少选择一天。</p>}
          </fieldset>}
          <p className="text-caption text-muted-foreground">{editing ? "保存只调整后续执行时间，保留已有研究记录。" : "保存时间后，可在列表中开启这项跟进。"}</p>
        </form>
        <DialogFooter>
          <Button variant="secondary" disabled={saving} onClick={() => setDialogOpen(false)}>关闭</Button>
          <Button type="submit" form="stock-vibe-followup-form" className="stock-vibe-followup" disabled={writeBlocked || readState !== "ready"}>{saving ? "正在保存…" : "保存设置"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
