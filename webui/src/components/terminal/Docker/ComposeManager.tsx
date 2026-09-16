import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileCode2, Loader2, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageToolbar } from "@/components/ui/page-toolbar";
import { StatusNotice } from "@/components/ui/status-notice";
import { Textarea } from "@/components/ui/textarea";

import {
  dockerComposeAction,
  dockerCancelActiveOperation,
  dockerReadComposeFile,
  dockerSaveComposeFile,
  dockerSubscribeComposeEvents,
  dockerUnsubscribeStream,
  dockerValidateComposeFile,
  onDockerComposeEvent,
  onDockerComposeEventEnded,
} from "./docker-ipc";
import type {
  ComposeAction,
  ComposeActionResult,
  ComposeFileContent,
  ComposeProject,
  ComposeValidation,
} from "./types";

export interface ComposeManagerProps {
  parentSessionId: string;
  project: ComposeProject;
  connected: boolean;
  visible: boolean;
  onChanged?: () => void;
}

type BusyAction = "read" | "validate" | "save" | ComposeAction | null;

const COMPOSE_ACTIONS: ComposeAction[] = ["pull", "up", "stop", "restart", "recreate", "down"];

const ACTION_LABELS: Record<ComposeAction, string> = {
  pull: "拉取镜像",
  up: "启动",
  stop: "停止",
  restart: "重启",
  recreate: "重建",
  down: "Down",
};

const MAX_EVENT_BYTES = 2 * 1024 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendBounded(current: string, chunk: string): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(current + chunk);
  if (bytes.byteLength <= MAX_EVENT_BYTES) return { text: current + chunk, truncated: false };
  return {
    text: new TextDecoder().decode(bytes.slice(-MAX_EVENT_BYTES)),
    truncated: true,
  };
}

