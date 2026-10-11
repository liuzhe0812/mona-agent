import type { ReactNode } from "react";
import type { CodePreviewSettings } from "../markdown/lib/codePreviewSettings";
import type { Theme } from "../markdown/lib/theme";
import type { CodeViewerSource } from "./codeViewer";
import { FileDisplayIcon, getFileDisplayPath, resolveFileDisplayDescriptor } from "./fileDisplay";
import type { MessageFileLinkTarget } from "./hostTypes";
import { getPathLeaf } from "./path";
import { inferEditOperation } from "./fileSummaryHeuristics";
import type {
  EditKindLabelId,
  EditKindSource,
  EditOperationKind,
  RawToolCallFileSummary,
} from "./fileSummaryTypes";
export type { EditKindSource } from "./fileSummaryTypes";
import type { ToolDisplayModel } from "./toolDisplay";
import { FlipMetricValue } from "./ui/FlipMetricValue";

export interface ToolSnapshotFieldRef {
  previewBytes: number;
  fullBytes: number;
}

export interface TaskChatToolCall {
  toolId: string;
  toolName?: string;
  kind: string;
  title?: string;
  input: unknown;
  output?: unknown;
  raw?: unknown;
  status: string;
  startedAt?: number;
  snapshotRefs?: ToolSnapshotFieldRef[];
  error?: string;
}

export interface TaskChatToolCallTreeNode {
  toolCall: TaskChatToolCall;
  childToolCalls: TaskChatToolCallTreeNode[];
}

export interface ToolCallBlockRenderContext {
  toolCallNode: TaskChatToolCallTreeNode;
  workspacePath: string;
  isRunning: boolean;
  runActive?: boolean;
  statusLabel: string;
  errorText?: string;
  isOfficeMode?: boolean;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  displayModel: ToolDisplayModel;
  viewerSource: CodeViewerSource | null;
  rawFileSummaries: RawToolCallFileSummary[];
  childToolList: ReactNode;
  showIcon?: boolean;
  canToggle?: boolean;
  forceOpen?: boolean;
  kindLabelOverride?: ReactNode;
  sourceLabel?: string;
  disableSummaryContentAnimation?: boolean;
  animateDiffCountOnMount?: boolean;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: (automationId?: string) => void;
  onLoadFullToolCallFields?: (toolId: string) => Promise<boolean | void> | boolean | void;
  fullOutputContent?: ReactNode;
  getFullOutputContent?: (toolId: string) => ReactNode;
  renderChildToolCall: (
    node: TaskChatToolCallTreeNode,
    options?: { showIcon?: boolean },
  ) => ReactNode;
}

export function renderFilePath(path: string | null | undefined, basePath?: string) {
  if (!path) return null;
  return (
    <span className="min-w-0 truncate text-foreground-subtlest @max-[360px]/conversation:hidden">
      {/* 窄会话流里父目录会与文件名争空间，Read/Edit 最终只剩动作标签和省略号。 */}
      {getFileDisplayPath(path, basePath)}
    </span>
  );
}

export function renderDiffCount(
  changeStat?: { added: number; removed: number },
  options?: { animateInitial?: boolean },
) {
  if (!changeStat || (changeStat.added <= 0 && changeStat.removed <= 0)) return null;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono leading-none tabular-nums">
      {changeStat.added > 0 ? (
        <span aria-label={`+${changeStat.added}`} className="inline-flex items-center text-diff-added" role="text" title={`+${changeStat.added}`}>
          +<FlipMetricValue value={String(changeStat.added)} animateInitial={options?.animateInitial} />
        </span>
      ) : null}
      {changeStat.removed > 0 ? (
        <span aria-label={`-${changeStat.removed}`} className="inline-flex items-center text-diff-removed" role="text" title={`-${changeStat.removed}`}>
          -<FlipMetricValue value={String(changeStat.removed)} animateInitial={options?.animateInitial} />
        </span>
      ) : null}
    </span>
  );
}

export function renderFileChip({ summary, clickable = false, onClick, title, basePath }: {
  summary: RawToolCallFileSummary;
  clickable?: boolean;
  onClick?: () => void;
  title?: string;
  basePath?: string;
}) {
  const descriptor = resolveFileDisplayDescriptor(summary.path, { basePath });
  const chipTitle = title ?? getFileDisplayPath(summary.path, basePath);
  if (clickable) {
    return (
      <button type="button" className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle hover:underline" title={chipTitle}
        onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onClick={(event) => { event.stopPropagation(); onClick?.(); }}>
        <FileDisplayIcon src={descriptor.fileIconSrc} size={16} className="size-4 shrink-0" />
        <span className="min-w-0 truncate text-foreground-subtle">{getPathLeaf(summary.path)}</span>
      </button>
    );
  }
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle" title={chipTitle}>
      <FileDisplayIcon src={descriptor.fileIconSrc} size={16} className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{getPathLeaf(summary.path)}</span>
    </span>
  );
}

export function getEditKindLabelMessageId(
  operationKinds: EditOperationKind[],
  actionLabels: Array<RawToolCallFileSummary["actionLabel"]>,
  isRunning: boolean,
  source?: EditKindSource,
): EditKindLabelId {
  const inferredOperation = inferEditOperation(operationKinds, actionLabels, source);
  if (inferredOperation === "write") return isRunning ? "chat.toolCall.edit.writing" : "chat.toolCall.kind.write";
  if (inferredOperation === "delete") return isRunning ? "chat.toolCall.edit.deleting" : "chat.toolCall.kind.delete";
  if (actionLabels.length === 0) return isRunning ? "chat.toolCall.edit.editing" : "chat.toolCall.kind.edit";
  return isRunning ? "chat.toolCall.edit.editing" : "chat.toolCall.kind.edit";
}

export function renderJoinedFileChips(summaries: RawToolCallFileSummary[], options: {
  clickable?: boolean;
  onClick?: (summary: RawToolCallFileSummary) => void;
  basePath?: string;
} = {}) {
  return (
    <div className="inline-flex min-w-0 items-center">
      {summaries.map((summary, index) => (
        <span key={summary.path} className="inline-flex min-w-0 items-center">
          {index > 0 ? <span className="mx-1 text-foreground-subtlest">,</span> : null}
          {renderFileChip({ summary, clickable: options.clickable, basePath: options.basePath,
            onClick: options.onClick ? () => options.onClick?.(summary) : undefined })}
        </span>
      ))}
    </div>
  );
}
