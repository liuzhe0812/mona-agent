import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronRight, Pencil, SquareTerminal, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";

import { FileReferenceChip } from "@/components/FileReferenceChip";
import { MessageMedia, ReasoningBubble, StreamingLabelSheen, TraceGroup } from "@/components/MessageBubble";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isCommandTrace } from "@/lib/tool-traces";
import type { UIFileEdit, UIMessage } from "@/lib/types";

export function isReasoningOnlyAssistant(m: UIMessage): boolean {
  if (m.role !== "assistant" || m.kind === "trace" || m.kind === "widget") return false;
  if (m.content.trim().length > 0) return false;
  if (m.deliveredFiles?.length) return false;
  return !!(m.reasoning?.length || m.reasoningStreaming || m.isStreaming);
}

export function isAgentActivityMember(m: UIMessage): boolean {
  return isReasoningOnlyAssistant(m) || m.kind === "trace";
}

interface ActivityCounts {
  reasoningSteps: number;
  toolCalls: number;
  fileCount: number;
  added: number;
  deleted: number;
  hasDiffStats: boolean;
  hasEditingFiles: boolean;
  hasFailedFiles: boolean;
  primaryFilePath?: string;
  primaryFileTooltipPath?: string;
}

interface FileEditSummary {
  key: string;
  path: string;
  absolute_path?: string;
  added: number;
  deleted: number;
  approximate: boolean;
  binary: boolean;
  status: UIFileEdit["status"];
  pending: boolean;
  error?: string;
}

function countActivity(messages: UIMessage[], fileEdits: FileEditSummary[]): ActivityCounts {
  let reasoningSteps = 0;
  let toolCalls = 0;
  for (const m of messages) {
    if (isReasoningOnlyAssistant(m)) {
      reasoningSteps += 1;
      continue;
    }
    if (m.kind === "trace") {
      const lines = m.traces?.length ?? (m.content.trim() ? 1 : 0);
      toolCalls += lines;
    }
  }
  let added = 0;
  let deleted = 0;
  let hasDiffStats = false;
  let hasEditingFiles = false;
  let failedFileCount = 0;
  let primaryFilePath: string | undefined;
  let primaryFileTooltipPath: string | undefined;
  for (const edit of fileEdits) {
    primaryFilePath = edit.path;
    primaryFileTooltipPath = edit.absolute_path || edit.path;
    if (edit.status === "editing") {
      hasEditingFiles = true;
    }
    if (edit.status === "error") {
      failedFileCount += 1;
    }
    if (edit.status === "error" || edit.binary) {
      continue;
    }
    if (!hasVisibleDiffStats(edit)) {
      continue;
    }
    hasDiffStats = true;
    added += edit.added;
    deleted += edit.deleted;
  }
  return {
    reasoningSteps,
    toolCalls,
    fileCount: fileEdits.length,
    added,
    deleted,
    hasDiffStats,
    hasEditingFiles,
    hasFailedFiles: fileEdits.length > 0 && failedFileCount === fileEdits.length,
    primaryFilePath,
    primaryFileTooltipPath,
  };
}

interface ActivityTimingHeaderProps {
  isTurnStreaming: boolean;
  runStartedAt?: number | null;
  latencyMs?: number;
  startedAt: number;
  expanded?: boolean;
  onToggle?: () => void;
}

