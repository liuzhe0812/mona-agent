import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  ApiError,
  addVideoScene,
  deleteVideoScene,
  fetchSceneNarrationBytes,
  fetchVideoProject,
  fetchVideoProjectAssets,
  fetchVideoStoryboard,
  importVideoProjectAsset,
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

function subtitleTimingLabel(scene: VideoScene): string {
  if (scene.audioTimingSource === "provider-boundary") return "字幕已同步";
  if (scene.audioTimingSource === "acoustic-sentence-alignment") {
    return scene.audioAlignmentConfidence === "high"
      ? "字幕已同步"
      : "字幕待检查";
  }
  if (scene.audioTimingSource === "estimated") return "字幕待检查";
  return "字幕待生成";
}

function subtitleTimingHint(scene: VideoScene): string {
  if (scene.audioTimingSource === "provider-boundary") {
    return "字幕已与配音同步";
  }
  if (scene.audioTimingSource === "acoustic-sentence-alignment") {
    return scene.audioAlignmentConfidence === "high"
      ? "字幕已与配音同步"
      : "字幕已对齐，请播放检查效果";
  }
  if (scene.audioTimingSource === "estimated") {
    return "制作配音后会自动同步字幕";
  }
  return "配音制作时生成字幕";
}

interface StoryboardPhaseProps {
  projectName: string;
  section?: "content" | "assets";
  refreshTrigger?: number;
  onSaveFlushReady?: (flush: (() => Promise<boolean>) | null) => void;
  onPlanChange?: (plan: { planRevision: number | null; sceneCount: number; duration: number }) => void;
  onPlanEdited?: () => void;
  busy?: boolean;
  chatPanel?: ReactNode;
}

