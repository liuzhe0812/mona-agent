import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Volume2,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/providers/ClientProvider";
import {
  addVideoScene,
  deleteVideoScene,
  fetchSceneNarrationBytes,
  fetchVideoStoryboard,
  lockVideoStoryboard,
  reorderVideoScenes,
  updateVideoScene,
  type VideoScene,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface StoryboardPhaseProps {
  projectName: string;
  onLocked: () => void;
  /** Incremented by parent when AI finishes a reply (streaming → false). */
  refreshTrigger?: number;
  /** 项目已过分镜锁定阶段（制作/导出中回看编辑）：底部按钮变为「返回制作」，
   * 不再重复调用锁定 API，避免服务端 phase 回退。 */
  alreadyLocked?: boolean;
  /** 右侧 AI 对话面板，作为第三栏渲染（可拖拽调整宽度）。 */
  chatPanel?: ReactNode;
}

export function StoryboardPhase({ projectName, onLocked, refreshTrigger, alreadyLocked = false, chatPanel }: StoryboardPhaseProps) {
  const { client, token } = useClient();
  const [scenes, setScenes] = useState<VideoScene[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [locking, setLocking] = useState(false);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // null = unknown, true = storyboard.md exists, false = not yet
  const [storyboardExists, setStoryboardExists] = useState<boolean | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Save queue: per-scene pending field edits, merged and sent serially.
  const pendingRef = useRef<Map<number, Partial<VideoScene>>>(new Map());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainPromiseRef = useRef<Promise<boolean> | null>(null);
  const savedHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Drain pending edits serially. New edits arriving during the drain are
  // merged into the map and picked up by the loop. Returns true when all
  // pending edits were persisted.
  const flushSaves = useCallback((): Promise<boolean> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (drainPromiseRef.current) return drainPromiseRef.current;
    if (pendingRef.current.size === 0) return Promise.resolve(true);
    const p = (async (): Promise<boolean> => {
      setSaveState("saving");
      let ok = true;
      while (pendingRef.current.size > 0) {
        const [index, fields] = pendingRef.current.entries().next().value as [
          number,
          Partial<VideoScene>,
        ];
        pendingRef.current.delete(index);
        try {
          const res = await updateVideoScene(token, projectName, { index, ...fields });
          if (!res.ok) throw new Error(res.error || "save failed");
        } catch (e) {
          console.error("Failed to save scene", e);
          // Restore failed fields, keeping newer edits (they win on conflict)
          const newer = pendingRef.current.get(index) ?? {};
          pendingRef.current.set(index, { ...fields, ...newer });
          ok = false;
          break;
        }
      }
      drainPromiseRef.current = null;
      if (!mountedRef.current) return ok && pendingRef.current.size === 0;
      if (ok && pendingRef.current.size === 0) {
        setSaveState("saved");
        if (savedHideTimerRef.current) clearTimeout(savedHideTimerRef.current);
        savedHideTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setSaveState("idle");
        }, 1500);
      } else {
        setSaveState("error");
      }
      return ok && pendingRef.current.size === 0;
    })();
    drainPromiseRef.current = p;
    return p;
  }, [token, projectName]);

  // Flush pending saves when switching away or unmounting (best effort).
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (pendingRef.current.size > 0) void flushSaves();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName]);

  // Load storyboard. Pass silent=true to skip error UI (used by polling).
  // Errors are always logged to console for diagnosis — never silently swallowed.
  // Server truth is merged with unsaved local edits so a reload never clobbers input.
  const loadScenes = useCallback(async (silent = false) => {
    if (!silent) setError(null);
    try {
      const res = await fetchVideoStoryboard(token, projectName);
      setStoryboardExists(res.storyboardExists ?? null);
      setParseError(res.parseError ?? null);
      if (res.ok && res.scenes) {
        let next = res.scenes;
        if (pendingRef.current.size > 0) {
          next = next.map((s) => {
            const pending = pendingRef.current.get(s.index);
            return pending ? { ...s, ...pending } : s;
          });
        }
        setScenes(next);
        if (next.length > 0 && !next.some((s) => s.index === selectedIndex)) {
          setSelectedIndex(next[0].index);
        }
      } else if (!silent && res.error) {
        setError(res.error);
      }
      if (!res.ok) {
        console.warn("[StoryboardPhase] API returned error:", res.error);
      }
    } catch (e) {
      console.warn("[StoryboardPhase] loadScenes failed:", e);
      if (!silent) setError(String(e));
    }
  }, [token, projectName, selectedIndex]);

  useEffect(() => {
    loadScenes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, projectName]);

  // AI turn completion trigger — parent increments refreshTrigger when
  // streaming transitions from true → false. This is the primary sync mechanism:
  // when AI finishes its reply, any storyboard.md it wrote is now on disk.
  // 双重刷新：立即刷新 + 800ms 后兜底（应对文件系统 flush 延迟）
  useEffect(() => {
    if (refreshTrigger === undefined || refreshTrigger === 0) return;
    loadScenes(true);
    const t = setTimeout(() => loadScenes(true), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger]);

  // WS subscription: scene changes pushed by the services process (AI rewrote
  // storyboard.md and it got re-parsed, edits from another window, etc).
  // Server state is merged with unsaved local edits inside loadScenes.
  useEffect(() => {
    return client.onVideoProjectChanged(({ projectName: name, hint }) => {
      if (name !== projectName) return;
      if (hint === "scenes") void loadScenes(true);
    });
  }, [client, projectName, loadScenes]);

  // Fallback polling — pure backstop in case both the streaming event and the
  // WS push are missed (e.g. component remount while AI is streaming).
  // Stops once scenes appear or a parse error is detected.
  useEffect(() => {
    if (scenes.length > 0) return;
    if (storyboardExists && parseError) return;
    const timer = setInterval(() => {
      loadScenes(true);
    }, 10000);
    return () => clearInterval(timer);
  }, [scenes.length, storyboardExists, parseError, loadScenes]);

  // Diagnostic: AI finished (refreshTrigger > 0) but scenes still empty after 2s
  // → likely AI failed/refused/was interrupted. Surface this to the user.
  const [aiFinishedEmpty, setAiFinishedEmpty] = useState(false);
  useEffect(() => {
    if (!refreshTrigger || refreshTrigger === 0) return;
    if (scenes.length > 0) {
      setAiFinishedEmpty(false);
      return;
    }
    setAiFinishedEmpty(false);
    const t = setTimeout(() => {
      if (scenes.length === 0) setAiFinishedEmpty(true);
    }, 2000);
    return () => clearTimeout(t);
  }, [refreshTrigger, scenes.length]);

  const selectedScene = scenes.find((s) => s.index === selectedIndex) ?? null;

  // Debounced merge-save: update UI immediately, queue the field, and send
  // one merged request per scene 600ms after typing stops.
  const handleFieldChange = useCallback(
    <K extends keyof VideoScene>(field: K, value: VideoScene[K]) => {
      if (!selectedScene) return;
      const idx = selectedIndex;
      setScenes((prev) =>
        prev.map((s) =>
          s.index === idx ? { ...s, [field]: value } : s,
        ),
      );
      const existing = pendingRef.current.get(idx) ?? {};
      pendingRef.current.set(idx, { ...existing, [field]: value });
      setSaveState("saving");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void flushSaves();
      }, 600);
    },
    [selectedScene, selectedIndex, flushSaves],
  );

  // Switching scenes flushes pending edits for the previous scene first.
  const handleSelectScene = useCallback(
    (index: number) => {
      if (index === selectedIndex) return;
      void flushSaves();
      setSelectedIndex(index);
    },
    [selectedIndex, flushSaves],
  );

  const handleMove = useCallback(
    async (direction: "up" | "down") => {
      const currentIdx = scenes.findIndex((s) => s.index === selectedIndex);
      if (currentIdx < 0) return;
      const targetIdx = direction === "up" ? currentIdx - 1 : currentIdx + 1;
      if (targetIdx < 0 || targetIdx >= scenes.length) return;
      // Indices shift on reorder — persist pending edits first, then drop leftovers.
      await flushSaves();
      pendingRef.current.clear();
      const newOrder = [...scenes];
      [newOrder[currentIdx], newOrder[targetIdx]] = [newOrder[targetIdx], newOrder[currentIdx]];
      const indices = newOrder.map((s) => s.index);
      setScenes(newOrder.map((s, i) => ({ ...s, index: i + 1 })));
      setSelectedIndex(currentIdx + 1 + (direction === "up" ? -1 : 1));
      try {
        const res = await reorderVideoScenes(token, projectName, indices);
        if (res.ok && res.scenes) {
          setScenes(res.scenes);
        } else {
          throw new Error(res.error || "reorder failed");
        }
      } catch (e) {
        console.error("Failed to reorder", e);
        setError("排序保存失败，已重新加载分镜");
        void loadScenes(true);
      }
    },
    [scenes, selectedIndex, token, projectName, loadScenes, flushSaves],
  );

  const handleDelete = useCallback(async () => {
    if (scenes.length <= 1) return;
    if (!selectedScene) return;
    // Indices shift on delete — persist pending edits first, then drop leftovers.
    await flushSaves();
    pendingRef.current.clear();
    try {
      const res = await deleteVideoScene(token, projectName, selectedIndex);
      if (res.ok && res.scenes) {
        setScenes(res.scenes);
        setSelectedIndex(res.scenes[0].index);
      } else {
        throw new Error(res.error || "delete failed");
      }
    } catch (e) {
      console.error("Failed to delete scene", e);
      setError("删除失败，已重新加载分镜");
      void loadScenes(true);
    }
  }, [scenes.length, selectedScene, token, projectName, selectedIndex, loadScenes, flushSaves]);

  const handleAdd = useCallback(async () => {
    try {
      const res = await addVideoScene(token, projectName);
      if (res.ok && res.scene) {
        setScenes((prev) => [...prev, res.scene!]);
        setSelectedIndex(res.scene.index);
      } else {
        throw new Error(res.error || "add failed");
      }
    } catch (e) {
      console.error("Failed to add scene", e);
      setError("新增场景失败，已重新加载分镜");
      void loadScenes(true);
    }
  }, [token, projectName, loadScenes]);

  const handlePlayNarration = useCallback(
    async (index: number) => {
      if (playingIndex !== null) return;
      setPlayingIndex(index);
      try {
        const blob = await fetchSceneNarrationBytes(token, projectName, index);
        if (blob) {
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = () => {
            URL.revokeObjectURL(url);
            setPlayingIndex(null);
          };
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            setPlayingIndex(null);
          };
          await audio.play();
        } else {
          setPlayingIndex(null);
        }
      } catch (e) {
        console.error("Narration playback failed", e);
        setPlayingIndex(null);
      }
    },
    [playingIndex, token, projectName],
  );

  const handleLock = useCallback(async () => {
    setLocking(true);
    setError(null);
    try {
      // Flush pending saves before leaving; block when any edit failed.
      const saved = await flushSaves();
      if (!saved || pendingRef.current.size > 0) {
        setError("有修改尚未保存成功，请先重试保存");
        return;
      }
      if (alreadyLocked) {
        // 项目已进入制作阶段：分镜编辑走自动保存生效，这里只切回制作视图，
        // 不重复锁定（否则服务端 phase 会从 done/exportable 回退到 producing）。
        onLocked();
        return;
      }
      const res = await lockVideoStoryboard(token, projectName);
      if (res.ok) {
        onLocked();
      } else {
        setError(res.error || "锁定失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLocking(false);
    }
  }, [token, projectName, onLocked, flushSaves, alreadyLocked]);

  // Always render the full layout — empty state shows placeholder inside each pane
  // instead of a full-screen "loading" overlay. AI-generated scenes flow in smoothly.
  // 三栏尺寸档位与 ProducingPhase 一致：左 22%(18-32) / 中 50(≥30) / 右 28(22-38)。
  return (
    <ResizablePanelGroup direction="horizontal" className="h-full min-h-0">
      {/* 左:场景卡片列表 */}
      <ResizablePanel
        defaultSize="22%"
        minSize="18%"
        maxSize="32%"
        collapsible
        className="flex flex-col"
      >
        <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-border/70 px-3 py-2 text-[11px] font-medium text-muted-foreground">
          场景列表 · {scenes.length} 场
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-2">
          {scenes.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 px-2 text-center text-[11px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <div>AI 正在生成分镜...</div>
            </div>
          ) : (
            scenes.map((s) => (
              <button
                key={s.index}
                onClick={() => handleSelectScene(s.index)}
                aria-pressed={s.index === selectedIndex}
                aria-label={`场景 ${s.index} ${s.title || ""}`}
                className={cn(
                  "mb-1 w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                  s.index === selectedIndex
                    ? "border-primary bg-accent"
                    : "border-border/60 hover:bg-accent",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-mono text-muted-foreground">
                    {String(s.index).padStart(2, "0")}
                  </span>
                  <span
                    className={cn(
                      "truncate text-[12px]",
                      s.index === selectedIndex ? "font-semibold" : "font-medium",
                    )}
                  >
                    {s.title || `场景 ${s.index}`}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {s.duration}s
                </div>
              </button>
            ))
          )}
        </div>
        <div className="shrink-0 border-t border-border/70 p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-[12px]"
            onClick={handleAdd}
            disabled={scenes.length === 0}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            新增场景
          </Button>
        </div>
        </div>
      </ResizablePanel>

      <ResizableHandle withHandle />

      {/* 中:详情编辑 */}
      <ResizablePanel
        defaultSize={chatPanel ? "50%" : "78%"}
        minSize="30%"
        className="flex flex-col"
      >
        <div className="flex h-full min-h-0 flex-col">
        {selectedScene ? (
          <>
            <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-4 py-2">
              <div className="flex items-center text-[13px] font-medium">
                场景 {selectedScene.index} / {scenes.length}
                {saveState === "saving" && (
                  <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                    保存中…
                  </span>
                )}
                {saveState === "saved" && (
                  <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                    已保存
                  </span>
                )}
                {saveState === "error" && (
                  <span className="ml-2 flex items-center gap-1 text-[11px] font-normal text-destructive" role="alert">
                    保存失败
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1.5 text-[11px] text-destructive hover:text-destructive"
                      onClick={() => void flushSaves()}
                    >
                      重试
                    </Button>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => handleMove("up")}
                  disabled={selectedIndex === 1}
                  title="上移"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => handleMove("down")}
                  disabled={selectedIndex === scenes.length}
                  title="下移"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                  onClick={() => setDeleteConfirmOpen(true)}
                  disabled={scenes.length <= 1}
                  title="删除场景"
                  aria-label="删除场景"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-4">
              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                    标题
                  </label>
                  <Input
                    value={selectedScene.title}
                    onChange={(e) => handleFieldChange("title", e.target.value)}
                    className="h-8 rounded-lg text-[12px]"
                    placeholder="场景标题"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                    时长（秒）
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={1}
                      max={30}
                      value={selectedScene.duration}
                      onChange={(e) =>
                        handleFieldChange("duration", parseInt(e.target.value, 10))
                      }
                      className="flex-1 accent-primary"
                    />
                    <span className="w-12 text-right text-[12px] font-mono">
                      {selectedScene.duration}s
                    </span>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                    画面描述
                  </label>
                  <Textarea
                    value={selectedScene.visual}
                    onChange={(e) => handleFieldChange("visual", e.target.value)}
                    className="min-h-[60px] resize-none text-[12px]"
                    placeholder="描述这一场景的画面内容、布局、视觉元素..."
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                    动画说明
                  </label>
                  <Textarea
                    value={selectedScene.animation}
                    onChange={(e) => handleFieldChange("animation", e.target.value)}
                    className="min-h-[60px] resize-none text-[12px]"
                    placeholder="描述动画时序、过渡效果、GSAP timeline..."
                  />
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-[11px] font-medium text-muted-foreground">
                      旁白文本
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => handlePlayNarration(selectedScene.index)}
                      disabled={playingIndex !== null}
                    >
                      {playingIndex === selectedScene.index ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Volume2 className="mr-1 h-3 w-3" />
                      )}
                      {playingIndex === selectedScene.index ? "播放中" : "试听"}
                    </Button>
                  </div>
                  <Textarea
                    value={selectedScene.narration}
                    onChange={(e) => handleFieldChange("narration", e.target.value)}
                    className="min-h-[80px] resize-none text-[12px]"
                    placeholder="旁白文本（中文约 4 字/秒，需与时长匹配）..."
                  />
                </div>
              </div>
            </div>

            <div className="shrink-0 border-t border-border/70 p-3">
              {error && (
                <div className="mb-2 text-[11px] text-destructive" role="alert">{error}</div>
              )}
              {parseError && (
                <div className="mb-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive" role="alert">
                  <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="flex-1">{parseError}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[11px]"
                    onClick={() => {
                      setParseError(null);
                      setStoryboardExists(null);
                      loadScenes();
                    }}
                    aria-label="重试加载分镜"
                  >
                    <RefreshCw className="h-3 w-3" />
                  </Button>
                </div>
              )}
              <Button
                className="w-full"
                onClick={handleLock}
                disabled={locking || saveState === "saving" || saveState === "error" || scenes.length === 0}
              >
                {locking ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : alreadyLocked ? (
                  <ArrowRight className="mr-1.5 h-4 w-4" />
                ) : (
                  <Check className="mr-1.5 h-4 w-4" />
                )}
                {alreadyLocked ? "返回制作" : "确认分镜，进入制作"}
              </Button>
            </div>

            <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>删除场景</AlertDialogTitle>
                  <AlertDialogDescription>
                    确定删除「{selectedScene.title || `场景 ${selectedScene.index}`}」吗？
                    删除后所有场景将重新编号，已生成的预览和导出结果会失效。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      setDeleteConfirmOpen(false);
                      void handleDelete();
                    }}
                  >
                    删除
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted-foreground">
            {parseError ? (
              <>
                <AlertCircle className="h-6 w-6 text-destructive" />
                <div className="font-medium text-foreground">分镜解析失败</div>
                <div className="max-w-md text-[12px] leading-relaxed">{parseError}</div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1 h-8 text-[12px]"
                  onClick={() => {
                    setParseError(null);
                    setStoryboardExists(null);
                    loadScenes();
                  }}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  重新加载
                </Button>
              </>
            ) : aiFinishedEmpty ? (
              <>
                <AlertCircle className="h-6 w-6 text-amber-500" />
                <div className="font-medium text-foreground">AI 已完成回复，但未检测到分镜文件</div>
                <div className="max-w-md text-[12px] leading-relaxed">
                  请检查右侧对话内容，确认 AI 是否成功执行了分镜生成任务。
                  若 AI 拒绝或失败，可在对话框中重试。
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1 h-8 text-[12px]"
                  onClick={() => loadScenes()}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  重新加载
                </Button>
              </>
            ) : (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                <div>AI 正在生成分镜草稿...</div>
                <div className="text-[11px]">完成后会自动显示在此处</div>
              </>
            )}
          </div>
        )}
        </div>
      </ResizablePanel>

      {chatPanel ? (
        <>
          <ResizableHandle withHandle />
          {/* 右:AI 对话面板 */}
          <ResizablePanel
            defaultSize="28%"
            minSize="22%"
            maxSize="38%"
            className="flex flex-col"
          >
            <div className="flex h-full min-h-0 flex-col">
              {chatPanel}
            </div>
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}
