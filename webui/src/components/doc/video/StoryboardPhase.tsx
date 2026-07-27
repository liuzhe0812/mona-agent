import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Loader2,
  Play,
  Plus,
  Trash2,
  Volume2,
} from "lucide-react";

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
}

export function StoryboardPhase({ projectName, onLocked }: StoryboardPhaseProps) {
  const { token } = useClient();
  const [scenes, setScenes] = useState<VideoScene[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [saving, setSaving] = useState(false);
  const [locking, setLocking] = useState(false);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load storyboard on mount
  const loadScenes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchVideoStoryboard(token, projectName);
      if (res.ok && res.scenes) {
        setScenes(res.scenes);
        if (res.scenes.length > 0 && !res.scenes.some((s) => s.index === selectedIndex)) {
          setSelectedIndex(res.scenes[0].index);
        }
      } else {
        setError(res.error || "无法加载分镜");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [token, projectName, selectedIndex]);

  useEffect(() => {
    loadScenes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, projectName]);

  // Poll storyboard while empty (AI is generating draft)
  useEffect(() => {
    if (scenes.length > 0 || !loading) return;
    const timer = setInterval(() => {
      loadScenes();
    }, 5000);
    return () => clearInterval(timer);
  }, [scenes.length, loading, loadScenes]);

  const selectedScene = scenes.find((s) => s.index === selectedIndex) ?? null;

  const handleFieldChange = useCallback(
    async <K extends keyof VideoScene>(field: K, value: VideoScene[K]) => {
      if (!selectedScene) return;
      // Optimistic update
      setScenes((prev) =>
        prev.map((s) =>
          s.index === selectedIndex ? { ...s, [field]: value } : s,
        ),
      );
      // Persist
      setSaving(true);
      try {
        await updateVideoScene(token, projectName, {
          index: selectedIndex,
          [field]: value,
        });
      } catch (e) {
        console.error("Failed to save scene", e);
      } finally {
        setSaving(false);
      }
    },
    [selectedScene, selectedIndex, token, projectName],
  );

  const handleMove = useCallback(
    async (direction: "up" | "down") => {
      const currentIdx = scenes.findIndex((s) => s.index === selectedIndex);
      if (currentIdx < 0) return;
      const targetIdx = direction === "up" ? currentIdx - 1 : currentIdx + 1;
      if (targetIdx < 0 || targetIdx >= scenes.length) return;
      const newOrder = [...scenes];
      [newOrder[currentIdx], newOrder[targetIdx]] = [newOrder[targetIdx], newOrder[currentIdx]];
      const indices = newOrder.map((s) => s.index);
      setScenes(newOrder.map((s, i) => ({ ...s, index: i + 1 })));
      setSelectedIndex(currentIdx + 1 + (direction === "up" ? -1 : 1));
      try {
        const res = await reorderVideoScenes(token, projectName, indices);
        if (res.ok && res.scenes) {
          setScenes(res.scenes);
        }
      } catch (e) {
        console.error("Failed to reorder", e);
      }
    },
    [scenes, selectedIndex, token, projectName],
  );

  const handleDelete = useCallback(async () => {
    if (scenes.length <= 1) return;
    if (!selectedScene) return;
    try {
      const res = await deleteVideoScene(token, projectName, selectedIndex);
      if (res.ok && res.scenes) {
        setScenes(res.scenes);
        setSelectedIndex(res.scenes[0].index);
      }
    } catch (e) {
      console.error("Failed to delete scene", e);
    }
  }, [scenes.length, selectedScene, token, projectName, selectedIndex]);

  const handleAdd = useCallback(async () => {
    try {
      const res = await addVideoScene(token, projectName);
      if (res.ok && res.scene) {
        setScenes((prev) => [...prev, res.scene!]);
        setSelectedIndex(res.scene.index);
      }
    } catch (e) {
      console.error("Failed to add scene", e);
    }
  }, [token, projectName]);

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
    try {
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
  }, [token, projectName, onLocked]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载分镜...
      </div>
    );
  }

  if (scenes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <div>AI 正在生成分镜草稿...</div>
        <div className="text-[11px]">完成后会自动显示在此处</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 左:场景卡片列表 */}
      <div className="flex w-[200px] shrink-0 flex-col border-r border-border/70">
        <div className="shrink-0 border-b border-border/70 px-3 py-2 text-[11px] font-medium text-muted-foreground">
          场景列表 · {scenes.length} 场
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-2">
          {scenes.map((s) => (
            <button
              key={s.index}
              onClick={() => setSelectedIndex(s.index)}
              className={cn(
                "mb-1 w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                s.index === selectedIndex
                  ? "border-primary bg-accent"
                  : "border-border/60 hover:bg-accent/50",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-mono text-muted-foreground">
                  {String(s.index).padStart(2, "0")}
                </span>
                <span className="truncate text-[12px] font-medium">
                  {s.title || `场景 ${s.index}`}
                </span>
              </div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {s.duration}s
              </div>
            </button>
          ))}
        </div>
        <div className="shrink-0 border-t border-border/70 p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-[12px]"
            onClick={handleAdd}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            新增场景
          </Button>
        </div>
      </div>

      {/* 右:详情编辑 */}
      <div className="flex min-h-0 flex-1 flex-col">
        {selectedScene ? (
          <>
            <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-4 py-2">
              <div className="text-[13px] font-medium">
                场景 {selectedScene.index} / {scenes.length}
                {saving && (
                  <span className="ml-2 text-[10px] text-muted-foreground">
                    保存中...
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
                  onClick={handleDelete}
                  disabled={scenes.length <= 1}
                  title="删除场景"
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
                <div className="mb-2 text-[11px] text-destructive">{error}</div>
              )}
              <Button
                className="w-full"
                onClick={handleLock}
                disabled={locking}
              >
                {locking ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Check className="mr-1.5 h-4 w-4" />
                )}
                确认分镜，进入制作
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
            选择左侧场景查看详情
          </div>
        )}
      </div>
    </div>
  );
}
