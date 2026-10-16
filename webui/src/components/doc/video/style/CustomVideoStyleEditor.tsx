import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, ImagePlus, Loader2, PanelRightClose, PanelRightOpen, Save, X } from "lucide-react";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useClipboardAndDrop } from "@/hooks/useClipboardAndDrop";
import { cn } from "@/lib/utils";

export type CustomVideoStyleAspectRatio = "16:9" | "9:16" | "1:1";
export type CustomVideoStyleField = "primaryColor" | "backgroundColor" | "fontFamily";

export interface CustomVideoStyleEditorProps {
  name: string;
  onNameChange: (name: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
  referencePaths: string[];
  referencePreviews?: Record<string, string>;
  onReferenceFiles?: (files: File[]) => void;
  onAddReference: () => void;
  onRemoveReference: (path: string) => void;
  baseStyle?: { name: string; posterUrl?: string };
  sample?: { html: string; duration: number; revision?: number } | null;
  busy: boolean;
  status?: string;
  error?: string;
  onRetry?: () => void | Promise<void>;
  saving: boolean;
  onGenerate: () => void | Promise<void>;
  generationDisabled?: boolean;
  onSave: () => void;
  onBack: () => void;
  backDisabled?: boolean;
  onStop?: () => void;
  canSave: boolean;
  sampleNeedsUpdate?: boolean;
  style: {
    primaryColor: string;
    backgroundColor: string;
    fontFamily: string;
  };
  editableFields?: CustomVideoStyleField[];
  onStyleChange: (patch: Partial<CustomVideoStyleEditorProps["style"]>) => void;
  chat?: ReactNode;
  actions?: ReactNode;
  modelControl?: ReactNode;
  onChatVisibleChange?: (visible: boolean) => void;
  saveLabel?: "保存并使用" | "保存风格";
  conversationStarted?: boolean;
  openConversationRequest?: number;
  aspectRatio?: CustomVideoStyleAspectRatio;
  onAspectRatioChange?: (aspectRatio: CustomVideoStyleAspectRatio) => void;
}

const ASPECT_OPTIONS: Array<{ value: CustomVideoStyleAspectRatio; label: string }> = [
  { value: "16:9", label: "横屏（16:9）" },
  { value: "9:16", label: "竖屏（9:16）" },
  { value: "1:1", label: "方形（1:1）" },
];

const FONT_OPTIONS = [
  { value: "Noto Sans SC", label: "现代黑体" },
  { value: "Noto Serif SC", label: "现代宋体" },
  { value: "Microsoft YaHei", label: "微软雅黑" },
  { value: "SimHei", label: "经典黑体" },
  { value: "KaiTi", label: "楷体" },
];

function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

const ignoreReferenceFiles = (_files: File[]) => {};

export function CustomVideoStyleEditor({
  name,
  onNameChange,
  description,
  onDescriptionChange,
  referencePaths,
  referencePreviews,
  onReferenceFiles,
  onAddReference,
  onRemoveReference,
  baseStyle,
  sample,
  busy,
  status,
  error,
  onRetry,
  saving,
  onGenerate,
  generationDisabled,
  onSave,
  onBack,
  backDisabled,
  onStop,
  canSave,
  sampleNeedsUpdate,
  style,
  editableFields,
  onStyleChange,
  chat,
  actions,
  modelControl,
  onChatVisibleChange,
  saveLabel = "保存风格",
  conversationStarted,
  openConversationRequest,
  aspectRatio = "16:9",
  onAspectRatioChange,
}: CustomVideoStyleEditorProps) {
  const initiallyStarted = Boolean(conversationStarted || sample);
  const [started, setStarted] = useState(initiallyStarted);
  const [activePanelTab, setActivePanelTab] = useState<"conversation" | "style">(
    initiallyStarted ? "conversation" : "style",
  );
  const [panelOpen, setPanelOpen] = useState(initiallyStarted);
  const [generatePending, setGeneratePending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localAspectRatio, setLocalAspectRatio] = useState(aspectRatio);
  const rightPanelRef = useRef<PanelImperativeHandle | null>(null);
  const previewCanvasRef = useRef<HTMLDivElement | null>(null);
  const [previewCanvasSize, setPreviewCanvasSize] = useState({ width: 0, height: 0 });
  const referenceDrop = useClipboardAndDrop(onReferenceFiles ?? ignoreReferenceFiles);
  const readyFromProps = Boolean(conversationStarted || sample);
  const previousReady = useRef(readyFromProps);
  const conversationReady = started || readyFromProps || Boolean(openConversationRequest && openConversationRequest > 0);
  const chatVisible = panelOpen && activePanelTab === "conversation" && conversationReady;
  const hasSample = Boolean(sample?.html.trim());
  const canGenerate = Boolean(description.trim() || referencePaths.length || baseStyle);
  const selectedAspect = onAspectRatioChange ? aspectRatio : localAspectRatio;
  const [aspectWidth, aspectHeight] = selectedAspect.split(":").map(Number);
  const previewWidth = Math.min(
    previewCanvasSize.width,
    Math.min(previewCanvasSize.height, 720) * aspectWidth / aspectHeight,
    1152,
  );
  const previewHeight = previewWidth * aspectHeight / aspectWidth;
  const fields = editableFields ?? ["primaryColor", "backgroundColor", "fontFamily"];
  const fontOptions = style.fontFamily && !FONT_OPTIONS.some((item) => item.value === style.fontFamily)
    ? [...FONT_OPTIONS, { value: style.fontFamily, label: style.fontFamily }]
    : FONT_OPTIONS;

  useEffect(() => {
    if (readyFromProps && !previousReady.current) {
      setStarted(true);
      setPanelOpen(true);
      setActivePanelTab("conversation");
      setGeneratePending(false);
      setLocalError(null);
    }
    if (error && !readyFromProps) setGeneratePending(false);
    previousReady.current = readyFromProps;
  }, [error, readyFromProps]);

  useEffect(() => {
    if (!openConversationRequest || openConversationRequest < 1) return;
    setStarted(true);
    setPanelOpen(true);
    setActivePanelTab("conversation");
  }, [openConversationRequest]);

  useLayoutEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    if (panelOpen) panel.expand();
    else panel.collapse();
  }, [panelOpen]);

  useLayoutEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setPreviewCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    onChatVisibleChange?.(chatVisible);
  }, [chatVisible, onChatVisibleChange]);

  useEffect(
    () => () => onChatVisibleChange?.(false),
    [onChatVisibleChange],
  );

  const runGeneration = (action: () => void | Promise<void>) => {
    if (busy || generatePending || generationDisabled) return;
    setGeneratePending(true);
    setLocalError(null);
    try {
      const result = action();
      if (result && typeof result.then === "function") {
        void result
          .catch(() => setLocalError("未能开始制作样片，请重试。"))
          .finally(() => setGeneratePending(false));
      }
    } catch {
      setGeneratePending(false);
      setLocalError("未能开始制作样片，请重试。");
    }
  };

  const handleGenerate = () => {
    if (!canGenerate) return;
    runGeneration((error || localError) && onRetry ? onRetry : onGenerate);
  };

  const handleRetry = () => {
    runGeneration(onRetry ?? onGenerate);
  };

  const handleAspectChange = (value: string) => {
    const next = value as CustomVideoStyleAspectRatio;
    if (!onAspectRatioChange) setLocalAspectRatio(next);
    onAspectRatioChange?.(next);
  };

  const visibleError = error ?? localError;

  const togglePanel = () => {
    setPanelOpen((open) => {
      if (!open) {
        setActivePanelTab(conversationReady ? "conversation" : "style");
      }
      return !open;
    });
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 px-2" onClick={onBack} disabled={backDisabled}>
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          返回
        </Button>
        <Input
          aria-label="风格名称"
          disabled={busy || saving}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="未命名风格"
          className="h-9 min-w-0 max-w-64 flex-1 text-caption"
        />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {modelControl}
          {hasSample ? (
            <Button
              type="button"
              size="sm"
              disabled={!canSave || saving || busy}
              onClick={onSave}
            >
              {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
              {saveLabel}
            </Button>
          ) : null}
          {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={panelOpen ? "收起侧栏" : "打开侧栏"}
            aria-expanded={panelOpen}
            onClick={togglePanel}
          >
            {panelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </Button>
        </div>
      </header>

      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        <ResizablePanel id="custom-video-style-preview" minSize="320px" className="min-h-0 min-w-0 overflow-hidden">
          <main className="flex h-full min-h-0 min-w-0 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-3">
              {(hasSample || busy) ? (
                <label className="flex items-center gap-2 text-micro text-muted-foreground">
                  画幅
                  <Select
                    aria-label="画幅"
                    value={selectedAspect}
                    onValueChange={handleAspectChange}
                    options={ASPECT_OPTIONS}
                    disabled={busy || saving}
                    className="h-8 w-36 text-caption"
                  />
                </label>
              ) : <span className="text-caption font-medium">新建风格</span>}
              <span aria-live="polite" className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
                {busy
                  ? status || (hasSample ? "正在更新样片…" : "正在制作样片…")
                  : status || (hasSample && sampleNeedsUpdate ? "样片更新后可保存" : "")}
              </span>
              {hasSample ? <span className="shrink-0 text-micro text-muted-foreground">样片 · {Math.round(sample?.duration ?? 0)} 秒</span> : null}
              {busy && onStop ? (
                <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={onStop}>
                  停止
                </Button>
              ) : null}
            </div>

            <div ref={previewCanvasRef} className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-4">
              {hasSample ? (
                <div
                  className="relative min-h-0 min-w-0 shrink-0 overflow-hidden bg-black"
                  style={{ width: previewWidth, height: previewHeight, aspectRatio: `${aspectWidth} / ${aspectHeight}` }}
                >
                  <iframe
                    title="风格样片预览"
                    srcDoc={sample?.html}
                    sandbox="allow-scripts allow-same-origin"
                    className="absolute inset-0 h-full w-full border-0"
                  />
                </div>
              ) : !started ? (
                <div
                  className={cn("w-full max-w-2xl space-y-5", referenceDrop.isDragging && "rounded-md bg-muted/30")}
                  onPaste={onReferenceFiles ? referenceDrop.onPaste : undefined}
                  onDragEnter={onReferenceFiles ? referenceDrop.onDragEnter : undefined}
                  onDragOver={onReferenceFiles ? referenceDrop.onDragOver : undefined}
                  onDragLeave={onReferenceFiles ? referenceDrop.onDragLeave : undefined}
                  onDrop={onReferenceFiles ? referenceDrop.onDrop : undefined}
                >
                  <section className="space-y-2">
                    <label htmlFor="custom-style-description" className="block text-ui font-medium">描述想要的风格</label>
                    <Textarea
                      id="custom-style-description"
                      disabled={busy || saving}
                      value={description}
                      onChange={(event) => onDescriptionChange(event.target.value)}
                      placeholder="例如：温暖的纸张质感，用图形解释概念，动画自然，少一些装饰。"
                      rows={4}
                      className="min-h-24 resize-y"
                    />
                  </section>

                  <section aria-label="参考图" className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" size="sm" className="h-8" disabled={busy || saving} onClick={onAddReference}>
                      <ImagePlus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      添加参考图
                    </Button>
                    {referencePaths.map((path) => (
                      <span key={path} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-caption">
                        {referencePreviews?.[path] ? (
                          <img src={referencePreviews[path]} alt="" className="h-7 w-7 shrink-0 rounded-sm object-cover" />
                        ) : null}
                        <span className="max-w-56 truncate">{fileName(path)}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          aria-label={`移除参考图 ${fileName(path)}`}
                          disabled={busy || saving}
                          onClick={() => onRemoveReference(path)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </span>
                    ))}
                  </section>

                  {baseStyle ? (
                    <section aria-label="起始风格" className="flex items-center gap-3 rounded-md border border-border/70 p-3">
                      {baseStyle.posterUrl ? (
                        <img src={baseStyle.posterUrl} alt="" className="h-12 w-20 shrink-0 rounded-sm object-cover" />
                      ) : null}
                      <div className="min-w-0">
                        <div className="text-micro text-muted-foreground">起始风格</div>
                        <div className="truncate text-caption font-medium">{baseStyle.name}</div>
                      </div>
                    </section>
                  ) : null}

                  {visibleError ? (
                    <div className="text-caption text-destructive" role="alert">{visibleError}</div>
                  ) : null}

                  <div className="flex justify-end">
                    <Button type="button" disabled={!canGenerate || busy || generatePending || generationDisabled} onClick={handleGenerate}>
                      {generatePending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                      {generatePending ? "正在准备…" : visibleError ? "重试生成" : "生成样片"}
                    </Button>
                  </div>
                </div>
              ) : busy ? (
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="正在制作样片" />
              ) : visibleError ? (
                <div className="max-w-lg rounded-md border border-destructive/30 bg-destructive/[0.04] p-4 text-caption" role="alert">
                  <p className="text-destructive">{visibleError}</p>
                  <Button type="button" variant="outline" size="sm" className="mt-3" onClick={handleRetry} disabled={generatePending || generationDisabled}>
                    重试
                  </Button>
                </div>
              ) : (
                <div className="space-y-3 text-center">
                  <p className="text-caption text-muted-foreground">样片完成后会显示在这里。</p>
                  <Button type="button" variant="outline" size="sm" onClick={handleRetry} disabled={generatePending || generationDisabled}>
                    {generatePending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    {generatePending ? "正在准备…" : "重新生成样片"}
                  </Button>
                </div>
              )}
            </div>
          </main>
        </ResizablePanel>

        {panelOpen ? <ResizableHandle aria-label="调整侧栏宽度" /> : null}
        <ResizablePanel
          id="custom-video-style-sidebar"
          panelRef={rightPanelRef}
          collapsible
          collapsedSize="0px"
          defaultSize="360px"
          minSize="260px"
          maxSize="520px"
          groupResizeBehavior="preserve-pixel-size"
          aria-hidden={!panelOpen}
          className="min-h-0 min-w-0 overflow-hidden"
        >
          <aside aria-label="风格辅助面板" inert={!panelOpen} className="flex h-full min-h-0 min-w-0 flex-col bg-background">
            <Tabs
              value={activePanelTab}
              onValueChange={(value) => setActivePanelTab(value as "conversation" | "style")}
              className="flex h-full min-h-0 flex-col"
            >
              <div className="flex h-10 shrink-0 items-center border-b border-border/70 px-3">
                <TabsList className="h-8 bg-transparent p-0">
                  {conversationReady ? <TabsTrigger value="conversation" className="h-8 px-3">对话</TabsTrigger> : null}
                  <TabsTrigger value="style" className="h-8 px-3">样式</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent
                value="conversation"
                forceMount
                style={{ display: activePanelTab === "conversation" ? "block" : "none" }}
                className="m-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:mt-0"
              >
                <div
                  data-testid="custom-video-style-chat-content"
                  aria-hidden={!chatVisible}
                  className="h-full min-h-0"
                  style={{ display: chatVisible ? "block" : "none" }}
                >
                  {chat}
                </div>
              </TabsContent>

              <TabsContent value="style" className="m-0 min-h-0 flex-1 overflow-y-auto p-4 data-[state=inactive]:mt-0">
                <div className="space-y-4">
                  {fields.length === 0 ? (
                    <p className="text-caption text-muted-foreground">可以在对话中说明想调整的样式。</p>
                  ) : null}
                  {fields.includes("primaryColor") ? (
                    <label className="flex items-center justify-between gap-3 text-caption">
                      <span>主题色</span>
                      <Input
                        aria-label="主题色"
                        disabled={busy || saving}
                        type="color"
                        value={style.primaryColor}
                        onChange={(event) => onStyleChange({ primaryColor: event.target.value })}
                        className="h-9 w-12 cursor-pointer p-1"
                      />
                    </label>
                  ) : null}
                  {fields.includes("backgroundColor") ? (
                    <label className="flex items-center justify-between gap-3 text-caption">
                      <span>背景色</span>
                      <Input
                        aria-label="背景色"
                        disabled={busy || saving}
                        type="color"
                        value={style.backgroundColor}
                        onChange={(event) => onStyleChange({ backgroundColor: event.target.value })}
                        className="h-9 w-12 cursor-pointer p-1"
                      />
                    </label>
                  ) : null}
                  {fields.includes("fontFamily") ? (
                    <label className="block space-y-1.5 text-caption">
                      <span>字体</span>
                      <Select
                        aria-label="字体"
                        disabled={busy || saving}
                        value={style.fontFamily}
                        onValueChange={(fontFamily) => onStyleChange({ fontFamily })}
                        options={fontOptions}
                        className="h-9 text-caption"
                      />
                    </label>
                  ) : null}
                </div>
              </TabsContent>
            </Tabs>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