export function ActivityTimingHeader({ isTurnStreaming, runStartedAt, latencyMs, startedAt, expanded, onToggle }: ActivityTimingHeaderProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!isTurnStreaming) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isTurnStreaming, runStartedAt]);
  const elapsedSeconds = Math.max(0, Math.floor((now - (runStartedAt != null ? runStartedAt * 1000 : startedAt)) / 1000));
  const seconds = isTurnStreaming ? elapsedSeconds : Math.max(0, Math.floor((latencyMs ?? 0) / 1000));
  const label = isTurnStreaming
    ? seconds < 60
      ? t("message.agentActivityElapsed", { seconds })
      : t("message.agentActivityElapsedMinutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
    : latencyMs != null
      ? t("message.agentActivityDuration", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
      : t("message.agentActivityFinished");
  return <div data-testid="activity-timing" className="mb-2.5 border-b border-border/60 pb-1 text-caption text-muted-foreground">
    {onToggle ? <Button type="button" variant="ghost" size="sm" onClick={onToggle} aria-expanded={expanded}
      aria-label={t(expanded ? "message.collapseProcess" : "message.expandProcess")}
      className="relative h-auto justify-start gap-1.5 p-0 font-normal text-muted-foreground before:absolute before:inset-x-0 before:-inset-y-2 hover:bg-transparent hover:text-foreground">
      <span>{label}</span>
      <ChevronRight aria-hidden className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-200", expanded && "rotate-90")} />
    </Button> : <span>{label}</span>}
  </div>;
}

interface AgentActivityClusterProps {
  messages: UIMessage[];
  isTurnStreaming: boolean;
  hasBodyBelow: boolean;
  runStartedAt?: number | null;
  latencyMs?: number;
  showTiming?: boolean;
}

export function AgentActivityCluster({ messages, isTurnStreaming, hasBodyBelow, runStartedAt, latencyMs, showTiming = true }: AgentActivityClusterProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const activityGroups = useMemo(() => {
    const groups: UIMessage[][] = [];
    for (const message of messages) {
      const previous = groups[groups.length - 1];
      if (message.kind === "trace" && previous?.[0].kind === "trace"
        && !message.media?.length && !previous[0].media?.length) previous.push(message);
      else groups.push([message]);
    }
    return groups;
  }, [messages]);
  const fileEdits = useMemo(() => summarizeFileEdits(collectFileEdits(messages), isTurnStreaming), [messages, isTurnStreaming]);
  const { reasoningSteps, toolCalls, fileCount, added, deleted, hasDiffStats, hasEditingFiles, hasFailedFiles, primaryFilePath } = countActivity(messages, fileEdits);
  const hasLiveEditingFiles = isTurnStreaming && hasEditingFiles;
  const hasPendingFileEdit = fileEdits.some((edit) => edit.pending);
  const hasCommands = messages.some((message) => message.kind === "trace" && (message.traces ?? [message.content]).some(isCommandTrace));
  const fileSummary = hasPendingFileEdit && !primaryFilePath
    ? t("message.fileActivityPreparing")
    : fileCount === 1 && primaryFilePath
      ? t(fileActivitySummaryKey(hasLiveEditingFiles, hasFailedFiles), { file: shortFileName(primaryFilePath) })
      : t(fileActivityManySummaryKey(hasLiveEditingFiles, hasFailedFiles), { count: fileCount });
  const summary = fileCount > 0 && hasCommands
    ? t("message.activityFilesAndCommands")
    : fileCount > 0 ? fileSummary : t(hasCommands ? "message.activityCommands" : "message.activityDetails");
  const previews = messages.filter((message) => message.kind === "trace" && message.media?.length);
  if (reasoningSteps === 0 && toolCalls === 0 && fileCount === 0 && previews.length === 0) return null;
  const Icon = fileCount > 0 ? Pencil : hasCommands ? SquareTerminal : Wrench;
  return <div className={cn("w-full", hasBodyBelow && "mb-1")}>
    {showTiming && <ActivityTimingHeader isTurnStreaming={isTurnStreaming} runStartedAt={runStartedAt}
      startedAt={messages[0]?.createdAt ?? Date.now()}
      latencyMs={latencyMs ?? messages.find((message) => message.latencyMs != null)?.latencyMs} />}
    <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-label={summary}
      className="flex max-w-full items-center gap-2 py-1.5 text-caption text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <StreamingLabelSheen active={isTurnStreaming} className="min-w-0 text-left">{summary}</StreamingLabelSheen>
      {fileCount > 0 && hasDiffStats && <DiffPair added={added} deleted={deleted} />}
      <ChevronRight aria-hidden className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-200", expanded && "rotate-90")} />
    </button>
    {!expanded && previews.map((message) => (
      <MessageMedia key={message.id} media={message.media!} align="left" />
    ))}
    {expanded && <div data-testid="agent-activity-details" className="mt-2 flex flex-col gap-2">
      {activityGroups.map((group) => {
        const message = group[0];
        if (message.media?.length) return <MessageMedia key={message.id} media={message.media} align="left" />;
        if (isReasoningOnlyAssistant(message)) return <ReasoningBubble key={message.id} text={message.reasoning ?? ""}
          streaming={isTurnStreaming && !!message.reasoningStreaming} hasBodyBelow={false} embeddedInCluster />;
        if (message.kind === "trace") {
          return <TraceGroup key={message.id} message={group} animClass="" inline />;
        }
        return null;
      })}
      {fileEdits.length > 0 && <FileEditGroup edits={fileEdits} />}
    </div>}
  </div>;
}

function shortFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function fileActivitySummaryKey(editing: boolean, failed: boolean): string {
  if (failed) return "message.fileActivityFailedOne";
  return editing ? "message.fileActivityEditingOne" : "message.fileActivityEditedOne";
}

function fileActivityManySummaryKey(editing: boolean, failed: boolean): string {
  if (failed) return "message.fileActivityFailedMany";
  return editing ? "message.fileActivityEditingMany" : "message.fileActivityEditedMany";
}

function fileEditCallKey(edit: UIFileEdit): string {
  if (edit.call_id) return `${edit.call_id}|${edit.tool}`;
  return `${edit.tool}|${edit.path}`;
}

function collectFileEdits(messages: UIMessage[]): UIFileEdit[] {
  const edits: UIFileEdit[] = [];
  for (const message of messages) {
    if (message.kind === "trace" && message.fileEdits?.length) {
      edits.push(...message.fileEdits);
    }
  }
  return edits;
}

function latestFileEditEvents(edits: UIFileEdit[]): UIFileEdit[] {
  const order: string[] = [];
  const byKey = new Map<string, UIFileEdit>();
  for (const edit of edits) {
    const key = fileEditCallKey(edit);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, edit);
  }
  return order.map((key) => byKey.get(key)).filter(Boolean) as UIFileEdit[];
}