export function ComposeManager({ parentSessionId, project, connected, visible, onChanged }: ComposeManagerProps) {
  const manageable = project.manageable && Boolean(project.configFile);
  const [file, setFile] = useState<ComposeFileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [validation, setValidation] = useState<ComposeValidation | null>(null);
  const [operation, setOperation] = useState<ComposeActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [eventsEnabled, setEventsEnabled] = useState(false);
  const [eventText, setEventText] = useState("");
  const [eventTruncated, setEventTruncated] = useState(false);
  const [eventSubscriptionId, setEventSubscriptionId] = useState<string | null>(null);
  const eventTextRef = useRef("");
  const subscriptionRef = useRef<string | null>(null);

  const stopEventSubscription = useCallback(() => {
    const current = subscriptionRef.current;
    subscriptionRef.current = null;
    setEventSubscriptionId(null);
    if (current) void dockerUnsubscribeStream(current).catch(() => {});
  }, []);

  const loadFile = useCallback(async () => {
    if (!connected || !manageable || !project.configFile) return null;
    setBusy("read");
    setError(null);
    try {
      const next = await dockerReadComposeFile(parentSessionId, project.configFile);
      setFile(next);
      setDraft(next.content);
      setValidation(null);
      setOperation(null);
      return next;
    } catch (reason) {
      setError(`Compose 文件读取失败：${errorMessage(reason)}`);
      return null;
    } finally {
      setBusy(null);
    }
  }, [connected, manageable, parentSessionId, project.configFile]);

  useEffect(() => {
    if (!visible) return;
    if (!manageable) {
      setFile(null);
      setDraft("");
      setValidation(null);
      return;
    }
    void loadFile();
  }, [loadFile, manageable, visible]);

  useEffect(() => {
    let active = true;
    const eventListener = onDockerComposeEvent((event) => {
      if (!active || event.subscriptionId !== subscriptionRef.current) return;
      const prefix = event.stream === "stderr" ? "[stderr]\n" : "";
      const next = appendBounded(eventTextRef.current, `${prefix}${event.data}`);
      eventTextRef.current = next.text;
      setEventText(next.text);
      if (next.truncated) setEventTruncated(true);
    });
    const endedListener = onDockerComposeEventEnded((event) => {
      if (!active || event.subscriptionId !== subscriptionRef.current) return;
      subscriptionRef.current = null;
      setEventSubscriptionId(null);
    });
    return () => {
      active = false;
      stopEventSubscription();
      void eventListener.then((unlisten) => unlisten()).catch(() => {});
      void endedListener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [stopEventSubscription]);

  useEffect(() => {
    if (!visible || !eventsEnabled || !connected || !manageable || !file || !project.configFile) {
      stopEventSubscription();
      return;
    }
    let active = true;
    eventTextRef.current = "";
    setEventText("");
    setEventTruncated(false);
    void dockerSubscribeComposeEvents(parentSessionId, file.resolvedPath, project.name)
      .then((id) => {
        if (!active) {
          void dockerUnsubscribeStream(id).catch(() => {});
          return;
        }
        subscriptionRef.current = id;
        setEventSubscriptionId(id);
      })
      .catch((reason) => {
        if (active) setError(`Compose 事件订阅失败：${errorMessage(reason)}`);
      });
    return () => {
      active = false;
      stopEventSubscription();
    };
  }, [connected, eventsEnabled, file, manageable, parentSessionId, project.configFile, project.name, stopEventSubscription, visible]);

  const dirty = file != null && draft !== file.content;
  const unsupportedFeatures = file?.unsupportedFeatures ?? [];
  const readOnly = unsupportedFeatures.length > 0;

  const handleValidate = useCallback(async () => {
    if (!connected || !manageable || !file || readOnly) return;
    setBusy("validate");
    setError(null);
    setMessage(null);
    try {
      setValidation(await dockerValidateComposeFile(parentSessionId, file.resolvedPath, draft));
    } catch (reason) {
      setError(`Compose 配置校验失败：${errorMessage(reason)}`);
    } finally {
      setBusy(null);
    }
  }, [connected, draft, file, manageable, parentSessionId, readOnly]);

  const handleSave = useCallback(async () => {
    if (!connected || !manageable || !file || !dirty || readOnly) return;
    setBusy("save");
    setError(null);
    setMessage(null);
    try {
      const saved = await dockerSaveComposeFile(
        parentSessionId,
        file.resolvedPath,
        file.sha256,
        file.inputFingerprint,
        draft,
      );
      setFile(saved);
      setDraft(saved.content);
      setValidation(null);
      setMessage("Compose 文件已保存。");
      onChanged?.();
    } catch (reason) {
      setError(`Compose 文件保存失败：${errorMessage(reason)}`);
    } finally {
      setBusy(null);
    }
  }, [connected, dirty, draft, file, manageable, onChanged, parentSessionId, readOnly]);

  const handleComposeAction = useCallback(async (action: ComposeAction) => {
    if (!connected || !manageable || !file || dirty || readOnly) return;
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      const result = await dockerComposeAction(
        parentSessionId,
        file.resolvedPath,
        file.sha256,
        file.inputFingerprint,
        project.name,
        action,
      );
      const refreshed = await loadFile();
      setOperation(result);
      if (refreshed) setMessage(result.verification);
    } catch (reason) {
      setError(`Compose 操作失败：${errorMessage(reason)}`);
    } finally {
      onChanged?.();
      setBusy(null);
    }
  }, [connected, dirty, file, loadFile, manageable, onChanged, parentSessionId, project.name, readOnly]);

  const handleCancelOperation = useCallback(async () => {
    try {
      const cancelled = await dockerCancelActiveOperation(parentSessionId);
      setMessage(
        cancelled ? "正在取消；完成后将刷新实际状态。" : "操作尚在等待确认，请在确认窗口中拒绝。",
      );
    } catch (reason) {
      setError(`取消 Compose 操作失败：${errorMessage(reason)}`);
    }
  }, [parentSessionId]);

  const operationBusy = busy !== null && COMPOSE_ACTIONS.includes(busy as ComposeAction);

  if (!manageable) {
    return (
      <StatusNotice tone="info" title={`${project.name} 仅支持查看`}>
        {project.limitation || "当前项目没有可管理的单一 Compose 文件。"}
      </StatusNotice>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-border/70 bg-card">
      <PageToolbar
        className="shrink-0 border-b border-border/70 px-3"
        leading={
          <div className="flex min-w-0 items-center gap-2">
            <FileCode2 className="h-4 w-4 shrink-0 text-info" />
            <span className="truncate font-medium" title={project.configFile ?? undefined}>{project.name}</span>
            {file ? <span className="hidden truncate font-mono text-micro text-muted-foreground sm:inline" title={file.resolvedPath}>{file.resolvedPath}</span> : null}
          </div>
        }
        actions={
          <Button type="button" variant="ghost" size="sm" disabled={!connected || busy !== null} onClick={() => void loadFile()} aria-label="重新读取 Compose 文件">
            {busy === "read" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            读取
          </Button>
        }
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
        {!connected ? <StatusNotice tone="warning" className="mb-3">SSH 会话已断开；当前内容仅供查看。</StatusNotice> : null}
        {error ? <StatusNotice tone="danger" title="Compose 操作失败" className="mb-3">{error}</StatusNotice> : null}
        {message ? <StatusNotice tone="success" title="Compose 操作完成" className="mb-3">{message}</StatusNotice> : null}
        {!file && busy === "read" ? (
          <div className="flex min-h-[260px] items-center justify-center text-caption text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />读取 Compose 文件…</div>
        ) : !file ? (
          <EmptyState className="min-h-[260px]" title="暂无 Compose 文件" description="请检查项目配置文件路径和 SSH 权限。" />
        ) : (
          <div className="flex min-h-full flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground">
              <span>SHA-256 <span className="font-mono text-foreground/80">{file.sha256.slice(0, 16)}…</span></span>
              <span>{file.size} 字节</span>
              <span>{file.permissions == null ? "权限未知" : `权限 ${file.permissions.toString(8)}`}</span>
              {file.ownerUid != null ? <span>UID {file.ownerUid}</span> : null}
              {dirty ? <span className="text-warning">有未保存修改</span> : null}
            </div>
            {readOnly ? (
              <StatusNotice tone="warning" title="当前项目仅支持查看">
                包含暂不支持安全编辑或部署的配置：{unsupportedFeatures.join(", ")}。请在原终端中管理该项目。
              </StatusNotice>
            ) : null}
            <Textarea
              aria-label="Compose YAML"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={!connected || busy !== null || readOnly}
              spellCheck={false}
              className="scrollbar-thin min-h-[300px] flex-1 resize-y font-mono text-micro leading-5"
            />
            {dirty ? <p className="text-micro text-warning">保存文件后才能执行 Compose 操作；后端会在保存时再次校验文件版本。</p> : null}
            <div className="flex flex-wrap items-center gap-1.5">
              <Button type="button" size="xs" variant="outline" disabled={!connected || busy !== null || readOnly} onClick={() => void handleValidate()}>
                {busy === "validate" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}校验
              </Button>
              <Button type="button" size="xs" disabled={!connected || busy !== null || !dirty || readOnly} onClick={() => void handleSave()}>
                {busy === "save" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}保存
              </Button>
              {validation ? (
                <Badge variant={validation.valid ? "outline" : "destructive"} className="gap-1 text-micro">
                  {validation.valid ? <CheckCircle2 className="h-3 w-3 text-success" /> : <AlertTriangle className="h-3 w-3" />}
                  {validation.valid ? "校验通过" : "校验失败"}
                </Badge>
              ) : null}
            </div>
            {validation ? <ValidationSummary validation={validation} /> : null}
            <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-3">
              {COMPOSE_ACTIONS.map((action) => (
                <Button
                  key={action}
                  type="button"
                  size="xs"
                  variant={action === "down" ? "ghost" : "outline"}
                  className={action === "down" ? "text-destructive hover:text-destructive" : ""}
                  disabled={!connected || busy !== null || dirty || readOnly}
                  onClick={() => void handleComposeAction(action)}
                  aria-label={`Compose ${ACTION_LABELS[action]}`}
                >
                  {busy === action ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                  {ACTION_LABELS[action]}
                </Button>
              ))}
              {operationBusy ? (
                <Button type="button" size="xs" variant="ghost" onClick={() => void handleCancelOperation()}>
                  取消操作
                </Button>
              ) : null}
            </div>
            {operation ? (
              <div className="rounded-md border border-border/70 bg-muted/20 p-2">
                <div className="mb-1 text-micro font-semibold text-muted-foreground">最近一次操作输出</div>
                <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-micro leading-4 text-foreground/80">{operation.output || operation.verification}</pre>
                {operation.outputTruncated ? <p className="mt-1 text-micro text-warning">输出已裁剪。</p> : null}
              </div>
            ) : null}
            <div className="border-t border-border/70 pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-micro font-semibold text-muted-foreground">Compose 事件</div>
                  <div className="text-micro text-muted-foreground">{eventSubscriptionId ? "监听中" : "未监听"} · 最多保留 2 MiB</div>
                </div>
                <Button type="button" size="xs" variant={eventsEnabled ? "secondary" : "ghost"} disabled={!connected || !file} onClick={() => setEventsEnabled((value) => !value)}>
                  {eventsEnabled ? "停止监听" : "监听事件"}
                </Button>
              </div>
              {eventsEnabled ? <pre className="scrollbar-thin mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/20 p-2 font-mono text-micro leading-4 text-foreground/80" data-testid="compose-events">{eventText || "等待事件输出…"}</pre> : null}
              {eventsEnabled && eventTruncated ? <p className="mt-1 text-micro text-warning">事件输出已裁剪，仅保留最近 2 MiB。</p> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ValidationSummary({ validation }: { validation: ComposeValidation }) {
  return (
    <div className="rounded-md border border-border/70 bg-muted/20 p-2 text-micro">
      {validation.error ? <p className="text-destructive">{validation.error}</p> : null}
      {validation.services.length ? <p className="mt-1 text-muted-foreground">服务：{validation.services.join(", ")}</p> : null}
      {validation.images.length ? <p className="mt-1 text-muted-foreground">镜像：{validation.images.join(", ")}</p> : null}
    </div>
  );
}
