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

import { MarkdownText, preloadMarkdownText } from "@/components/MarkdownText";
import {
  Activity,
  ArrowUp,
  AtSign,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Folder,
  Globe,
  History,
  ImageIcon,
  Layers,
  Loader2,
  Mail,
  Plus,
  RotateCw,
  Settings,
  Sparkles,
  Square,
  SquarePen,
  Target,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { OfficeDocChip } from "@/components/doc/office/OfficeDocChip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useAttachedImages,
  type AttachedImage,
  type AttachmentError,
  MAX_IMAGES_PER_MESSAGE,
} from "@/hooks/useAttachedImages";
import { useClipboardAndDrop } from "@/hooks/useClipboardAndDrop";
import type { SendImage, SendOptions } from "@/hooks/useMonaStream";
import type { PendingMessage } from "@/hooks/usePendingQueue";
import type { RoomAgentInfo, SlashCommand, GoalStateWsPayload } from "@/lib/types";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { PendingQueueStrip } from "@/components/thread/PendingQueueStrip";

const IMAGE_ACCEPT_ATTR = "image/png,image/jpeg,image/webp,image/gif";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ComposerModelOption {
  provider: string;
  providerLabel: string;
  model: string;
  label: string;
  free: boolean;
  active: boolean;
}

export type ComposerAttachment = File | { name: string; localPath: string };

interface ThreadComposerProps {
  onSend: (content: string, images?: SendImage[], options?: SendOptions) => void;
  disabled?: boolean;
  placeholder?: string;
  isStreaming?: boolean;
  modelLabel?: string | null;
  modelOptions?: ComposerModelOption[];
  onModelSwitch?: (provider: string, model: string) => void;
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
  /** Pending message queue for mid-turn staging. */
  pendingMessages?: PendingMessage[];
  onPendingAppend?: (id: string) => void;
  onPendingRemove?: (id: string) => void;
  onPendingEdit?: (id: string, content: string) => void;
  isPendingFull?: boolean;
  /** Room members offered by the ``@`` picker (multi-agent guide 7.5). When
   * empty the picker is disabled (direct chats). */
  mentionableAgents?: RoomAgentInfo[];
  documents?: Array<{ name: string; path: string; size?: number }>;
  documentsUploading?: boolean;
  documentUploadError?: string | null;
  onAddDocuments?: (files: ComposerAttachment[]) => void;
  onRemoveDocument?: (path: string) => void;
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

interface HeroPromptChip {
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
}: {
  startedAt: number | null;
  goalState?: GoalStateWsPayload;
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

  const ariaParts = [timerTitle, showGoal ? stripLabel : null].filter(Boolean);
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
          {timerTitle ? <span className="shrink-0">{timerTitle}</span> : null}
          {timerTitle && showGoal ? (
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
  onSend,
  disabled,
  placeholder,
  isStreaming = false,
  modelLabel = null,
  modelOptions = [],
  onModelSwitch,
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
  mentionableAgents = [],
  documents = [],
  documentsUploading = false,
  documentUploadError = null,
  onAddDocuments,
  onRemoveDocument,
}: ThreadComposerProps) {
  const { t } = useTranslation();
  const attachLabel = t(onAddDocuments ? "thread.composer.attachFile" : "thread.composer.attachImage");
  const [value, setValue] = useState("");
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [nativeDragging, setNativeDragging] = useState(false);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const isHero = variant === "hero";
  const groupedModelOptions = useMemo(() => {
    const groups = new Map<string, { label: string; options: ComposerModelOption[] }>();
    for (const option of modelOptions) {
      const group = groups.get(option.provider);
      if (group) group.options.push(option);
      else groups.set(option.provider, { label: option.providerLabel, options: [option] });
    }
    return [...groups.entries()];
  }, [modelOptions]);
  const resolvedPlaceholder = isStreaming
    ? t("thread.composer.placeholderStreaming")
    : placeholder ?? t("thread.composer.placeholderThread");

  const { images, enqueue, remove, clear, encoding, full } =
    useAttachedImages();

  const formatRejection = useCallback(
    (reason: AttachmentError): string => {
      const key = `thread.composer.imageRejected.${reason}`;
      return t(key, { max: MAX_IMAGES_PER_MESSAGE });
    },
    [t],
  );

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
      if (files.length === 0 || disabled || documentsUploading) return;
      if (!onAddDocuments) {
        addFiles(files);
        return;
      }
      const images = imageInputEnabled
        ? files.filter((file) => file.type.startsWith("image/"))
        : [];
      const attachments = files.filter((file) => !images.includes(file));
      if (images.length > 0) addFiles(images);
      if (attachments.length > 0) onAddDocuments(attachments);
    },
    [addFiles, disabled, documentsUploading, imageInputEnabled, onAddDocuments],
  );

