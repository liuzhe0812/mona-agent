import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { ModelSelector } from "@/components/models/ModelSelector";
import type { ModelOption as ComposerModelOption } from "@/components/models/model-sources";
export type { ModelOption as ComposerModelOption } from "@/components/models/model-sources";

import { MarkdownText, preloadMarkdownText } from "@/components/MarkdownText";
import {
  Activity,
  ArrowUp,
  AtSign,
  BookOpen,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Cpu,
  Folder,
  Globe,
  History,
  Layers,
  Loader2,
  Mail,
  Monitor,
  Plus,
  RotateCw,
  Sparkles,
  Square,
  SquarePen,
  Target,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover } from "radix-ui";

import { Button } from "@/components/ui/button";
import { FileSystemIcon } from "@/components/ui/file-system-icon";
import { Tooltip, TooltipButton, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { OfficeDocChip } from "@/components/doc/office/OfficeDocChip";
import {
  useAttachedImages,
  isInlineImage,
  type AttachedImage,
  type AttachmentError,
  MAX_IMAGES_PER_MESSAGE,
} from "@/hooks/useAttachedImages";
import { useAttachedDocuments, type AttachedDocument } from "@/hooks/useAttachedDocuments";
import { useClipboardAndDrop } from "@/hooks/useClipboardAndDrop";
import type { SendImage, SendOptions } from "@/hooks/useMonaStream";
import type { PendingMessage } from "@/hooks/usePendingQueue";
import type { MessageQuote, RoomAgentInfo, SlashCommand, GoalStateWsPayload } from "@/lib/types";
import { MonaComposerPeek } from "@/components/thread/MonaComposerPeek";
import {
  getDesktopSettings,
  isTauri,
  SEND_MESSAGE_SHORTCUT_EVENT,
  type SendMessageShortcut,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { PendingQueueStrip } from "@/components/thread/PendingQueueStrip";

const MAX_QUOTE_CONTENT_CHARS = 4_000;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatContextTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1000).toFixed(1)}K`;
}

function resolvedContextUsage(usage?: ThreadComposerProps["contextUsage"]): {
  percent: number;
  label: string;
} {
  if (!usage) return { percent: 0, label: "暂无上下文用量" };
  if (!usage.total || usage.total <= 0 || usage.used < 0) {
    return {
      percent: 0,
      label: `已使用 ${formatContextTokens(Math.max(0, usage.used))}，模型上下文窗口未知`,
    };
  }
  const percent = (usage.used / usage.total) * 100;
  return {
    percent: Math.min(100, percent),
    label: `${percent.toFixed(1)}% · ${formatContextTokens(usage.used)} / ${formatContextTokens(usage.total)} 上下文已使用`,
  };
}

function ContextUsageIndicator({ usage }: { usage?: ThreadComposerProps["contextUsage"] }) {
  const { percent, label } = resolvedContextUsage(usage);
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            tabIndex={0}
            aria-label={label}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
              <circle cx="12" cy="12" r="9" fill="none" stroke="hsl(var(--border))" strokeWidth="2" />
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                pathLength="100"
                strokeDasharray={`${percent} 100`}
                transform="rotate(-90 12 12)"
              />
            </svg>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} className="whitespace-nowrap">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface ThreadComposerProps {
  chatId?: string | null;
  draftScope?: string;
  onSend: (content: string, images?: SendImage[], options?: SendOptions) => void | boolean | Promise<void | boolean>;
  awaitSendResult?: boolean;
  documentDraft?: AttachedDocument[];
  onDocumentDraftChange?: (value: AttachedDocument[]) => void;
  value?: string;
  onValueChange?: (value: string) => void;
  suggestedPrompt?: { text: string; requestId: string };
  clearOnSend?: boolean;
  disabled?: boolean;
  sendDisabled?: boolean;
  placeholder?: string;
  inputLabel?: string;
  sendLabel?: string;
  stopLabel?: string;
  autoFocus?: boolean;
  isStreaming?: boolean;
  /** True after a computer_act tool has started in the active run. */
  computerUseActive?: boolean;
  /** True after a message is sent and before Mona emits visible activity. */
  isAwaitingModelResponse?: boolean;
  /** True while the current turn is compacting earlier conversation context. */
  isCompacting?: boolean;
  /** True while the server is confirming a stop request. */
  stopping?: boolean;
  modelLabel?: string | null;
  modelOptions?: ComposerModelOption[];
  onModelSwitch?: (provider: string, model: string, reasoningEffort?: string | null) => void | Promise<void>;
  onModelSelect?: (option: ComposerModelOption, effort?: string | null) => void | Promise<void>;
  modelDisabled?: boolean;
  currentExecutor?: string;
  /** Latest turn context usage vs the active model's context window.
   * ``total`` is ``null`` when the active model has no known context window. */
  contextUsage?: {
    used: number;
    total: number | null;
  } | null;
  /** Server-resolved capability of the active preset. When false, image
   * attach/paste/drop is rejected with an inline hint. Default true. */
  imageInputEnabled?: boolean;
  variant?: "thread" | "hero";
  slashCommands?: SlashCommand[];
  onStop?: () => void;
  /** Unix seconds from server; turn elapsed timer above input while set. */
  runStartedAt?: number | null;
  /** Sustained objective for this chat (WebSocket ``goal_state``). */
  goalState?: GoalStateWsPayload;
  leadingActions?: ReactNode;
  /** Project workspace bound to a new-chat composer. Only shown in hero mode. */
  workspace?: string | null;
  onWorkspaceChange?: (workspace: string | null) => void;
  showHeroPromptChips?: boolean;
  onOpenSettings?: (section?: string) => void;
  attachmentsEnabled?: boolean;
  onAttach?: () => void;
  attachLabel?: string;
  /** Pending message queue for mid-turn staging. */
  pendingMessages?: PendingMessage[];
  onPendingAppend?: (id: string) => void;
  onPendingRemove?: (id: string) => void;
  onPendingEdit?: (id: string, content: string) => void | Promise<void>;
  isPendingFull?: boolean;
  /** Room members offered by the ``@`` picker (multi-agent guide 7.5). When
   * empty the picker is disabled (direct chats). */
  mentionableAgents?: RoomAgentInfo[];
  quote?: MessageQuote | null;
  onClearQuote?: () => void;
}

const COMMAND_ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  "book-open": BookOpen,
  "circle-help": CircleHelp,
  history: History,
  "rotate-cw": RotateCw,
  sparkles: Sparkles,
  square: Square,
  "square-pen": SquarePen,
  "undo-2": Undo2,
};

export interface HeroPromptChip {
  label: string;
  prompt: string;
  Icon: LucideIcon;
  iconClass: string;
}

const HERO_PROMPT_CHIPS: HeroPromptChip[] = [
  {
    label: "网页生成笔记",
    prompt: "把这个网页转成笔记：|",
    Icon: Globe,
    iconClass: "text-info-strong",
  },
  {
    label: "邮件整理今日待办",
    prompt: "整理今天邮件里的待办事项",
    Icon: Mail,
    iconClass: "text-warning",
  },
  {
    label: "帮我想想关于…",
    prompt: "帮我找找记录过关于「|」的内容，从笔记、资料、邮件、记忆里整理出来",
    Icon: Layers,
    iconClass: "text-info-strong",
  },
];

const SLASH_PALETTE_GAP_PX = 8;
const SLASH_PALETTE_MAX_HEIGHT_PX = 288;
const SLASH_PALETTE_MIN_HEIGHT_PX = 144;
const SLASH_PALETTE_CHROME_PX = 64;

type SlashPalettePlacement = "above" | "below";

interface SlashPaletteLayout {
  placement: SlashPalettePlacement;
  maxHeight: number;
}

function slashCommandI18nKey(command: string): string {
  return command.replace(/^\//, "").replace(/-/g, "_");
}

function getVisibleBounds(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  let parent = el.parentElement;

  while (parent) {
    const style = window.getComputedStyle(parent);
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      const rect = parent.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
    parent = parent.parentElement;
  }

  return { top, bottom };
}

function goalStateStripPreview(
  goal: GoalStateWsPayload | undefined,
  t: (key: string) => string,
): string | null {
  if (!goal?.active) return null;
  const summary = goal.ui_summary?.trim();
  if (summary) return summary;
  const obj = goal.objective?.trim();
  if (obj) return obj.length > 72 ? `${obj.slice(0, 72)}…` : obj;
  return t("thread.composer.goalStateFallback");
}

const GOAL_PANEL_VIEWPORT_TOP_PAD = 20;
const GOAL_PANEL_GAP_ABOVE_STRIP_PX = 10;
const GOAL_PANEL_MIN_HEIGHT_PX = 112;
const GOAL_PANEL_MAX_VIEWPORT_RATIO = 0.62;

function measureGoalPanelMaxCssHeight(stripTopY: number): number {
  const spaceAboveStrip =
    stripTopY - GOAL_PANEL_VIEWPORT_TOP_PAD - GOAL_PANEL_GAP_ABOVE_STRIP_PX;
  return Math.min(
    Math.max(spaceAboveStrip, GOAL_PANEL_MIN_HEIGHT_PX),
    Math.floor(window.innerHeight * GOAL_PANEL_MAX_VIEWPORT_RATIO),
  );
}

function buildGoalMarkdownBody(summary: string, objective: string): string {
  const s = summary.trim();
  const o = objective.trim();
  if (s && o) return `${s}\n\n---\n\n${o}`;
  return o || s;
}

function FlowingActivityIcon({ className }: { className?: string }) {
  const gradientId = `mona-ai-activity-${useId().replace(/:/g, "")}`;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="-48"
          y1="0"
          x2="0"
          y2="0"
        >
          <stop offset="0%" stopColor="hsl(var(--theme))" />
          <stop offset="45%" stopColor="hsl(var(--ai-cyan))" />
          <stop offset="55%" stopColor="hsl(var(--success-indicator))" />
          <stop offset="100%" stopColor="hsl(var(--theme))" />
          <animateTransform
            className="ai-activity-sweep"
            attributeName="gradientTransform"
            type="translate"
            from="0 0"
            to="48 0"
            dur="1.8s"
            repeatCount="indefinite"
          />
        </linearGradient>
      </defs>
      <path
        d="M22 12h-4l-3 9L9 3l-3 9H2"
        stroke={`url(#${gradientId})`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RunElapsedStrip({
  startedAt,
  goalState,
  isAwaitingModelResponse = false,
  isCompacting = false,
}: {
  startedAt: number | null;
  goalState?: GoalStateWsPayload;
  isAwaitingModelResponse?: boolean;
  isCompacting?: boolean;
}) {
  const { t } = useTranslation();
  const [goalPanelOpen, setGoalPanelOpen] = useState(false);
  const [, setTick] = useState(0);
  const stripWrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const expandToggleRef = useRef<HTMLButtonElement>(null);
  const [panelMaxPx, setPanelMaxPx] = useState(280);

  useEffect(() => {
    if (startedAt == null) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const showTimer = startedAt != null;
  const stripLabel = goalStateStripPreview(goalState, t);
  const showGoal = !!stripLabel?.trim();
  if (!showTimer && !showGoal) return null;

  const objectiveFull = goalState?.objective?.trim() ?? "";
  const summaryFull = goalState?.ui_summary?.trim() ?? "";
  const canExpandGoal = !!(goalState?.active && (objectiveFull || summaryFull));

  const markdownBody =
    objectiveFull || summaryFull
      ? buildGoalMarkdownBody(summaryFull, objectiveFull)
      : "";

  useLayoutEffect(() => {
    if (!goalPanelOpen) return;

    function relayout(): void {
      const el = stripWrapperRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      setPanelMaxPx(measureGoalPanelMaxCssHeight(top));
    }

    relayout();

    preloadMarkdownText();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => relayout())
        : null;
    if (stripWrapperRef.current && ro) {
      ro.observe(stripWrapperRef.current);
    }
    window.addEventListener("resize", relayout);
    window.addEventListener("scroll", relayout, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", relayout);
      window.removeEventListener("scroll", relayout, true);
    };
  }, [goalPanelOpen]);

  useEffect(() => {
    if (!goalPanelOpen) return;

    function onPointerDown(ev: MouseEvent): void {
      const target = ev.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (expandToggleRef.current?.contains(target)) return;
      setGoalPanelOpen(false);
    }

    function onKey(ev: KeyboardEvent): void {
      if (ev.key === "Escape") setGoalPanelOpen(false);
    }

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [goalPanelOpen]);

  const elapsed =
    startedAt != null ? Math.max(0, Math.floor(Date.now() / 1000 - startedAt)) : 0;
  const m = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  const shortElapsed = m > 0 ? `${m}:${sec.toString().padStart(2, "0")}` : `${sec}s`;
  const timerTitle = showTimer
    ? t("thread.composer.runRuntimeTitle", { elapsed: shortElapsed })
    : null;
  const activityTitle = isCompacting && timerTitle
    ? t("thread.composer.compactingRuntimeTitle", { elapsed: shortElapsed })
    : isAwaitingModelResponse && timerTitle
      ? t("thread.composer.awaitingResponseRuntimeTitle", { elapsed: shortElapsed })
      : timerTitle;

  const ariaParts = [activityTitle, showGoal ? stripLabel : null].filter(Boolean);
  const ariaLabel = ariaParts.join(" · ");

  return (
    <div ref={stripWrapperRef} className="relative z-30">
      {goalPanelOpen && canExpandGoal && markdownBody ? (
        <div
          ref={panelRef}
          id="mona-goal-panel-root"
          role="dialog"
          aria-modal="false"
          aria-labelledby="mona-goal-panel-title"
          tabIndex={-1}
          className={cn(
            "absolute bottom-[calc(100%+8px)] left-3 right-3 z-[50] flex max-w-none flex-col overflow-hidden",
            "rounded-2xl border border-border/60 bg-card shadow-lg",
            "backdrop-blur-sm dark:border-white/10",
          )}
          style={{ maxHeight: `${Math.round(panelMaxPx)}px` }}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.08]">
            <h2
              id="mona-goal-panel-title"
              className="min-w-0 truncate text-[13px] font-semibold tracking-tight text-foreground"
            >
              {t("thread.composer.goalStateSheetTitle")}
            </h2>
            <button
              type="button"
              className={cn(
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                "text-muted-foreground transition-colors hover:bg-muted/65 hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              aria-label={t("thread.composer.goalStateCloseAria")}
              onClick={() => setGoalPanelOpen(false)}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <div
            id="mona-goal-panel-scroll"
            className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-3 pb-3 pt-2"
          >
            <MarkdownText className="max-w-none text-[13.5px] leading-relaxed text-foreground/90">
              {markdownBody}
            </MarkdownText>
          </div>
        </div>
      ) : null}
      <div
        className="flex min-h-[36px] items-center gap-2 border-b border-black/[0.04] px-3 py-2 dark:border-white/[0.06]"
        role="status"
        aria-label={ariaLabel}
      >
        {showTimer ? (
          <FlowingActivityIcon className="ai-activity-gradient h-4 w-4 shrink-0" />
        ) : (
          <Target className="h-4 w-4 shrink-0 text-primary/75" aria-hidden />
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-medium text-foreground/75">
          {activityTitle ? <span className="shrink-0">{activityTitle}</span> : null}
          {activityTitle && showGoal ? (
            <span className="shrink-0 text-muted-foreground/45" aria-hidden>
              ·
            </span>
          ) : null}
          {showGoal ? (
            <span className="truncate">
              {t("thread.composer.goalStateStrip", { label: stripLabel })}
            </span>
          ) : null}
        </span>
        {canExpandGoal ? (
          <button
            ref={expandToggleRef}
            type="button"
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
              "text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            aria-expanded={goalPanelOpen}
            aria-controls={goalPanelOpen ? "mona-goal-panel-root" : undefined}
            aria-label={t("thread.composer.goalStateExpandAria")}
            title={t("thread.composer.goalStateExpandAria")}
            onClick={() => setGoalPanelOpen((o) => !o)}
          >
            {goalPanelOpen ? (
              <ChevronDown className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronUp className="h-4 w-4" aria-hidden />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ThreadComposer({
  chatId,
  draftScope,
  onSend,
  awaitSendResult = false,
  documentDraft,
  onDocumentDraftChange,
  value: controlledValue,
  onValueChange,
  clearOnSend = true,
  disabled,
  sendDisabled = false,
  placeholder,
  inputLabel,
  sendLabel,
  stopLabel,
  autoFocus = true,
  isStreaming = false,
  computerUseActive = false,
  isAwaitingModelResponse = false,
  stopping = false,
  isCompacting = false,
  modelLabel = null,
  modelOptions = [],
  onModelSwitch,
  onModelSelect,
  modelDisabled = false,
  currentExecutor,
  contextUsage = null,
  imageInputEnabled = true,
  variant = "thread",
  slashCommands = [],
  onStop,
  runStartedAt = null,
  goalState,
  leadingActions,
  pendingMessages = [],
  onPendingAppend,
  onPendingRemove,
  isPendingFull = false,
  workspace,
  onWorkspaceChange,
  showHeroPromptChips = true,
  onOpenSettings,
  attachmentsEnabled = true,
  onAttach,
  attachLabel: customAttachLabel,
  mentionableAgents = [],
  onPendingEdit,
  quote = null,
  onClearQuote,
  suggestedPrompt,
}: ThreadComposerProps) {
  const { t } = useTranslation();
  const fileAttachLabel = t("thread.composer.attachFile");
  const resolvedAttachLabel = customAttachLabel ?? fileAttachLabel;
  const {
    documents,
    uploading: documentsUploading,
    error: documentUploadError,
    add: addDocuments,
    remove: removeDocument,
    clear: clearDocuments,
  } = useAttachedDocuments(chatId, documentDraft, onDocumentDraftChange);
  const submitting = useRef(false);
  const submitScope = useRef(chatId); submitScope.current = chatId;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [internalValue, setInternalValue] = useState("");
  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : internalValue;
  const isControlledRef = useRef(isControlled);
  isControlledRef.current = isControlled;
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;
  const valueRef = useRef(value);
  valueRef.current = value;
  const setValue = useCallback((next: string | ((current: string) => string)) => {
    const resolved = typeof next === "function" ? next(valueRef.current) : next;
    valueRef.current = resolved;
    if (!isControlledRef.current) setInternalValue(resolved);
    onValueChangeRef.current?.(resolved);
  }, []);
  const [sendMessageShortcut, setSendMessageShortcut] = useState<SendMessageShortcut>("enter");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  /** ``@`` picker state: anchor = index of the ``@`` char, query = text after
   * it up to the caret. ``null`` closes the palette. */
  const [mention, setMention] = useState<{ anchor: number; query: string } | null>(null);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  /** Inserted ``@DisplayName`` tokens → agent id. Stale tokens (user deleted
   * the text) are filtered out at submit time. */
  const mentionedRef = useRef(new Map<string, string>());
  const mentionDraftsRef = useRef(new Map<string, Map<string, string>>());
  if (draftScope !== undefined) {
    let mentions = mentionDraftsRef.current.get(draftScope);
    if (!mentions) {
      mentions = new Map();
      mentionDraftsRef.current.set(draftScope, mentions);
    }
    mentionedRef.current = mentions;
  }
  useEffect(() => {
    if (draftScope === undefined) return;
    setMention(null);
    setSelectedMentionIndex(0);
    setInlineError(null);
  }, [draftScope]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!suggestedPrompt) return;
    setValue((current) => current.trim()
      ? `${current}\n${suggestedPrompt.text}` : suggestedPrompt.text);
    textareaRef.current?.focus();
  }, [suggestedPrompt, setValue]);
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const suppressHeroPopoverTriggerFocusRef = useRef(false);
  const [heroPromptPopoverOpen, setHeroPromptPopoverOpen] = useState(false);
  const isHero = variant === "hero";
  const activeModelOption = modelOptions.find((option) => option.active) ?? null;
  const triggerModelLabel = activeModelOption?.label || modelLabel;
  const resolvedPlaceholder = isCompacting
    ? t("thread.composer.placeholderCompacting")
    : isAwaitingModelResponse
      ? t("thread.composer.placeholderAwaitingResponse")
      : isStreaming
        ? t("thread.composer.placeholderStreaming")
        : placeholder ?? t("thread.composer.placeholderThread");

  useEffect(() => {
    if (!quote) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [quote]);

  useLayoutEffect(() => {
    if (isControlled) return;
    // Clear stale inline sizing after hot reload without measuring on ordinary value changes.
    const el = textareaRef.current;
    if (!el || valueRef.current.trim()) return;
    el.style.removeProperty("height");
  }, [isControlled]);

  useLayoutEffect(() => {
    if (!isControlled) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.value) el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [isControlled, value]);

  useEffect(() => {
    let cancelled = false;
    if (isTauri()) {
      void getDesktopSettings()
        .then((settings) => {
          const next = settings.send_message_shortcut;
          if (!cancelled && (next === "enter" || next === "ctrl_enter")) {
            setSendMessageShortcut(next);
          }
        })
        .catch(() => {});
    }
    const handleShortcutChange = (event: Event) => {
      const next = (event as CustomEvent<SendMessageShortcut>).detail;
      if (next === "enter" || next === "ctrl_enter") setSendMessageShortcut(next);
    };
    window.addEventListener(SEND_MESSAGE_SHORTCUT_EVENT, handleShortcutChange);
    return () => {
      cancelled = true;
      window.removeEventListener(SEND_MESSAGE_SHORTCUT_EVENT, handleShortcutChange);
    };
  }, []);

  const { images, enqueue, remove, clear, encoding } =
    useAttachedImages(draftScope);

  const formatRejection = useCallback(
    (reason: AttachmentError): string => {
      const key = `thread.composer.imageRejected.${reason}`;
      return t(key, { max: MAX_IMAGES_PER_MESSAGE });
    },
    [t],
  );
  const attachmentsDisabledMessage = t("thread.composer.attachmentsDisabled", {
    defaultValue: "当前模式不支持附件。",
  });

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (!imageInputEnabled) {
        setInlineError(t("thread.composer.imageNotSupported"));
        return;
      }
      const { rejected } = enqueue(files);
      if (rejected.length > 0) {
        setInlineError(formatRejection(rejected[0].reason));
      } else {
        setInlineError(null);
      }
    },
    [enqueue, formatRejection, imageInputEnabled, t],
  );

  const addAttachments = useCallback(
    (files: File[]) => {
      if (files.length === 0 || disabled) return;
      if (!attachmentsEnabled) {
        setInlineError(attachmentsDisabledMessage);
        return;
      }
      if (documentsUploading) return;
      const images = imageInputEnabled
        ? files.filter(isInlineImage)
        : [];
      const attachments = files.filter((file) => !images.includes(file));
      if (images.length > 0) addFiles(images);
      if (attachments.length > 0) void addDocuments(attachments);
    },
    [addFiles, addDocuments, attachmentsDisabledMessage, attachmentsEnabled, disabled, documentsUploading, imageInputEnabled],
  );

  const addDroppedAttachments = useCallback(
    (files: File[]) => {
      if (files.length === 0 || disabled) return;
      if (!attachmentsEnabled) {
        setInlineError(attachmentsDisabledMessage);
        return;
      }
      if (documentsUploading) return;
      void addDocuments(files);
    },
    [addDocuments, attachmentsDisabledMessage, attachmentsEnabled, disabled, documentsUploading],
  );

  const {
    isDragging,
    onPaste,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  } = useClipboardAndDrop(addAttachments, {
    acceptAllFiles: true,
    onDropFiles: addDroppedAttachments,
  });

  useEffect(() => {
    if (!autoFocus || disabled) return;
    const el = textareaRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => el.focus());
    return () => cancelAnimationFrame(id);
  }, [autoFocus, disabled]);

  const readyImages = useMemo(
    () => images.filter((img): img is AttachedImage & { dataUrl: string } =>
      img.status === "ready" && typeof img.dataUrl === "string",
    ),
    [images],
  );
  const hasErrors = images.some((img) => img.status === "error");

  const canSend =
    !disabled
    && !sendDisabled
    && !(isStreaming && isPendingFull)
    && !encoding
    && !documentsUploading
    && !hasErrors
    && (value.trim().length > 0 || readyImages.length > 0 || documents.length > 0);

  const slashQuery = useMemo(() => {
    if (disabled || slashMenuDismissed || !value.startsWith("/")) return null;
    const commandToken = value.slice(1);
    if (/\s/.test(commandToken)) return null;
    return commandToken.toLowerCase();
  }, [disabled, slashMenuDismissed, value]);

  const filteredSlashCommands = useMemo(() => {
    if (slashQuery === null) return [];
    return slashCommands
      .filter((command) => {
        const haystack = [
          command.command,
          command.title,
          command.description,
          command.argHint ?? "",
          t(`thread.composer.slash.commands.${slashCommandI18nKey(command.command)}.title`, {
            defaultValue: "",
          }),
          t(`thread.composer.slash.commands.${slashCommandI18nKey(command.command)}.description`, {
            defaultValue: "",
          }),
        ].join(" ").toLowerCase();
        return haystack.includes(slashQuery);
      })
      .slice(0, 8);
  }, [slashCommands, slashQuery, t]);

  const showSlashMenu = filteredSlashCommands.length > 0;
  const [slashPaletteLayout, setSlashPaletteLayout] = useState<SlashPaletteLayout>({
    placement: "above",
    maxHeight: SLASH_PALETTE_MAX_HEIGHT_PX,
  });

  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (selectedCommandIndex >= filteredSlashCommands.length) {
      setSelectedCommandIndex(0);
    }
  }, [filteredSlashCommands.length, selectedCommandIndex]);

  useEffect(() => {
    if (!showSlashMenu) return;

    const dismissOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && formRef.current?.contains(target)) return;
      setSlashMenuDismissed(true);
    };

    document.addEventListener("pointerdown", dismissOnPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointerDown, true);
    };
  }, [showSlashMenu]);

  useLayoutEffect(() => {
    if (!showSlashMenu) return;

    const updateLayout = () => {
      const form = formRef.current;
      if (!form) return;
      const rect = form.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const bounds = getVisibleBounds(form);
      const spaceAbove = Math.max(0, rect.top - bounds.top - SLASH_PALETTE_GAP_PX);
      const spaceBelow = Math.max(0, bounds.bottom - rect.bottom - SLASH_PALETTE_GAP_PX);
      const placement: SlashPalettePlacement =
        spaceAbove >= SLASH_PALETTE_MIN_HEIGHT_PX || spaceAbove >= spaceBelow
          ? "above"
          : "below";
      const available = placement === "above" ? spaceAbove : spaceBelow;
      const maxHeight = Math.min(SLASH_PALETTE_MAX_HEIGHT_PX, available);

      setSlashPaletteLayout((current) =>
        current.placement === placement && current.maxHeight === maxHeight
          ? current
          : { placement, maxHeight },
      );
    };

    updateLayout();
    window.addEventListener("resize", updateLayout);
    document.addEventListener("scroll", updateLayout, true);
    return () => {
      window.removeEventListener("resize", updateLayout);
      document.removeEventListener("scroll", updateLayout, true);
    };
  }, [filteredSlashCommands.length, showSlashMenu]);

  const resizeTextarea = useCallback(() => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      if (el.value) el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
      el.focus();
    });
  }, []);

  const chooseSlashCommand = useCallback(
    (command: SlashCommand) => {
      setValue(command.argHint ? `${command.command} ` : command.command);
      setSlashMenuDismissed(true);
      setInlineError(null);
      resizeTextarea();
    },
    [resizeTextarea],
  );

  const applyHeroChip = useCallback((chip: HeroPromptChip) => {
    const marker = "|";
    const markerIdx = chip.prompt.indexOf(marker);
    const text = chip.prompt.replace(marker, "");
    setValue(text);
    setSlashMenuDismissed(true);
    setInlineError(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
      el.focus();
      const pos = markerIdx >= 0 ? markerIdx : text.length;
      el.setSelectionRange(pos, pos);
    });
  }, []);

  const filteredMentionAgents = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return mentionableAgents
      .filter(
        (agent) =>
          !q
          || agent.displayName.toLowerCase().includes(q)
          || agent.id.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [mention, mentionableAgents]);

  const showMentionMenu = mention !== null && filteredMentionAgents.length > 0;

  useEffect(() => {
    setSelectedMentionIndex(0);
  }, [mention?.query]);

  useEffect(() => {
    if (selectedMentionIndex >= filteredMentionAgents.length) {
      setSelectedMentionIndex(0);
    }
  }, [filteredMentionAgents.length, selectedMentionIndex]);

  /** Detect an active ``@query`` token at the caret and open/close the
   * picker accordingly. The ``@`` must start a token (start of text or
   * preceded by whitespace) and contain no whitespace before the caret. */
  const trackMention = useCallback(
    (text: string, caret: number) => {
      if (mentionableAgents.length === 0) {
        setMention(null);
        return;
      }
      let anchor = -1;
      for (let i = caret - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === "@") {
          if (i === 0 || /\s/.test(text[i - 1])) anchor = i;
          break;
        }
        if (/\s/.test(ch)) break;
      }
      setMention(anchor >= 0 ? { anchor, query: text.slice(anchor + 1, caret) } : null);
    },
    [mentionableAgents.length],
  );

  const chooseMention = useCallback(
    (agent: RoomAgentInfo) => {
      if (!mention) return;
      const el = textareaRef.current;
      const caret = el ? el.selectionStart : mention.anchor + 1 + mention.query.length;
      const end = Math.max(caret, mention.anchor + 1 + mention.query.length);
      const token = `@${agent.displayName}`;
      const next = `${value.slice(0, mention.anchor)}${token} ${value.slice(end)}`;
      mentionedRef.current.set(token, agent.id);
      setValue(next);
      setMention(null);
      const pos = mention.anchor + token.length + 1;
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      });
    },
    [mention, value],
  );

  const submit = useCallback(async () => {
    if (!canSend || submitting.current) return;
    const owner = chatId;
    const trimmed = value.trim();
    // Share the same normalized ``data:`` URL with both the wire payload and
    // the optimistic bubble preview: data URLs are self-contained (no blob
    // lifetime, safe under React StrictMode double-mount) and keep the
    // bubble in sync with whatever the backend actually sees.
    const payload: SendImage[] | undefined =
      readyImages.length > 0
        ? readyImages.map((img) => ({
            media: {
              data_url: img.dataUrl,
              name: img.file.name,
            },
            preview: { url: img.dataUrl, name: img.file.name },
          }))
        : undefined;
    const targetAgentIds = [
      ...new Set(
        [...mentionedRef.current.entries()]
          .filter(([token]) => trimmed.includes(token))
          .map(([, id]) => id),
      ),
    ];
    const quotedMessage = quote
      ? {
          author: quote.author.trim().slice(0, 80),
          content: quote.content.trim().slice(0, MAX_QUOTE_CONTENT_CHARS),
        }
      : null;
    const content = quotedMessage
      ? `引用 ${quotedMessage.author} 的消息：\n${quotedMessage.content}\n\n${trimmed}`
      : trimmed;
    const options = targetAgentIds.length > 0 || quotedMessage || documents.length > 0
      ? {
          ...(targetAgentIds.length > 0 ? { targetAgentIds } : {}),
          ...(quotedMessage ? { quote: quotedMessage, displayContent: trimmed } : {}),
          ...(documents.length > 0 ? {
            docPaths: documents.map((document) => document.path),
            documentNames: documents.map((document) => document.name),
          } : {}),
        }
      : undefined;
    submitting.current = true;
    try {
      const result = onSend(content, payload, options);
      if (awaitSendResult && await result !== true) return;
      if (!mounted.current || submitScope.current !== owner) return;
    } catch (cause) {
      if (mounted.current && submitScope.current === owner) setInlineError(cause instanceof Error ? cause.message : "发送失败，原输入已保留。");
      return;
    } finally { submitting.current = false; }
    mentionedRef.current.clear();
    if (clearOnSend) setValue("");
    setInlineError(null);
    // Bubble owns the data URL copy; safe to revoke every staged blob
    // preview here without affecting the rendered message.
    clear();
    if (awaitSendResult) documents.forEach((document) => removeDocument(document.path));
    else clearDocuments();
    setSlashMenuDismissed(false);
    setMention(null);
    onClearQuote?.();
    resizeTextarea();
  }, [awaitSendResult, canSend, chatId, clear, clearDocuments, clearOnSend, documents, onClearQuote, onSend, quote, readyImages, removeDocument, resizeTextarea, setValue, value]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedMentionIndex((idx) => (idx + 1) % filteredMentionAgents.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedMentionIndex(
          (idx) => (idx - 1 + filteredMentionAgents.length) % filteredMentionAgents.length,
        );
        return;
      }
      if (
        e.key === "Tab"
        || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)
      ) {
        e.preventDefault();
        chooseMention(filteredMentionAgents[selectedMentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (showSlashMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedCommandIndex((idx) => (idx + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedCommandIndex(
          (idx) => (idx - 1 + filteredSlashCommands.length) % filteredSlashCommands.length,
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        chooseSlashCommand(filteredSlashCommands[selectedCommandIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuDismissed(true);
        return;
      }
    }
    const shortcutMatches =
      sendMessageShortcut === "enter"
        ? !e.ctrlKey && !e.metaKey && !e.altKey
        : (e.ctrlKey || e.metaKey) && !e.altKey;
    if (
      e.key === "Enter"
      && !e.shiftKey
      && !e.nativeEvent.isComposing
      && shortcutMatches
    ) {
      e.preventDefault();
      submit();
    }
  };

  const onInput: React.FormEventHandler<HTMLTextAreaElement> = (e) => {
    const el = e.currentTarget;
    el.style.height = "auto";
    if (el.value) el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  };

  const onFilePick: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    addDroppedAttachments(files);
  };

  const openAttachmentPicker = useCallback(async () => {
    if (!attachmentsEnabled) {
      setInlineError(attachmentsDisabledMessage);
      return;
    }
    if (!isTauri()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: true, directory: false, title: "添加文件" });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (paths.length === 0) return;
      void addDocuments(paths.map((localPath) => ({
        localPath,
        name: localPath.replace(/\\/g, "/").split("/").at(-1) || localPath,
      })));
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : "选择文件失败");
    }
  }, [addDocuments, attachmentsDisabledMessage, attachmentsEnabled]);

  const removeChip = useCallback(
    (id: string) => {
      const { nextFocusId } = remove(id);
      setInlineError(null);
      requestAnimationFrame(() => {
        const el = nextFocusId ? chipRefs.current.get(nextFocusId) : null;
        if (el) {
          el.focus();
        } else {
          textareaRef.current?.focus();
        }
      });
    },
    [remove],
  );

  const editPendingMessage = useCallback(async (id: string) => {
    const message = pendingMessages.find((item) => item.id === id);
    if (!message || message.locked) return;
    setInlineError(null);
    try {
      if (onPendingEdit) {
        await onPendingEdit(id, message.content);
      } else {
        setValue(message.content);
        onPendingRemove?.(id);
      }
      resizeTextarea();
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : "无法编辑这条待发消息。");
    }
  }, [onPendingEdit, onPendingRemove, pendingMessages, resizeTextarea, setValue]);

  const onChipKey = useCallback(
    (id: string) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (
        e.key === "Delete" ||
        e.key === "Backspace" ||
        e.key === "Enter" ||
        e.key === " "
      ) {
        e.preventDefault();
        removeChip(id);
      }
    },
    [removeChip],
  );

  const attachButtonDisabled = disabled || documentsUploading;
  const showStopButton = (isStreaming || stopping) && !!onStop;
  const stopButtonLabel = stopping
    ? t("thread.composer.stopping")
    : stopLabel ?? t("thread.composer.stop");
  const resolvedSendLabel = sendLabel ?? t("thread.composer.send");

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn("relative w-full", isHero ? "px-0" : "px-1 pb-1.5 pt-1 sm:px-0")}
    >
      {computerUseActive && onStop ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2 text-caption leading-5 text-foreground">
            <Monitor className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <span role="status" aria-atomic="true">
              {stopping
                ? t("thread.composer.computerUseStopping")
                : t("thread.composer.computerUseNotice")}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={stopping}
            onClick={onStop}
          >
            {stopping
              ? t("thread.composer.computerUseStoppingAction")
              : t("thread.composer.computerUseTakeOver")}
          </Button>
        </div>
      ) : null}
      {showSlashMenu ? (
        <SlashCommandPalette
          commands={filteredSlashCommands}
          selectedIndex={selectedCommandIndex}
          layout={slashPaletteLayout}
          isHero={isHero}
          onHover={setSelectedCommandIndex}
          onChoose={chooseSlashCommand}
        />
      ) : null}
      {showMentionMenu ? (
        <div
          role="listbox"
          aria-label={t("thread.composer.mention.ariaLabel")}
          className={cn(
            "absolute left-1/2 z-30 w-[calc(100%-0.5rem)] -translate-x-1/2 overflow-hidden rounded-md border",
            "bottom-full mb-2",
            "border-border/65 bg-popover p-1.5 text-popover-foreground shadow-lg",
            "dark:border-white/10",
            isHero ? "max-w-[58rem]" : "max-w-[49.5rem]",
          )}
        >
          <div className="px-2 pb-1 pt-1 text-[11px] font-medium tracking-[0.08em] text-muted-foreground/70">
            {t("thread.composer.mention.label")}
          </div>
          <div className="max-h-56 overflow-y-auto pr-0.5">
            {filteredMentionAgents.map((agent, index) => {
              const selected = index === selectedMentionIndex;
              return (
                <button
                  key={agent.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setSelectedMentionIndex(index)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    chooseMention(agent);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
                    selected
                      ? "bg-primary/10 text-foreground"
                      : "text-foreground/86 hover:bg-accent",
                  )}
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/50"
                  >
                    <AtSign className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {agent.displayName}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {isHero && showHeroPromptChips ? (
        <div
          data-testid="hero-composer-prelude"
          className="pointer-events-none absolute bottom-full left-1/2 z-20 flex w-full max-w-[58rem] -translate-x-1/2 justify-end"
        >
          <div className="pointer-events-auto relative mr-10 translate-y-0.5">
            <Popover.Root open={heroPromptPopoverOpen} onOpenChange={setHeroPromptPopoverOpen} modal={false}>
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Popover.Trigger asChild>
                      <button
                        type="button"
                        aria-label="Mona 快捷提示词"
                        disabled={disabled}
                        className="group flex min-h-11 w-12 items-end border-0 bg-transparent p-0 leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <MonaComposerPeek paused={disabled || isStreaming || heroPromptPopoverOpen || value.trim().length > 0} />
                      </button>
                    </Popover.Trigger>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={8}>
                    Mona 快捷提示词
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Popover.Portal>
                <Popover.Content
                  align="end"
                  side="left"
                  sideOffset={12}
                  className={cn(
                    "relative isolate z-50 aspect-[3/2] w-[216px] max-w-[min(216px,var(--radix-popover-content-available-width,calc(100vw-1rem)),calc(100vw-1rem))]",
                    "bg-transparent p-0 text-foreground outline-none",
                    "data-[state=open]:motion-safe:animate-in data-[state=open]:motion-safe:fade-in-0 data-[state=open]:motion-safe:slide-in-from-right-2 data-[state=open]:motion-safe:zoom-in-95 motion-reduce:animate-none",
                  )}
                  aria-label="Mona 快捷提示词"
                  onCloseAutoFocus={(event) => {
                    if (!suppressHeroPopoverTriggerFocusRef.current) return;
                    suppressHeroPopoverTriggerFocusRef.current = false;
                    event.preventDefault();
                  }}
                >
                  <svg
                    viewBox="0 0 216 144"
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 h-full w-full fill-muted dark:fill-foreground/10"
                  >
                    <path d="M184 88C188 100 198 105 212 106C200 116 183 111 176 103C160 124 130 136 96 136C43 136 4 110 4 72C4 34 43 8 96 8C149 8 188 34 188 72C188 78 187 84 184 88Z" />
                  </svg>
                  <div className="relative flex h-full w-[calc(100%-1.5rem)] flex-col justify-center pl-4 pr-3">
                    {HERO_PROMPT_CHIPS.map((chip) => (
                      <button
                        key={chip.label}
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          suppressHeroPopoverTriggerFocusRef.current = true;
                          setHeroPromptPopoverOpen(false);
                          applyHeroChip(chip);
                        }}
                        className={cn(
                          "block min-h-8 border-0 bg-transparent py-1.5 text-center text-body text-foreground/85",
                          "transition-colors hover:text-foreground focus-visible:outline-none focus-visible:underline focus-visible:underline-offset-4",
                          "disabled:cursor-not-allowed disabled:opacity-50",
                        )}
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </div>
      ) : null}
      <div
        className={cn(
          "mona-composer relative mx-auto flex min-w-0 w-full flex-col overflow-visible transition-all duration-200",
          isHero
            ? "max-w-[58rem] rounded-2xl border border-border/60 bg-card dark:border-white/10"
            : "max-w-[49.5rem] rounded-2xl border border-border/60 bg-card dark:border-white/10",

          disabled && "opacity-60",
          isDragging && attachmentsEnabled && "ring-2 ring-primary/40 motion-reduce:ring-0 motion-reduce:border-primary",
          goalState?.active &&
            "goal-shell-glow ring-1 ring-sky-400/35 motion-reduce:ring-sky-400/25 dark:ring-sky-400/45",
        )}
      >
        {images.length > 0 || documents.length > 0 ? (
          <div
            className="flex flex-wrap gap-2 px-3 pt-3"
            aria-label={resolvedAttachLabel}
          >
            {images.map((img) => (
              <AttachmentChip
                key={img.id}
                image={img}
                labelRemove={t("thread.composer.remove")}
                labelEncoding={t("thread.composer.encoding")}
                normalizedHint={(orig, current) =>
                  t("thread.composer.normalizedSizeHint", {
                    orig: formatBytes(orig),
                    current: formatBytes(current),
                  })
                }
                formatError={formatRejection}
                onRemove={() => removeChip(img.id)}
                onKeyDown={onChipKey(img.id)}
                registerRef={(el) => {
                  if (el) chipRefs.current.set(img.id, el);
                  else chipRefs.current.delete(img.id);
                }}
              />
            ))}
            {documents.map((document) => (
              <OfficeDocChip
                key={document.path}
                name={document.name}
                size={document.size}
                onRemove={() => removeDocument(document.path)}
              />
            ))}
          </div>
        ) : null}
        {runStartedAt != null || goalState?.active ? (
          <RunElapsedStrip
            startedAt={runStartedAt}
            goalState={goalState}
            isAwaitingModelResponse={isAwaitingModelResponse}
            isCompacting={isCompacting}
          />
        ) : null}
        <PendingQueueStrip
          messages={pendingMessages}
          onAppend={onPendingAppend}
          onRemove={onPendingRemove ?? (() => {})}
          onEdit={(id) => void editPendingMessage(id)}
          isFull={isPendingFull}
        />
        {quote ? (
          <div
            data-testid="composer-quote-preview"
            className="mx-3 mt-2 flex min-w-0 items-center gap-2 border-l-2 border-foreground/15 bg-muted/45 px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <div className="text-caption font-medium text-muted-foreground">
                {t("message.quotedMessage", { author: quote.author })}
              </div>
              <div className="truncate text-caption text-muted-foreground">{quote.content}</div>
            </div>
            <button
              type="button"
              aria-label={t("message.removeQuote")}
              title={t("message.removeQuote")}
              onClick={onClearQuote}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSlashMenuDismissed(false);
            trackMention(e.target.value, e.target.selectionStart);
          }}
          onSelect={(e) => {
            trackMention(e.currentTarget.value, e.currentTarget.selectionStart);
          }}
          onClick={(e) => {
            trackMention(e.currentTarget.value, e.currentTarget.selectionStart);
          }}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          placeholder={resolvedPlaceholder}
          disabled={disabled}
          aria-label={inputLabel ?? t("thread.composer.inputAria")}
          className={cn(
            "w-full resize-none bg-transparent",
            isHero
              ? "min-h-[78px] px-5 pb-2 pt-px text-[15px] leading-6"
              : "min-h-[50px] px-4 pb-1.5 pt-3 text-[13.5px] leading-5",
            "placeholder:text-muted-foreground/70",
            "focus:outline-none focus-visible:outline-none",
            "disabled:cursor-not-allowed",
          )}
        />
        {inlineError || documentUploadError ? (
          <div
            role="alert"
            className={cn(
              "mx-3 mb-1 rounded-md border border-destructive/40 bg-destructive/8 px-2.5 py-1",
              "text-[11.5px] font-medium text-destructive",
            )}
          >
            {inlineError ?? documentUploadError}
          </div>
        ) : null}
        <div
          className={cn(
            "mona-composer-toolbar flex items-center justify-between gap-2 whitespace-nowrap",
            isHero ? "px-4 pb-4" : "px-3 pb-2",
          )}
        >
          <div className="mona-composer-leading flex min-w-0 items-center gap-2">
            {attachmentsEnabled && <>
              <input ref={fileInputRef} type="file" multiple hidden onChange={onFilePick} />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={attachButtonDisabled}
                aria-label={fileAttachLabel}
                title={fileAttachLabel}
                onClick={() => void openAttachmentPicker()}
                className={cn(
                  "shrink-0 rounded-md text-foreground",
                  isHero
                    ? "h-7 w-7"
                    : "h-6 w-6",
                )}
              >
                <Plus className={cn(isHero ? "h-4 w-4" : "h-3.5 w-3.5")} />
              </Button>
            </>}
            {onAttach && <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={disabled}
              aria-label={resolvedAttachLabel}
              title={resolvedAttachLabel}
              onClick={onAttach}
              className={cn("shrink-0 rounded-full text-muted-foreground hover:text-foreground", isHero ? "h-7 w-7" : "h-6 w-6")}
            >
              <Folder className={cn(isHero ? "h-4 w-4" : "h-3.5 w-3.5")} />
            </Button>}
            {leadingActions ? (
              <div className="flex min-w-0 items-center gap-1">{leadingActions}</div>
            ) : null}
            {isHero && onWorkspaceChange ? (
              <WorkspaceSelector
                workspace={workspace}
                onChange={onWorkspaceChange}
                disabled={disabled}
              />
            ) : null}
          </div>
          <div className="mona-composer-trailing flex min-w-0 items-center gap-2">
            {triggerModelLabel ? <ContextUsageIndicator usage={contextUsage} /> : null}
            {triggerModelLabel ? (
              modelOptions.length > 0 && (onModelSelect || onModelSwitch) ? (
                <ModelSelector options={modelOptions} label={triggerModelLabel} disabled={disabled || modelDisabled} currentExecutor={currentExecutor}
                  className={cn("rounded-md border-0 bg-transparent px-2", isHero ? "max-w-[20rem]" : "max-w-[16rem]")}
                  onSelect={(option, effort) => onModelSelect
                    ? onModelSelect(option, effort)
                    : onModelSwitch?.(option.provider, option.model, effort)}
                  onManage={onOpenSettings ? () => onOpenSettings("models_providers") : undefined} />
              ) : (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        role="img"
                        tabIndex={0}
                        aria-label={triggerModelLabel}
                        className={cn(
                          "composer-icon-control inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1",
                          "font-medium text-caption text-foreground/85",
                          isHero ? "max-w-[13rem]" : "max-w-[10rem]",
                        )}
                      >
                        <Cpu className="h-4 w-4 shrink-0" aria-hidden />
                        <span className="composer-control-label min-w-0 truncate">{triggerModelLabel}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">{triggerModelLabel}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )
            ) : null}
          <Button
            type={showStopButton ? "button" : "submit"}
            size="icon"
            disabled={showStopButton ? disabled || stopping : !canSend}
            aria-label={showStopButton ? stopButtonLabel : resolvedSendLabel}
            title={showStopButton ? stopButtonLabel : undefined}
            onClick={showStopButton && !stopping ? onStop : undefined}
            className={cn(
              "h-8 w-8 shrink-0 rounded-full border-0 transition-transform",
              showStopButton
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground disabled:bg-destructive/60 disabled:text-destructive-foreground/75"
                : "bg-action text-action-foreground hover:bg-action-hover disabled:bg-muted disabled:text-muted-foreground",
              (canSend || showStopButton) && "hover:scale-105 active:scale-95",
            )}
          >
            {stopping ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : showStopButton ? (
              <Square className="h-3 w-3 fill-current stroke-current" />
            ) : isStreaming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

interface SlashCommandPaletteProps {
  commands: SlashCommand[];
  selectedIndex: number;
  layout: SlashPaletteLayout;
  isHero: boolean;
  onHover: (index: number) => void;
  onChoose: (command: SlashCommand) => void;
}

interface WorkspaceSelectorProps {
  workspace?: string | null;
  onChange: (workspace: string | null) => void;
  disabled?: boolean;
}

function WorkspaceSelector({ workspace, onChange, disabled }: WorkspaceSelectorProps) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);

  const pickWorkspace = useCallback(async () => {
    if (disabled || picking) return;
    setPicking(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string" && selected.trim()) {
        onChange(selected.trim());
      }
    } catch (e) {
      console.error("Failed to pick workspace folder", e);
    } finally {
      setPicking(false);
    }
  }, [disabled, onChange, picking]);

  const clearWorkspace = useCallback(() => {
    onChange(null);
  }, [onChange]);

  if (workspace) {
    const normalized = workspace.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    const basename = parts[parts.length - 1] ?? workspace;
    return (
      <div className="flex min-w-0 items-center gap-2">
        <TooltipButton
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || picking}
          onClick={pickWorkspace}
          title={workspace}
          aria-label={workspace}
          className={cn(
            "composer-icon-control inline-flex min-w-0 h-7 items-center gap-1.5 rounded-lg px-2.5",
            "bg-transparent text-[12px] font-medium text-foreground/80",
            "hover:bg-muted/80 transition-colors cursor-pointer",
            (disabled || picking) && "pointer-events-none opacity-55",
          )}
        >
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="composer-control-label min-w-0 max-w-[12rem] truncate whitespace-nowrap">{basename}</span>
          <ChevronDown className="composer-control-chevron h-3 w-3 shrink-0 text-muted-foreground/70" />
        </TooltipButton>
        <TooltipButton
          type="button"
          variant="ghost"
          size="icon"
          onClick={clearWorkspace}
          disabled={disabled || picking}
          aria-label={t("thread.composer.workspace.clear")}
          title={t("thread.composer.workspace.clear")}
          className={cn(
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            "text-muted-foreground/80 hover:bg-muted/70 hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            (disabled || picking) && "pointer-events-none opacity-55",
          )}
        >
          <X className="h-3 w-3" />
        </TooltipButton>
      </div>
    );
  }

  return (
    <TooltipButton
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled || picking}
      onClick={pickWorkspace}
      title={t("thread.composer.workspace.placeholder")}
      aria-label={t("thread.composer.workspace.placeholder")}
      className={cn(
        "composer-icon-control inline-flex min-w-0 h-7 items-center gap-1.5 rounded-lg px-2.5",
        "bg-transparent text-[12px] font-medium text-foreground/65",
        "hover:bg-muted transition-colors cursor-pointer",
        (disabled || picking) && "pointer-events-none opacity-55",
      )}
    >
      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
      <span className="composer-control-label min-w-0 truncate whitespace-nowrap">{t("thread.composer.workspace.placeholder")}</span>
      <ChevronDown className="composer-control-chevron h-3 w-3 shrink-0 text-muted-foreground/60" />
    </TooltipButton>
  );
}

function SlashCommandPalette({
  commands,
  selectedIndex,
  layout,
  isHero,
  onHover,
  onChoose,
}: SlashCommandPaletteProps) {
  const { t } = useTranslation();
  const listMaxHeight = Math.max(
    0,
    layout.maxHeight - SLASH_PALETTE_CHROME_PX,
  );
  return (
    <div
      role="listbox"
      aria-label={t("thread.composer.slash.ariaLabel")}
      style={{ maxHeight: layout.maxHeight }}
      className={cn(
        "absolute left-1/2 z-30 w-[calc(100%-0.5rem)] -translate-x-1/2 overflow-hidden rounded-md border",
        layout.placement === "above" ? "bottom-full mb-2" : "top-full mt-2",
        "border-border/65 bg-popover p-1.5 text-popover-foreground shadow-lg",
        "dark:border-white/10",
        isHero ? "max-w-[58rem]" : "max-w-[49.5rem]",
      )}
    >
      <div className="px-2 pb-1 pt-1 text-[11px] font-medium tracking-[0.08em] text-muted-foreground/70">
        {t("thread.composer.slash.label")}
      </div>
      <div className="overflow-y-auto pr-0.5" style={{ maxHeight: listMaxHeight }}>
        {commands.map((command, index) => {
          const Icon = COMMAND_ICONS[command.icon] ?? CircleHelp;
          const selected = index === selectedIndex;
          const commandKey = slashCommandI18nKey(command.command);
          const title = t(`thread.composer.slash.commands.${commandKey}.title`, {
            defaultValue: command.title,
          });
          const description = t(`thread.composer.slash.commands.${commandKey}.description`, {
            defaultValue: command.description,
          });
          return (
            <button
              key={command.command}
              type="button"
              role="option"
              aria-selected={selected}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                onChoose(command);
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                selected
                  ? "bg-primary/10 text-foreground"
                  : "text-foreground/86 hover:bg-accent",
              )}
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
                  selected
                    ? "border-primary/25 bg-primary/12 text-primary"
                    : "border-border/65 bg-muted/45 text-muted-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="font-mono text-[13px] font-semibold text-foreground">
                    {command.command}
                  </span>
                  {command.argHint ? (
                    <span className="font-mono text-[12px] text-muted-foreground">
                      {command.argHint}
                    </span>
                  ) : null}
                  <span className="truncate text-[13px] font-medium">
                    {title}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                  {description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 px-2 pt-1.5 text-[10.5px] text-muted-foreground/70">
        <span>{t("thread.composer.slash.navigateHint")}</span>
        <span>{t("thread.composer.slash.selectHint")}</span>
        <span>{t("thread.composer.slash.closeHint")}</span>
      </div>
    </div>
  );
}

interface AttachmentChipProps {
  image: AttachedImage;
  labelRemove: string;
  labelEncoding: string;
  normalizedHint: (origBytes: number, currentBytes: number) => string;
  formatError: (reason: AttachmentError) => string;
  onRemove: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  registerRef: (el: HTMLButtonElement | null) => void;
}

function AttachmentChip({
  image,
  labelRemove,
  labelEncoding,
  normalizedHint,
  formatError,
  onRemove,
  onKeyDown,
  registerRef,
}: AttachmentChipProps) {
  const sizeLabel =
    image.status === "ready" && image.normalized && image.encodedBytes
      ? normalizedHint(image.file.size, image.encodedBytes)
      : formatBytes(image.file.size);
  const tone =
    image.status === "error"
      ? "border-destructive/40 bg-destructive/5 text-destructive"
      : "border-border/70 bg-muted/60";

  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 rounded-lg border px-2 py-1.5",
        "transition-colors motion-reduce:transition-none",
        tone,
      )}
      data-testid="composer-chip"
    >
      <div className="relative h-10 w-10 overflow-hidden rounded-md bg-background">
        {image.previewUrl ? (
          <img
            src={image.previewUrl}
            alt=""
            aria-hidden
            loading="eager"
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <FileSystemIcon name={image.file.name} />
          </div>
        )}
        {image.status === "encoding" ? (
          <div
            className="absolute inset-0 flex items-center justify-center bg-background/60"
            aria-label={labelEncoding}
          >
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col text-[11.5px] leading-4">
        <span className="truncate max-w-[14rem] font-medium" title={image.file.name}>
          {image.file.name}
        </span>
        <span className="truncate text-muted-foreground">
          {image.status === "error" && image.error
            ? formatError(image.error)
            : sizeLabel}
        </span>
      </div>
      <button
        type="button"
        ref={registerRef}
        onClick={onRemove}
        onKeyDown={onKeyDown}
        aria-label={labelRemove}
        className={cn(
          "ml-1 grid h-5 w-5 flex-none place-items-center rounded-full",
          "text-muted-foreground/80 hover:bg-foreground/8 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
        )}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
