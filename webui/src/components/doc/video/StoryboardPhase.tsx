import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ImageIcon,
  ImagePlus,
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
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/providers/ClientProvider";
import {
  addVideoScene,
  deleteVideoScene,
  fetchSceneNarrationBytes,
  fetchVideoProjectAssets,
  fetchVideoStoryboard,
  importVideoProjectAsset,
  lockVideoStoryboard,
  reorderVideoScenes,
  updateVideoScene,
  updateVideoProjectAsset,
  type VideoAssetRightsStatus,
  type VideoProjectAsset,
  type VideoScene,
} from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { AssetRightsDialog } from "./style/AssetRightsDialog";

const SCENE_ROLES = [
  ["cover", "封面", "cover-split"],
  ["chapter", "章节", "content-standard"],
  ["content", "内容", "content-standard"],
  ["data", "数据", "metric-comparison"],
  ["comparison", "对比", "comparison-columns"],
  ["process", "流程", "content-standard"],
  ["quote", "引用", "quote-focus"],
  ["outro", "结尾", "outro-brand"],
] as const;

const LAYOUTS = [
  ["cover-split", "封面分栏"],
  ["content-standard", "标准内容"],
  ["metric-comparison", "指标数据"],
  ["comparison-columns", "双栏对比"],
  ["quote-focus", "重点引用"],
  ["outro-brand", "品牌结尾"],
] as const;

function subtitleTimingLabel(scene: VideoScene): string {
  if (scene.audioTimingSource === "provider-boundary") return "字幕精确同步";
  if (scene.audioTimingSource === "acoustic-sentence-alignment") {
    return scene.audioAlignmentConfidence === "high"
      ? "字幕声学同步"
      : "字幕对齐待复核";
  }
  if (scene.audioTimingSource === "estimated") return "字幕时间估算";
  return "字幕待生成";
}

function subtitleTimingHint(scene: VideoScene): string {
  if (scene.audioTimingSource === "provider-boundary") {
    return "字幕时间来自本次配音的词级边界";
  }
  if (scene.audioTimingSource === "acoustic-sentence-alignment") {
    return scene.audioAlignmentConfidence === "high"
      ? "字幕句子已与实际语音和静音区间匹配"
      : "字幕已按实际语音区间对齐，但正式版前仍需复核";
  }
  if (scene.audioTimingSource === "estimated") {
    return "当前按场景时长估算，生成配音后会自动校准";
  }
  return "场景制作时生成字幕时间轴";
}

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