function summarizeFileEdits(edits: UIFileEdit[], active: boolean): FileEditSummary[] {
  interface MutableSummary {
    key: string;
    path: string;
    absolute_path?: string;
    added: number;
    deleted: number;
    approximate: boolean;
    binary: boolean;
    pending: boolean;
    hasSuccessfulChange: boolean;
    hasActiveEditing: boolean;
    hasFailed: boolean;
    error?: string;
  }

  const order: string[] = [];
  const byPath = new Map<string, MutableSummary>();
  for (const edit of latestFileEditEvents(edits)) {
    const key = edit.path || edit.call_id || edit.tool;
    let summary = byPath.get(key);
    if (!summary) {
      summary = {
        key,
        path: edit.path || "",
        absolute_path: edit.absolute_path,
        added: 0,
        deleted: 0,
        approximate: false,
        binary: false,
        pending: false,
        hasSuccessfulChange: false,
        hasActiveEditing: false,
        hasFailed: false,
      };
      byPath.set(key, summary);
      order.push(key);
    }

    if (edit.path && !summary.path) {
      summary.path = edit.path;
    }
    if (edit.absolute_path) {
      summary.absolute_path = edit.absolute_path;
    }
    summary.pending = summary.pending || !!edit.pending || !edit.path;
    if (!edit.path && edit.pending) {
      if (active && edit.status === "editing") {
        summary.hasActiveEditing = true;
        summary.approximate = summary.approximate || !!edit.approximate;
        if (!edit.binary) {
          summary.added += edit.added;
          summary.deleted += edit.deleted;
        }
      }
      continue;
    }
    if (active && edit.status === "editing") {
      summary.hasActiveEditing = true;
      summary.binary = summary.binary || !!edit.binary;
      summary.approximate = summary.approximate || !!edit.approximate;
      if (!edit.binary) {
        summary.added += edit.added;
        summary.deleted += edit.deleted;
      }
      continue;
    }

    if (edit.status === "error") {
      summary.hasFailed = true;
      summary.error = edit.error ?? summary.error;
      continue;
    }

    summary.hasSuccessfulChange = true;
    summary.binary = summary.binary || !!edit.binary;
    summary.approximate = active && (summary.approximate || !!edit.approximate);
    if (!edit.binary) {
      summary.added += edit.added;
      summary.deleted += edit.deleted;
    }
  }

  return order.flatMap((key) => {
    const summary = byPath.get(key)!;
    if (
      !summary.path
      && !summary.hasActiveEditing
      && !summary.hasSuccessfulChange
      && !summary.hasFailed
    ) {
      return [];
    }
    const status: UIFileEdit["status"] = summary.hasActiveEditing
      ? "editing"
      : summary.hasSuccessfulChange
        ? "done"
        : summary.hasFailed
          ? "error"
          : "done";
    return [{
      key: summary.key,
      path: summary.path,
      absolute_path: summary.absolute_path,
      added: summary.added,
      deleted: summary.deleted,
      approximate: summary.approximate,
      binary: summary.binary,
      status,
      pending: summary.pending && !summary.path,
      error: summary.error,
    }];
  });
}

function hasVisibleDiffStats(edit: Pick<FileEditSummary, "added" | "deleted">): boolean {
  return edit.added > 0 || edit.deleted > 0;
}