  const {
    isDragging,
    onPaste,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  } = useClipboardAndDrop(addAttachments, { acceptAllFiles: Boolean(onAddDocuments) });

  const desktopFileDropEnabled = Boolean(onAddDocuments) && isTauri();

  useEffect(() => {
    if (!desktopFileDropEnabled || !onAddDocuments) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    const isInsideComposer = (position: { x: number; y: number }) => {
      const rect = formRef.current?.getBoundingClientRect();
      if (!rect) return false;
      const dpr = window.devicePixelRatio || 1;
      const x = position.x / dpr;
      const y = position.y / dpr;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (!active) return;
        switch (event.payload.type) {
          case "enter":
          case "over":
            if ("position" in event.payload) setNativeDragging(isInsideComposer(event.payload.position));
            break;
          case "leave":
            setNativeDragging(false);
            break;
          case "drop":
            setNativeDragging(false);
            if (!("paths" in event.payload) || !("position" in event.payload)) return;
            if (!isInsideComposer(event.payload.position) || event.payload.paths.length === 0) return;
            onAddDocuments(event.payload.paths.map((localPath) => ({
              localPath,
              name: localPath.replace(/\\/g, "/").split("/").at(-1) || localPath,
            })));
            break;
        }
      }))
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
    };
  }, [desktopFileDropEnabled, onAddDocuments]);

  useEffect(() => {
    if (disabled) return;
    const el = textareaRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => el.focus());
    return () => cancelAnimationFrame(id);
  }, [disabled]);

  const readyImages = useMemo(
    () => images.filter((img): img is AttachedImage & { dataUrl: string } =>
      img.status === "ready" && typeof img.dataUrl === "string",
    ),
    [images],
  );
  const hasErrors = images.some((img) => img.status === "error");

  const canSend =
    !disabled
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
      el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
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
      const pos = markerIdx >= 0 ? markerIdx : text.length;
      el.focus();
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

  const submit = useCallback(() => {
    if (!canSend) return;
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
    onSend(
      trimmed,
      payload,
      targetAgentIds.length > 0 ? { targetAgentIds } : undefined,
    );
    mentionedRef.current.clear();
    setValue("");
    setInlineError(null);
    // Bubble owns the data URL copy; safe to revoke every staged blob
    // preview here without affecting the rendered message.
    clear();
    setSlashMenuDismissed(false);
    setMention(null);
    resizeTextarea();
  }, [canSend, clear, onSend, readyImages, resizeTextarea, value]);

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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onInput: React.FormEventHandler<HTMLTextAreaElement> = (e) => {
    const el = e.currentTarget;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  };

  const onFilePick: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    addAttachments(files);
  };

  const openAttachmentPicker = useCallback(async () => {
    if (!onAddDocuments || !isTauri()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: true, directory: false, title: "添加文件" });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (paths.length === 0) return;
      onAddDocuments(paths.map((localPath) => ({
        localPath,
        name: localPath.replace(/\\/g, "/").split("/").at(-1) || localPath,
      })));
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : "选择文件失败");
    }
  }, [onAddDocuments]);

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

  const attachButtonDisabled = disabled || documentsUploading || (full && !onAddDocuments) || (!imageInputEnabled && !onAddDocuments);
  const showStopButton = isStreaming && !!onStop;

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragEnter={desktopFileDropEnabled ? undefined : onDragEnter}
      onDragOver={desktopFileDropEnabled ? undefined : onDragOver}
      onDragLeave={desktopFileDropEnabled ? undefined : onDragLeave}
      onDrop={desktopFileDropEnabled ? undefined : onDrop}
      className={cn("relative w-full", isHero ? "px-0" : "px-1 pb-1.5 pt-1 sm:px-0")}
    >
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
        <div className="mx-auto mb-2.5 flex w-full max-w-[58rem] flex-wrap gap-2">
          {HERO_PROMPT_CHIPS.map((chip) => {
            const Icon = chip.Icon;
            return (
              <button
                key={chip.label}
                type="button"
                onClick={() => applyHeroChip(chip)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-3",
                  "border-border/55 bg-muted/40 text-[12px] font-medium text-foreground/75",
                  "hover:bg-muted hover:text-foreground transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <Icon className={cn("h-3.5 w-3.5", chip.iconClass)} aria-hidden />
                {chip.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        className={cn(
          "relative mx-auto flex w-full flex-col overflow-visible transition-all duration-200",
          isHero
            ? "max-w-[58rem] rounded-2xl border border-border/60 bg-card dark:border-white/10"
            : "max-w-[49.5rem] rounded-2xl border border-border/60 bg-card dark:border-white/10",
          "focus-within:ring-1 focus-within:ring-foreground/8",
          disabled && "opacity-60",
          (isDragging || nativeDragging) && "ring-2 ring-primary/40 motion-reduce:ring-0 motion-reduce:border-primary",
          goalState?.active &&
            "goal-shell-glow ring-1 ring-sky-400/35 motion-reduce:ring-sky-400/25 dark:ring-sky-400/45",
        )}
      >
        {images.length > 0 || documents.length > 0 ? (
          <div
            className="flex flex-wrap gap-2 px-3 pt-3"
            aria-label={attachLabel}
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
                onRemove={onRemoveDocument ? () => onRemoveDocument(document.path) : undefined}
              />
            ))}
          </div>
        ) : null}
        {runStartedAt != null || goalState?.active ? (
          <RunElapsedStrip startedAt={runStartedAt} goalState={goalState} />
        ) : null}
        <PendingQueueStrip
          messages={pendingMessages}
          onAppend={onPendingAppend ?? (() => {})}
          onRemove={onPendingRemove ?? (() => {})}
          onEdit={(id) => {
            const msg = pendingMessages.find((m) => m.id === id);
            if (msg) {
              setValue(msg.content);
              onPendingRemove?.(id);
              resizeTextarea();
              textareaRef.current?.focus();
            }
          }}
          isFull={isPendingFull}
        />
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
          aria-label={t("thread.composer.inputAria")}
          className={cn(
            "w-full resize-none bg-transparent",
            isHero
              ? "min-h-[78px] px-5 pb-2 pt-5 text-[15px] leading-6"
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
            "flex items-center justify-between gap-2",
            isHero ? "px-4 pb-4" : "px-3 pb-2",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={onAddDocuments ? undefined : IMAGE_ACCEPT_ATTR}
              multiple
              hidden
              onChange={onFilePick}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={attachButtonDisabled}
              aria-label={attachLabel}
              title={
                !imageInputEnabled && !onAddDocuments
                  ? t("thread.composer.imageNotSupported")
                  : attachLabel
              }
              onClick={() => void openAttachmentPicker()}
              className={cn(
                "rounded-full text-muted-foreground hover:text-foreground",
                isHero
                  ? "h-7 w-7 border border-border/55 bg-card hover:bg-card"
                  : "h-6 w-6 border border-border/55 bg-card hover:bg-card",
              )}
            >
              <Plus className={cn(isHero ? "h-4 w-4" : "h-3.5 w-3.5")} />
            </Button>
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
            {modelLabel ? (
              modelOptions.length > 0 && onModelSwitch ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      title={modelLabel}
                      className={cn(
                        "inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5",
                        "border-foreground/10 bg-foreground/[0.035] font-medium text-foreground/80",
                        "hover:bg-foreground/[0.07] transition-colors cursor-pointer",
                        isHero
                          ? "h-7 max-w-[13rem] text-[12px]"
                          : "h-6 max-w-[10rem] text-[10.5px]",
                      )}
                    >
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 flex-none rounded-full bg-emerald-500/80"
                      />
                      <span className="truncate">{modelLabel}</span>
                      <ChevronDown className={cn("flex-none opacity-50", isHero ? "h-3 w-3" : "h-2.5 w-2.5")} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" side="top" className="max-h-[min(60vh,420px)] min-w-[240px] overflow-y-auto">
                    {groupedModelOptions.map(([provider, group]) => (
                      <DropdownMenuGroup key={provider}>
                        <DropdownMenuLabel className="pb-1 text-[11px] font-medium text-muted-foreground">
                          {group.label}
                        </DropdownMenuLabel>
                        {group.options.map((option) => (
                          <DropdownMenuItem
                            key={`${option.provider}/${option.model}`}
                            className="flex items-center gap-2 text-[13px]"
                            onSelect={() => onModelSwitch(option.provider, option.model)}
                          >
                            <span
                              aria-hidden
                              className={cn(
                                "h-1.5 w-1.5 flex-none rounded-full",
                                option.free ? "bg-[hsl(var(--brand-blue)/0.8)]" : "bg-emerald-500/80",
                              )}
                            />
                            <span className="min-w-0 flex-1 truncate">{option.label}</span>
                            {option.free ? <span className="text-[10px] text-muted-foreground">免费</span> : null}
                            {option.active ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="当前模型" /> : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    ))}
                    {onOpenSettings ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="flex items-center gap-2 text-[13px] text-muted-foreground"
                          onSelect={() => onOpenSettings("models_providers")}
                        >
                          <Settings className="h-3.5 w-3.5" />
                          <span>{t("thread.composer.addModel", "添加模型")}</span>
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span
                  title={modelLabel}
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5",
                    "border-foreground/10 bg-foreground/[0.035] font-medium text-foreground/80",
                    isHero
                      ? "h-7 max-w-[13rem] text-[12px]"
                      : "h-6 max-w-[10rem] text-[10.5px]",
                  )}
                >
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 flex-none rounded-full bg-emerald-500/80"
                  />
                  <span className="truncate">{modelLabel}</span>
                </span>
              )
            ) : null}
            {!isHero ? (
              <span className="hidden select-none text-[10.5px] text-muted-foreground/60 sm:inline">
                {t("thread.composer.sendHint")}
              </span>
            ) : null}
          </div>
          <span className={cn(isHero ? "hidden" : "sm:hidden")} aria-hidden />
          <Button
            type={showStopButton ? "button" : "submit"}
            size="icon"
            disabled={showStopButton ? disabled : !canSend}
            aria-label={showStopButton ? t("thread.composer.stop") : t("thread.composer.send")}
            onClick={showStopButton ? onStop : undefined}
            className={cn(
              "rounded-full transition-transform",
              showStopButton
                ? "border border-border/70 bg-card text-foreground/85 hover:bg-muted/65 hover:text-foreground disabled:text-muted-foreground/50"
                : isHero
                  ? "border border-foreground bg-foreground text-background hover:bg-foreground/90 disabled:border-foreground/35 disabled:bg-foreground/35 disabled:text-background/80"
                  : "border border-foreground bg-foreground text-background hover:bg-foreground/90 disabled:border-foreground/35 disabled:bg-foreground/35 disabled:text-background/80",
              isHero ? "" : "h-7.5 w-7.5",
              (canSend || showStopButton) && "hover:scale-[1.03] active:scale-95",
            )}
          >
            {showStopButton ? (
              <Square className={cn("fill-current stroke-current", isHero ? "h-3 w-3" : "h-2.5 w-2.5")} />
            ) : isStreaming ? (
              <Loader2 className={cn(isHero ? "h-4.5 w-4.5" : "h-4 w-4", "animate-spin")} />
            ) : (
              <ArrowUp className={cn(isHero ? "h-4.5 w-4.5" : "h-4 w-4")} />
            )}
          </Button>
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
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled || picking}
          onClick={pickWorkspace}
          title={workspace}
          className={cn(
            "inline-flex min-w-0 h-7 items-center gap-1.5 rounded-lg border px-2.5",
            "border-border/60 bg-muted/60 text-[12px] font-medium text-foreground/80",
            "hover:bg-muted/80 transition-colors cursor-pointer",
            (disabled || picking) && "pointer-events-none opacity-55",
          )}
        >
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate max-w-[12rem]">{basename}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
        </button>
        <button
          type="button"
          onClick={clearWorkspace}
          disabled={disabled || picking}
          aria-label={t("thread.composer.workspace.clear")}
          className={cn(
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            "text-muted-foreground/80 hover:bg-muted/70 hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            (disabled || picking) && "pointer-events-none opacity-55",
          )}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled || picking}
      onClick={pickWorkspace}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5",
        "border-transparent bg-muted/80 text-[12px] font-medium text-foreground/65",
        "hover:bg-muted transition-colors cursor-pointer",
        (disabled || picking) && "pointer-events-none opacity-55",
      )}
    >
      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
      <span>{t("thread.composer.workspace.placeholder")}</span>
      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
    </button>
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
            <ImageIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
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