export function StoryboardPhase({
  projectName,
  section = "content",
  refreshTrigger,
  onSaveFlushReady,
  onPlanChange,
  onPlanEdited,
  busy = false,
  chatPanel,
}: StoryboardPhaseProps) {
  const { client, token } = useClient();
  const [scenes, setScenes] = useState<VideoScene[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [narrationEnabled, setNarrationEnabled] = useState<boolean | null>(null);
  const [planApproved, setPlanApproved] = useState(false);
  const [playbackError, setPlaybackError] = useState<{
    title: string;
    description: string;
  } | null>(null);
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
  const [parseError, setParseError] = useState<string | null>(null);

  // Save queue: per-scene pending field edits, merged and sent serially.
  const pendingRef = useRef<Map<number, Partial<VideoScene>>>(new Map());
  const inFlightRef = useRef<{ index: number; fields: Partial<VideoScene> } | null>(null);
  const reloadScenesRef = useRef<((silent?: boolean) => Promise<void>) | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainPromiseRef = useRef<Promise<boolean> | null>(null);
  const savedHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const scenesRef = useRef<VideoScene[]>([]);
  const planRevisionRef = useRef<number | null>(null);

  const publishPlan = useCallback((revision?: number, nextScenes = scenesRef.current) => {
    if (typeof revision === "number") planRevisionRef.current = revision;
    scenesRef.current = nextScenes;
    onPlanChange?.({
      planRevision: planRevisionRef.current,
      sceneCount: nextScenes.length,
      duration: nextScenes.reduce((total, scene) => total + scene.duration, 0),
    });
  }, [onPlanChange]);

  useEffect(() => {
    scenesRef.current = [];
    planRevisionRef.current = null;
    publishPlan(undefined, []);
  }, [projectName, publishPlan]);

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
        inFlightRef.current = { index, fields };
        try {
          const res = await updateVideoScene(token, projectName, {
            index,
            ...fields,
            ...(planRevisionRef.current === null ? {} : { expectedPlanRevision: planRevisionRef.current }),
          });
          if (!res.ok) throw new Error(res.error || "save failed");
          publishPlan(res.planRevision);
        } catch (e) {
          console.error("Failed to save scene", e);
          // Restore failed fields, keeping newer edits (they win on conflict)
          const newer = pendingRef.current.get(index) ?? {};
          pendingRef.current.set(index, { ...fields, ...newer });
          if (e instanceof ApiError && e.status === 409) {
            setError("分镜方案已更新，请检查最新内容后再确认。未保存的修改仍保留。");
            void reloadScenesRef.current?.(true);
          }
          ok = false;
          break;
        } finally {
          inFlightRef.current = null;
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
  }, [token, projectName, publishPlan]);

  useEffect(() => {
    let cancelled = false;
    setNarrationEnabled(null);
    void fetchVideoProject(token, projectName)
      .then((project) => {
        if (!cancelled) {
          setNarrationEnabled(Boolean(project.meta?.narrationEnabled));
          setPlanApproved(!project.meta?.requirePlanApproval || project.meta.approvedPlanRevision === project.meta.planRevision);
        }
      })
      .catch((projectError) => {
        console.warn("[StoryboardPhase] load project settings failed:", projectError);
      });
    return () => {
      cancelled = true;
    };
  }, [projectName, token, refreshTrigger]);

  useEffect(() => {
    onSaveFlushReady?.(flushSaves);
    return () => onSaveFlushReady?.(null);
  }, [flushSaves, onSaveFlushReady]);

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
        setParseError(res.parseError ?? null);
        if (res.ok && res.scenes) {
          let next = res.scenes;
          if (pendingRef.current.size > 0 || inFlightRef.current) {
            next = next.map((s) => {
              const inFlight = inFlightRef.current?.index === s.index ? inFlightRef.current.fields : {};
              return { ...s, ...inFlight, ...(pendingRef.current.get(s.index) ?? {}) };
            });
          }
          setScenes(next);
          publishPlan(res.planRevision, next);
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
    [token, projectName, selectedIndex, publishPlan],
  );
  reloadScenesRef.current = loadScenes;

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

  const selectedScene = scenes.find((s) => s.index === selectedIndex) ?? null;

  // Debounced merge-save: update UI immediately, queue the field, and send
  // one merged request per scene 600ms after typing stops.
  const handleFieldChange = useCallback(
    <K extends keyof VideoScene>(field: K, value: VideoScene[K]) => {
      if (!selectedScene) return;
      onPlanEdited?.();
      setPlanApproved(false);
      const idx = selectedIndex;
      setScenes((prev) => {
        const next = prev.map((s) => (s.index === idx ? { ...s, [field]: value } : s));
        scenesRef.current = next;
        return next;
      });
      const existing = pendingRef.current.get(idx) ?? {};
      pendingRef.current.set(idx, { ...existing, [field]: value });
      setSaveState("saving");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void flushSaves();
      }, 600);
    },
    [selectedScene, selectedIndex, flushSaves, onPlanEdited],
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
    if (!assetImportPath || assetImporting) return;
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
      if (section === "content" && selectedScene && !selectedScene.assets.includes(imported.id)) {
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
    section,
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
      // Indices shift on reorder; do not replace local scenes until edits persist.
      const saved = await flushSaves();
      if (!saved || pendingRef.current.size > 0) {
        setError("有修改尚未保存成功，请先重试保存");
        return;
      }
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
          publishPlan(res.planRevision, res.scenes);
          onPlanEdited?.();
        } else {
          throw new Error(res.error || "reorder failed");
        }
      } catch (e) {
        console.error("Failed to reorder", e);
        setError("排序保存失败，已重新读取内容");
        void loadScenes(true);
      }
    },
    [scenes, selectedIndex, token, projectName, loadScenes, flushSaves, publishPlan, onPlanEdited],
  );

  const handleDelete = useCallback(async () => {
    if (scenes.length <= 1) return;
    if (!selectedScene) return;
    // Deleting changes scene indices; keep edits until they have persisted.
    const saved = await flushSaves();
    if (!saved || pendingRef.current.size > 0) {
      setError("有修改尚未保存成功，请先重试保存");
      return;
    }
    try {
      const res = await deleteVideoScene(token, projectName, selectedIndex);
      if (res.ok && res.scenes) {
        setScenes(res.scenes);
        publishPlan(res.planRevision, res.scenes);
        onPlanEdited?.();
        setSelectedIndex(res.scenes[0].index);
      } else {
        throw new Error(res.error || "delete failed");
      }
    } catch (e) {
      console.error("Failed to delete scene", e);
      setError("删除失败，已重新读取内容");
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
    publishPlan,
    onPlanEdited,
  ]);

  const handleAdd = useCallback(async () => {
    try {
      const res = await addVideoScene(token, projectName);
      if (res.ok && res.scene) {
        const next = [...scenesRef.current, res.scene];
        setScenes(next);
        publishPlan(res.planRevision, next);
        onPlanEdited?.();
        setSelectedIndex(res.scene.index);
      } else {
        throw new Error(res.error || "add failed");
      }
    } catch (e) {
      console.error("Failed to add scene", e);
      setError("新增场景失败，已重新读取内容");
      void loadScenes(true);
    }
  }, [token, projectName, loadScenes, publishPlan, onPlanEdited]);

  const handlePlayNarration = useCallback(
    async (index: number) => {
      if (playingIndex !== null || narrationEnabled === false) return;
      setPlayingIndex(index);
      let objectUrl: string | null = null;
      let audio: HTMLAudioElement | null = null;
      let failed = false;
      const failPlayback = () => {
        if (failed) return;
        failed = true;
        audio?.pause();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        setPlayingIndex(null);
        setPlaybackError({
          title: "试听旁白失败",
          description: "试听旁白失败。请检查网络连接后重试。",
        });
      };
      try {
        const saved = await flushSaves();
        if (!saved || pendingRef.current.size > 0) {
          setPlayingIndex(null);
          setError("有修改尚未保存成功，请先重试保存");
          return;
        }
        const blob = await fetchSceneNarrationBytes(token, projectName, index);
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          audio = new Audio(objectUrl);
          audio.onended = () => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            objectUrl = null;
            setPlayingIndex(null);
          };
          audio.onerror = failPlayback;
          await audio.play().catch(failPlayback);
        } else {
          setPlayingIndex(null);
        }
      } catch (e) {
        console.error("Narration playback failed", e);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        setPlayingIndex(null);
        setPlaybackError({
          title: "试听旁白失败",
          description: e instanceof ApiError && e.code?.startsWith("TTS_") ? e.message : "试听旁白失败。请检查网络连接后重试。",
        });
      }
    },
    [flushSaves, narrationEnabled, playingIndex, token, projectName],
  );

  const assetsPanel = (
                  <div className="rounded-lg border border-border/70 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-caption font-medium">可用素材</div>
                        <div className="mt-0.5 text-micro text-muted-foreground">
                          自己的图片、视频和声音都可以添加。
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
                        加载素材…
                      </div>
                    ) : assets.length === 0 ? (
                      <div className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-micro text-muted-foreground">
                        还没有素材，可以添加文件让 Mona 使用。
                      </div>
                    ) : (
                      <div className="mt-3 grid gap-1.5">
                        {assets.map((asset) => {
                          const selected = selectedScene?.assets.includes(
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
                                onClick={() => section === "content" && handleToggleAsset(asset.id)}
                                disabled={section === "assets"}
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

  );
  const assetDialogs = (<>
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

  </>);

  if (section === "assets") {
    return <div className="min-h-0 overflow-y-auto p-1">{assetsPanel}{error ? <p className="mt-2 text-caption text-destructive" role="alert">{error}</p> : null}{assetDialogs}</div>;
  }

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
              <div className="flex h-full flex-col items-center justify-center gap-1.5 px-2 text-center text-caption text-muted-foreground">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                <div>{busy ? "正在准备分镜方案" : "还没有分镜"}</div>
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
              disabled={busy}
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
                    disabled={busy || selectedIndex === 1}
                    title="上移"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => handleMove("down")}
                    disabled={busy || selectedIndex === scenes.length}
                    title="下移"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    onClick={() => setDeleteConfirmOpen(true)}
                    disabled={busy || scenes.length <= 1}
                    title="删除场景"
                    aria-label="删除场景"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-4">
                <fieldset className="space-y-4" disabled={busy}>
                  <div>
                    <label htmlFor="video-scene-title" className="mb-1 block text-caption font-medium text-muted-foreground">
                      标题
                    </label>
                    <Input
                      id="video-scene-title"
                      value={selectedScene.title}
                      onChange={(e) =>
                        handleFieldChange("title", e.target.value)
                      }
                      className="h-8 rounded-lg text-caption"
                      placeholder="场景标题"
                    />
                  </div>

                  <div>
                    <label htmlFor="video-scene-duration" className="mb-1 block text-caption font-medium text-muted-foreground">
                      时长（秒）
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="video-scene-duration"
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
                        className="flex-1 accent-[hsl(var(--brand-red))]"
                      />
                      <span className="w-12 text-right text-caption font-mono">
                        {selectedScene.duration}s
                      </span>
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <label htmlFor="video-scene-narration" className="text-caption font-medium text-muted-foreground">
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
                        disabled={
                          playingIndex !== null || narrationEnabled === false || !planApproved
                        }
                        title={
                          narrationEnabled === false
                            ? "当前项目未启用旁白"
                            : !planApproved ? "确认分镜后制作配音" : undefined
                        }
                      >
                        {playingIndex === selectedScene.index ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <Volume2 className="mr-1 h-3 w-3" />
                        )}
                        {playingIndex === selectedScene.index
                          ? "播放中"
                          : narrationEnabled === false
                            ? "未启用旁白"
                            : !planApproved ? "确认后生成配音" : "试听"}
                      </Button>
                    </div>
                    <Textarea
                      id="video-scene-narration"
                      value={selectedScene.narration}
                      onChange={(e) =>
                        handleFieldChange("narration", e.target.value)
                      }
                      className="min-h-[80px] resize-none text-caption"
                      placeholder="旁白文本（中文约 4 字/秒，需与时长匹配）..."
                    />
                  </div>

                  <div>
                    <label htmlFor="video-scene-visual" className="mb-1 block text-caption font-medium text-muted-foreground">
                      画面描述
                    </label>
                    <Textarea
                      id="video-scene-visual"
                      value={selectedScene.visual}
                      onChange={(e) =>
                        handleFieldChange("visual", e.target.value)
                      }
                      className="min-h-[60px] resize-none text-caption"
                      placeholder="描述这一场景的画面内容、布局、视觉元素..."
                    />
                  </div>

                  <div>
                    <label htmlFor="video-scene-animation" className="mb-1 block text-caption font-medium text-muted-foreground">画面如何变化</label>
                    <Textarea
                      id="video-scene-animation"
                      value={selectedScene.animation ?? ""}
                      onChange={(event) => handleFieldChange("animation", event.target.value)}
                      className="min-h-[80px] resize-none text-caption"
                      placeholder="例如：讲到每个步骤时逐一展开流程，关键选择放大，最后连成完整路径。"
                    />
                  </div>

                  {assetsPanel}

                </fieldset>
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
                    <span className="flex-1">内容读取失败，请重试。</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1.5 text-micro"
                      onClick={() => {
                        setParseError(null);
                        loadScenes();
                      }}
                      aria-label="重试读取内容"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                  </div>
                )}
              </div>

              {assetDialogs}

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
              <Dialog
                open={playbackError !== null}
                onOpenChange={(open) => {
                  if (!open) setPlaybackError(null);
                }}
              >
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{playbackError?.title}</DialogTitle>
                    <DialogDescription>
                      {playbackError?.description}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button onClick={() => setPlaybackError(null)}>关闭</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-ui text-muted-foreground">
              {parseError ? (
                <>
                  <AlertCircle className="h-6 w-6 text-destructive" />
                  <div className="font-medium text-foreground">
                    内容暂时无法读取
                  </div>
                  <div className="max-w-md text-caption leading-relaxed">
                    内容读取失败，请重试或在对话中告诉 Mona。
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1 h-8 text-caption"
                    onClick={() => {
                      setParseError(null);
                      loadScenes();
                    }}
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    重新加载
                  </Button>
                </>
              ) : (
                <><div>{busy ? "Mona 正在准备分镜方案…" : "还没有分镜方案"}</div><div className="text-caption">方案会显示在这里。确认和调整后再生成视频。</div></>
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