function FileEditGroup({ edits }: { edits: FileEditSummary[] }) {
  if (edits.length === 0) return null;
  return (
    <ul className="space-y-2">
      {edits.map((edit) => (
        <FileEditRow key={edit.key} edit={edit} />
      ))}
    </ul>
  );
}

function FileEditRow({ edit }: { edit: FileEditSummary }) {
  const { t } = useTranslation();
  const editing = edit.status === "editing";
  const failed = edit.status === "error";
  const hasCountedDiff = !failed && !edit.binary && hasVisibleDiffStats(edit);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1.5 text-caption text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <Pencil className="h-4 w-4 shrink-0" aria-hidden />
        {edit.path && !failed && <span className="shrink-0">{t(editing ? "message.activityFileEditing" : "message.activityFileEdited")}</span>}
        {edit.pending && !edit.path ? (
          <StreamingLabelSheen
            active={editing}
            className="min-w-0 text-[12px] font-medium text-muted-foreground"
          >
            {t("message.fileEditPreparing", { defaultValue: "Preparing file edit…" })}
          </StreamingLabelSheen>
        ) : (
          <FileReferenceChip
            path={edit.path}
            tooltipPath={edit.absolute_path}
            absolutePath={edit.absolute_path}
            variant="inline"
            active={editing}
            className="min-w-0"
            textClassName="text-caption"
            testId="activity-file-reference"
          />
        )}
        {failed ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-destructive/75">
            <AlertCircle className="h-3 w-3" aria-hidden />
            {t("message.fileEditFailed", { defaultValue: "Failed" })}
          </span>
        ) : null}
        {edit.approximate && !failed ? (
          <span className="shrink-0 text-[10.5px] font-medium text-muted-foreground/55">
            {t("message.fileEditApproximate", { defaultValue: "estimated" })}
          </span>
        ) : null}
      </div>
      {hasCountedDiff ? (
        <DiffPair added={edit.added} deleted={edit.deleted} />
      ) : null}
    </li>
  );
}

function DiffPair({ added, deleted }: { added: number; deleted: number }) {
  return (
    <span className="inline-flex shrink-0 translate-y-[0.055em] items-center gap-1.5 tabular-nums">
      <DiffValue
        sign="+"
        value={added}
        className="text-emerald-600/75 dark:text-emerald-300/75"
      />
      <DiffValue
        sign="-"
        value={deleted}
        className="text-rose-600/70 dark:text-rose-300/75"
      />
    </span>
  );
}

function DiffValue({ sign, value, className }: { sign: string; value: number; className: string }) {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return (
    <span className={cn("inline-flex", className)} aria-label={`${sign}${safeValue}`}>
      <span className="inline-flex" aria-hidden>
        {sign}
        <AnimatedNumber value={safeValue} />
      </span>
      <span className="sr-only">{sign}{safeValue}</span>
    </span>
  );
}

function AnimatedNumber({ value }: { value: number }) {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const [display, setDisplay] = useState(0);
  const displayRef = useRef(0);

  const setAnimatedDisplay = useCallback((next: number) => {
    displayRef.current = next;
    setDisplay(next);
  }, []);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setAnimatedDisplay(safeValue);
      return;
    }
    const start = displayRef.current;
    const delta = safeValue - start;
    if (delta === 0) {
      setAnimatedDisplay(safeValue);
      return;
    }
    const duration = 260;
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setAnimatedDisplay(Math.round(start + delta * eased));
      if (progress < 1) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      displayRef.current = safeValue;
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [safeValue, setAnimatedDisplay]);

  return <RollingNumber value={display} />;
}

function RollingNumber({ value }: { value: number }) {
  const digits = String(value).split("");
  return (
    <span className="inline-flex h-[1em] overflow-hidden align-[-0.13em]" aria-hidden>
      {digits.map((digit, index) => (
        <RollingDigit
          key={`${digits.length}-${index}`}
          digit={Number(digit)}
        />
      ))}
    </span>
  );
}

function RollingDigit({ digit }: { digit: number }) {
  const safeDigit = Number.isFinite(digit) ? Math.min(9, Math.max(0, digit)) : 0;
  return (
    <span className="relative inline-block h-[1em] w-[0.62em] overflow-hidden">
      <span
        className="flex flex-col transition-transform duration-200 ease-out will-change-transform"
        style={{ transform: `translateY(-${safeDigit}em)` }}
      >
        {Array.from({ length: 10 }, (_, n) => (
          <span key={n} className="block h-[1em] leading-none">
            {n}
          </span>
        ))}
      </span>
    </span>
  );
}
