import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, Square, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { developmentApi, type DevBackgroundCommandOutput } from "@/lib/development-api";
import { refreshDevelopmentSession } from "./useDevelopmentSession";

const OUTPUT_REFRESH_MS = 1000;

function formatElapsed(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return minutes ? `${minutes}分${String(remainder).padStart(2, "0")}秒` : `${remainder}秒`;
}

function statusLabel(status: DevBackgroundCommandOutput["status"]) {
  switch (status) {
    case "running": return "运行中";
    case "exited": return "已退出";
    case "terminated": return "已停止";
    case "timed_out": return "已超时";
  }
}

type Failure = { key: string; action: "read" | "stop"; message: string };

export function DevelopmentCommandOutput({ sessionId, commandId, visible, readonly = false, onBack }: {
  sessionId: string;
  commandId: string;
  visible: boolean;
  readonly?: boolean;
  onBack: () => void;
}) {
  const key = JSON.stringify([sessionId, commandId]);
  const keyRef = useRef(key);
  keyRef.current = key;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [record, setRecord] = useState<{ key: string; value: DevBackgroundCommandOutput } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [failureOpen, setFailureOpen] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const scroll = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const pollControl = useRef<{ key: string; pause: () => void } | null>(null);
  const stoppedKey = useRef<string | null>(null);
  const currentRecord = record?.key === key ? record.value : null;
  const currentFailure = failure?.key === key ? failure : null;

  useLayoutEffect(() => {
    followOutput.current = true;
  }, [key]);

  useEffect(() => {
    if (!visible || !sessionId || !commandId || stoppedKey.current === key) return;
    let cancelled = false;
    let paused = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const pause = () => {
      paused = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
    pollControl.current = { key, pause };

    const poll = async () => {
      if (cancelled || paused || !visibleRef.current || keyRef.current !== key) return;
      const requestController = new AbortController();
      controller = requestController;
      try {
        const value = await developmentApi.commandOutput(sessionId, commandId, requestController.signal);
        if (cancelled || paused || !visibleRef.current || requestController.signal.aborted || keyRef.current !== key) return;
        setRecord({ key, value });
        setFailure(null);
        setFailureOpen(false);
        if (value.status === "running") timer = window.setTimeout(poll, OUTPUT_REFRESH_MS);
      } catch (cause) {
        if (cancelled || paused || !visibleRef.current || requestController.signal.aborted || keyRef.current !== key) return;
        paused = true;
        const nextFailure: Failure = {
          key,
          action: "read",
          message: cause instanceof Error ? cause.message : "读取命令输出失败，请重试。",
        };
        setFailure(nextFailure);
        setFailureOpen(true);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
      if (pollControl.current?.key === key) pollControl.current = null;
    };
  }, [visible, sessionId, commandId, key, retryVersion]);

  useEffect(() => {
    setFailure(null);
    setFailureOpen(false);
    setStopping(false);
  }, [key]);

  useEffect(() => {
    if (!visible || currentRecord?.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible, key, currentRecord?.status]);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (visible && element && followOutput.current) element.scrollTop = element.scrollHeight;
  }, [visible, key, currentRecord?.output]);

  useEffect(() => {
    if (!visible) setFailureOpen(false);
  }, [visible]);

  const stop = async () => {
    if (!visible || readonly || stopping || !currentRecord || currentRecord.status !== "running") return;
    const targetKey = key;
    const targetSession = sessionId;
    const targetCommand = commandId;
    setStopping(true);
    setFailure(null);
    setFailureOpen(false);
    pollControl.current?.key === targetKey && pollControl.current.pause();
    try {
      const value = await developmentApi.stopCommand(targetSession, targetCommand);
      if (keyRef.current !== targetKey) return;
      stoppedKey.current = targetKey;
      setRecord({ key: targetKey, value });
      refreshDevelopmentSession(targetSession);
    } catch (cause) {
      if (keyRef.current !== targetKey) return;
      const nextFailure: Failure = {
        key: targetKey,
        action: "stop",
        message: cause instanceof Error ? cause.message : "停止命令失败，请重试。",
      };
      setFailure(nextFailure);
      setFailureOpen(true);
    } finally {
      if (keyRef.current === targetKey) setStopping(false);
    }
  };

  const retryRead = () => {
    setFailure(null);
    setFailureOpen(false);
    stoppedKey.current = null;
    setRetryVersion((version) => version + 1);
  };

  const elapsed = currentRecord
    ? currentRecord.status === "running"
      ? Math.max(currentRecord.elapsedSeconds, Math.floor((now - Date.parse(currentRecord.startedAt)) / 1000) || 0)
      : currentRecord.elapsedSeconds
    : 0;

  return <section className="flex h-full min-h-0 flex-col" aria-label="后台命令详情">
    <header className="flex min-w-0 items-start justify-between gap-3 border-b border-border/70 px-3 py-3">
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-2 text-ui font-medium">
          <SquareTerminal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>终端命令</span>
        </div>
        <code className="block max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-mono text-caption text-foreground">
          {currentRecord?.command ?? (currentFailure ? "命令信息暂不可用。" : "正在读取命令…")}
        </code>
        {currentRecord && <p className="text-caption text-muted-foreground">
          {statusLabel(currentRecord.status)}{currentRecord.status === "running" ? ` · 运行 ${formatElapsed(elapsed)}` : ` · 用时 ${formatElapsed(elapsed)}`}
          {currentRecord.exitCode !== null && ` · 退出码 ${currentRecord.exitCode}`}
        </p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!readonly && currentRecord?.status === "running" && <Button variant="dangerSoft" size="sm" disabled={stopping} onClick={() => void stop()}>
          {stopping ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Square className="h-3.5 w-3.5" aria-hidden="true" />}
          {stopping ? "正在停止" : "停止"}
        </Button>}
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          返回执行记录
        </Button>
      </div>
    </header>

    <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-caption font-medium">近期输出</h3>
        {currentRecord?.truncated && <span className="text-caption text-muted-foreground">仅显示最近 50,000 个字符，较早内容已省略。</span>}
      </div>
      {visible && currentFailure && !failureOpen && <div className="mb-2 flex items-center justify-between gap-2 text-caption text-muted-foreground" role="status">
        <span>自动刷新已暂停，可读取最新状态。</span>
        <Button variant="outline" size="sm" onClick={retryRead}>{currentFailure.action === "stop" ? "读取最新状态" : "重试读取"}</Button>
      </div>}
      <div
        ref={scroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/40 p-3"
        aria-label="命令近期输出"
        tabIndex={0}
      >
        {currentRecord?.output
          ? <pre className="whitespace-pre-wrap break-words font-mono text-caption leading-relaxed">{currentRecord.output}</pre>
          : currentRecord
            ? <p className="text-caption text-muted-foreground">命令尚未输出内容。</p>
          : currentFailure
            ? <p className="text-caption text-muted-foreground">近期输出暂不可用。</p>
            : visible && <p role="status" className="flex items-center gap-2 text-caption text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在读取近期输出…
              </p>}
      </div>
    </div>

    <Dialog open={failureOpen && visible && !!currentFailure} onOpenChange={(open) => {
      setFailureOpen(open);
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{currentFailure?.action === "stop" ? "停止命令失败" : "读取命令输出失败"}</DialogTitle>
          <DialogDescription>{currentFailure?.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setFailureOpen(false)}>关闭</Button>
          <Button onClick={retryRead}>{currentFailure?.action === "stop" ? "读取最新状态" : "重试读取"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}