export function StoryboardPhase({
  projectName,
  onLocked,
  refreshTrigger,
  alreadyLocked = false,
  chatPanel,
}: StoryboardPhaseProps) {
  const { client, token } = useClient();
  const [scenes, setScenes] = useState<VideoScene[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [locking, setLocking] = useState(false);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [assets, setAssets] = useState<VideoProjectAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetImportOpen, setAssetImportOpen] = useState(false);
  const [assetImportPath, setAssetImportPath] = useState<string | null>(null);
  const [assetRights, setAssetRights] =
    useState<VideoAssetRightsStatus>("unknown");
  const [assetImporting, setAssetImporting] = useState(false);
  const [rightsAsset, setRightsAsset] = useState<VideoProjectAsset | null>(
    null,
  );
  const [rightsUpdating, setRightsUpdating] = useState(false);
  // null = unknown, true = storyboard.md exists, false = not yet
  const [storyboardExists, setStoryboardExists] = useState<boolean | null>(
    null,
  );
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
          const res = await updateVideoScene(token, projectName, {
            index,
            ...fields,
          });
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
  const loadScenes = useCallback(
    async (silent = false) => {
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
    },
    [token, projectName, selectedIndex],
  );

  useEffect(() => {
    loadScenes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, projectName]);

  const loadAssets = useCallback(async () => {
    setAssetsLoading(true);
    try {
      const result = await fetchVideoProjectAssets(token, projectName);
      setAssets(result.assets ?? []);
    } catch (assetError) {
      console.warn("[StoryboardPhase] load assets failed:", assetError);
    } finally {
      setAssetsLoading(false);
    }
  }, [projectName, token]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

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
      if (hint === "assets") void loadAssets();
    });
  }, [client, projectName, loadAssets, loadScenes]);

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
        prev.map((s) => (s.index === idx ? { ...s, [field]: value } : s)),
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

  const handlePickAsset = useCallback(async () => {
    if (!isTauri()) {
      setError("请在 Mona 桌面端选择本地素材");
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "视频素材",
            extensions: [
              "png",
              "jpg",
              "jpeg",
              "webp",
              "gif",
              "mp4",
              "webm",
              "mp3",
              "wav",
              "m4a",
            ],
          },
        ],
      });
      const filePath = Array.isArray(selected) ? selected[0] : selected;
      if (!filePath || typeof filePath !== "string") return;
      setAssetImportPath(filePath);
      setAssetRights("unknown");
      setAssetImportOpen(true);
    } catch (assetError) {
      setError(
        assetError instanceof Error ? assetError.message : String(assetError),
      );
    }
  }, []);

  const handleConfirmAssetImport = useCallback(async () => {
    if (!assetImportPath || !selectedScene || assetImporting) return;
    setAssetImporting(true);
    setError(null);
    try {
      const sourceType =
        assetRights === "ai-generated"
          ? "ai-generated"
          : assetRights === "licensed"
            ? "licensed-library"
            : "user-upload";
      const result = await importVideoProjectAsset(
        token,
        projectName,
        assetImportPath,
        {
          sourceType,
          rightsStatus: assetRights,
          licenseName:
            assetRights === "licensed" || assetRights === "permission-granted"
              ? assetRights === "licensed"
                ? "已获商业授权"
                : "已获作者许可"
              : undefined,
        },
      );
      if (!result.ok || !result.asset) {
        throw new Error(result.error || "素材导入失败");
      }
      let imported = result.asset;
      if (imported.rightsStatus !== assetRights) {
        const updated = await updateVideoProjectAsset(
          token,
          projectName,
          imported.id,
          { rightsStatus: assetRights, sourceType },
        );
        if (updated.ok && updated.asset) imported = updated.asset;
      }
      setAssets((current) => {
        const exists = current.some((asset) => asset.id === imported.id);
        return exists
          ? current.map((asset) =>
              asset.id === imported.id ? imported : asset,
            )
          : [...current, imported];
      });
      if (!selectedScene.assets.includes(imported.id)) {
        handleFieldChange("assets", [...selectedScene.assets, imported.id]);
      }
      setAssetImportOpen(false);
      setAssetImportPath(null);
    } catch (assetError) {
      setError(
        assetError instanceof Error ? assetError.message : String(assetError),
      );
    } finally {
      setAssetImporting(false);
    }
  }, [
    assetImportPath,
    assetImporting,
    assetRights,
    handleFieldChange,
    projectName,
    selectedScene,
    token,
  ]);

  const handleToggleAsset = useCallback(
    (assetId: string) => {
      if (!selectedScene) return;
      const selected = selectedScene.assets.includes(assetId);
      handleFieldChange(
        "assets",
        selected
          ? selectedScene.assets.filter((id) => id !== assetId)
          : [...selectedScene.assets, assetId],
      );
    },
    [handleFieldChange, selectedScene],
  );

  const handleUpdateAssetRights = useCallback(async () => {
    if (!rightsAsset || rightsUpdating) return;
    setRightsUpdating(true);
    setError(null);
    try {
      const sourceType =
        assetRights === "ai-generated"
          ? "ai-generated"
          : assetRights === "licensed"
            ? "licensed-library"
            : rightsAsset.sourceType;
      const result = await updateVideoProjectAsset(
        token,
        projectName,
        rightsAsset.id,
        {
          sourceType,
          rightsStatus: assetRights,
          licenseName:
            assetRights === "licensed"
              ? "已获商业授权"
              : assetRights === "permission-granted"
                ? "已获作者许可"
                : "",
        },
      );
      if (!result.ok || !result.asset) {
        throw new Error(result.error || "素材权利更新失败");
      }
      setAssets((current) =>
        current.map((asset) =>
          asset.id === result.asset!.id ? result.asset! : asset,
        ),
      );
      setRightsAsset(null);
    } catch (assetError) {
      setError(
        assetError instanceof Error ? assetError.message : String(assetError),
      );
    } finally {
      setRightsUpdating(false);
    }
  }, [assetRights, projectName, rightsAsset, rightsUpdating, token]);

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
      [newOrder[currentIdx], newOrder[targetIdx]] = [
        newOrder[targetIdx],
        newOrder[currentIdx],
      ];
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
  }, [
    scenes.length,
    selectedScene,
    token,
    projectName,
    selectedIndex,
    loadScenes,
    flushSaves,
  ]);

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
          <div className="shrink-0 border-b border-border/70 px-3 py-2 text-micro font-medium text-muted-foreground">
            场景列表 · {scenes.length} 场
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-2">
            {scenes.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 px-2 text-center text-micro text-muted-foreground">
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
                    <span className="text-micro font-mono text-muted-foreground">
                      {String(s.index).padStart(2, "0")}
                    </span>
                    <span
                      className={cn(
                        "truncate text-caption",
                        s.index === selectedIndex
                          ? "font-semibold"
                          : "font-medium",
                      )}
                    >
                      {s.title || `场景 ${s.index}`}
                    </span>
                  </div>
                  <div className="mt-0.5 text-micro text-muted-foreground">
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
              className="w-full justify-start text-caption"
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
                <div className="flex items-center text-ui font-medium">
                  场景 {selectedScene.index} / {scenes.length}
                  {saveState === "saving" && (
                    <span className="ml-2 text-micro font-normal text-muted-foreground">
                      保存中…
                    </span>
                  )}
                  {saveState === "saved" && (
                    <span className="ml-2 text-micro font-normal text-muted-foreground">
                      已保存
                    </span>
                  )}
                  {saveState === "error" && (
                    <span
                      className="ml-2 flex items-center gap-1 text-micro font-normal text-destructive"
                      role="alert"
                    >
                      保存失败
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1.5 text-micro text-destructive hover:text-destructive"
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
                    <label className="mb-1 block text-micro font-medium text-muted-foreground">
                      标题
                    </label>
                    <Input
                      value={selectedScene.title}
                      onChange={(e) =>
                        handleFieldChange("title", e.target.value)
                      }
                      className="h-8 rounded-lg text-caption"
                      placeholder="场景标题"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <label className="text-caption font-medium text-muted-foreground">
                      场景角色
                      <Select
                        className="mt-1 h-8 text-caption"
                        value={selectedScene.role ?? "content"}
                        aria-label="场景角色"
                        onValueChange={(role) => {
                          const config = SCENE_ROLES.find(
                            (item) => item[0] === role,
                          );
                          handleFieldChange("role", role);
                          if (config) handleFieldChange("layout", config[2]);
                          handleFieldChange(
                            "backgroundSlot",
                            role === "cover" || role === "outro"
                              ? role
                              : "content",
                          );
                        }}
                        options={SCENE_ROLES.map(([value, label]) => ({
                          value,
                          label,
                        }))}
                      />
                    </label>
                    <label className="text-caption font-medium text-muted-foreground">
                      布局
                      <Select
                        className="mt-1 h-8 text-caption"
                        value={selectedScene.layout ?? "content-standard"}
                        aria-label="场景布局"
                        onValueChange={(value) =>
                          handleFieldChange("layout", value)
                        }
                        options={LAYOUTS.map(([value, label]) => ({
                          value,
                          label,
                        }))}
                      />
                    </label>
                    <label className="text-caption font-medium text-muted-foreground">
                      背景槽位
                      <Select
                        className="mt-1 h-8 text-caption"
                        value={selectedScene.backgroundSlot ?? "content"}
                        aria-label="背景槽位"
                        onValueChange={(value) =>
                          handleFieldChange("backgroundSlot", value)
                        }
                        options={[
                          "cover",
                          "chapter",
                          "content",
                          "data",
                          "outro",
                        ].map((value) => ({ value, label: value }))}
                      />
                    </label>
                  </div>

                  <div>
                    <label className="mb-1 block text-micro font-medium text-muted-foreground">
                      时长（秒）
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={1}
                        max={30}
                        value={selectedScene.duration}
                        onChange={(e) =>
                          handleFieldChange(
                            "duration",
                            parseInt(e.target.value, 10),
                          )
                        }
                        className="flex-1 accent-primary"
                      />
                      <span className="w-12 text-right text-caption font-mono">
                        {selectedScene.duration}s
                      </span>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-micro font-medium text-muted-foreground">
                      画面描述
                    </label>
                    <Textarea
                      value={selectedScene.visual}
                      onChange={(e) =>
                        handleFieldChange("visual", e.target.value)
                      }
                      className="min-h-[60px] resize-none text-caption"
                      placeholder="描述这一场景的画面内容、布局、视觉元素..."
                    />
                  </div>

                  <div className="rounded-lg border border-border/70 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-caption font-medium">场景素材</div>
                        <div className="mt-0.5 text-micro text-muted-foreground">
                          素材来源和商业使用权会写入最终质量报告
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handlePickAsset()}
                        disabled={assetImporting}
                      >
                        <ImagePlus className="mr-1.5 h-3.5 w-3.5" />
                        导入素材
                      </Button>
                    </div>
                    {assetsLoading ? (
                      <div className="mt-3 flex items-center text-micro text-muted-foreground">
                        <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                        加载素材台账...
                      </div>
                    ) : assets.length === 0 ? (
                      <div className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-micro text-muted-foreground">
                        尚未导入素材。场景可以继续使用模板图形与背景。
                      </div>
                    ) : (
                      <div className="mt-3 grid gap-1.5">
                        {assets.map((asset) => {
                          const selected = selectedScene.assets.includes(
                            asset.id,
                          );
                          return (
                            <div
                              key={asset.id}
                              className={cn(
                                "flex items-center gap-1 rounded-md border border-border/70 p-1",
                                selected && "border-primary bg-primary/5",
                              )}
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                aria-pressed={selected}
                                onClick={() => handleToggleAsset(asset.id)}
                                className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1.5 text-left"
                              >
                                <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-caption font-medium">
                                    {asset.originalName}
                                  </span>
                                  <span className="block text-micro text-muted-foreground">
                                    {asset.kind === "image"
                                      ? "图片"
                                      : asset.kind === "video"
                                        ? "视频"
                                        : "音频"}
                                  </span>
                                </span>
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className={cn(
                                  "h-7 shrink-0 rounded-full px-2 text-micro",
                                  !asset.commercialUse
                                    ? "bg-amber-500/10 text-amber-700"
                                    : "bg-emerald-500/10 text-emerald-700",
                                )}
                                onClick={() => {
                                  setRightsAsset(asset);
                                  setAssetRights(asset.rightsStatus);
                                }}
                              >
                                {!asset.commercialUse ? "权利待确认" : "可商用"}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="rounded-md border border-border/70 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-caption font-medium">动画节奏</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">
                        系统生成
                      </span>
                    </div>
                    <div className="mt-1.5 text-caption text-muted-foreground">
                      {selectedScene.motionPlanSummary ??
                        "进入场景制作后，系统会根据旁白句子和场景角色生成动画节拍。"}
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <label className="text-caption font-medium text-muted-foreground">
                          旁白文本
                        </label>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-micro",
                            selectedScene.audioTimingSource ===
                              "provider-boundary" ||
                              (selectedScene.audioTimingSource ===
                                "acoustic-sentence-alignment" &&
                                selectedScene.audioAlignmentConfidence ===
                                  "high")
                              ? "bg-emerald-500/10 text-emerald-700"
                              : selectedScene.audioTimingSource ===
                                    "estimated" ||
                                  selectedScene.audioTimingSource ===
                                    "acoustic-sentence-alignment"
                                ? "bg-amber-500/10 text-amber-700"
                                : "bg-muted text-muted-foreground",
                          )}
                          title={subtitleTimingHint(selectedScene)}
                        >
                          {subtitleTimingLabel(selectedScene)}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-micro"
                        onClick={() => handlePlayNarration(selectedScene.index)}
                        disabled={playingIndex !== null}
                      >
                        {playingIndex === selectedScene.index ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <Volume2 className="mr-1 h-3 w-3" />
                        )}
                        {playingIndex === selectedScene.index
                          ? "播放中"
                          : "试听"}
                      </Button>
                    </div>
                    <Textarea
                      value={selectedScene.narration}
                      onChange={(e) =>
                        handleFieldChange("narration", e.target.value)
                      }
                      className="min-h-[80px] resize-none text-caption"
                      placeholder="旁白文本（中文约 4 字/秒，需与时长匹配）..."
                    />
                  </div>
                </div>
              </div>

              <div className="shrink-0 border-t border-border/70 p-3">
                {error && (
                  <div
                    className="mb-2 text-micro text-destructive"
                    role="alert"
                  >
                    {error}
                  </div>
                )}
                {parseError && (
                  <div
                    className="mb-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-micro text-destructive"
                    role="alert"
                  >
                    <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="flex-1">{parseError}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1.5 text-micro"
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
                  disabled={
                    locking ||
                    saveState === "saving" ||
                    saveState === "error" ||
                    scenes.length === 0
                  }
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

              <AssetRightsDialog
                open={assetImportOpen}
                fileName={assetImportPath?.split(/[\\/]/).pop() ?? "所选素材"}
                value={assetRights}
                loading={assetImporting}
                onChange={setAssetRights}
                onCancel={() => {
                  setAssetImportOpen(false);
                  setAssetImportPath(null);
                }}
                onConfirm={() => void handleConfirmAssetImport()}
              />
              <AssetRightsDialog
                open={rightsAsset !== null}
                fileName={rightsAsset?.originalName ?? "项目素材"}
                value={assetRights}
                loading={rightsUpdating}
                title="更新素材使用权"
                onChange={setAssetRights}
                onCancel={() => setRightsAsset(null)}
                onConfirm={() => void handleUpdateAssetRights()}
              />

              <AlertDialog
                open={deleteConfirmOpen}
                onOpenChange={setDeleteConfirmOpen}
              >
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>删除场景</AlertDialogTitle>
                    <AlertDialogDescription>
                      确定删除「
                      {selectedScene.title || `场景 ${selectedScene.index}`}
                      」吗？
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
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-ui text-muted-foreground">
              {parseError ? (
                <>
                  <AlertCircle className="h-6 w-6 text-destructive" />
                  <div className="font-medium text-foreground">
                    分镜解析失败
                  </div>
                  <div className="max-w-md text-caption leading-relaxed">
                    {parseError}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1 h-8 text-caption"
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
                  <div className="font-medium text-foreground">
                    AI 已完成回复，但未检测到分镜文件
                  </div>
                  <div className="max-w-md text-caption leading-relaxed">
                    请检查右侧对话内容，确认 AI 是否成功执行了分镜生成任务。 若
                    AI 拒绝或失败，可在对话框中重试。
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1 h-8 text-caption"
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
                  <div className="text-micro">完成后会自动显示在此处</div>
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
            <div className="flex h-full min-h-0 flex-col">{chatPanel}</div>
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}
