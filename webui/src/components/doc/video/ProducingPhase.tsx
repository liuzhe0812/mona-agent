import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Code2,
  Eye,
  Loader2,
  RefreshCw,
  Volume2,
  Wand2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/providers/ClientProvider";
import {
  confirmVideoScene,
  fetchSceneNarrationBytes,
  fetchScenePreviewHtml,
  fetchVideoStoryboard,
  generateSceneHtml,
  regenerateVideoScene,
  rewriteVideoScene,
  type VideoSceneWithHtml,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface ProducingPhaseProps {
  projectName: string;
  onAllConfirmed: () => void;
}

export function ProducingPhase({ projectName, onAllConfirmed }: ProducingPhaseProps) {
  const { token } = useClient();
  const [scenes, setScenes] = useState<VideoSceneWithHtml[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [loading, setLoading] = useState(true);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [showHtml, setShowHtml] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriteText, setRewriteText] = useState("");
  const [rewriteLoading, setRewriteLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const loadScenes = useCallback(async () => {
    try {
      const res = await fetchVideoStoryboard(token, projectName);
      if (res.ok && res.scenes) {
        setScenes(res.scenes as VideoSceneWithHtml[]);
        if (res.scenes.length > 0 && !res.scenes.some((s) => s.index === selectedIndex)) {
          setSelectedIndex(res.scenes[0].index);
        }
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

  const selectedScene = scenes.find((s) => s.index === selectedIndex) ?? null;

  // Reset HTML view when switching scenes
  useEffect(() => {
    setShowHtml(false);
    setError(null);
  }, [selectedIndex]);

  // Load preview HTML when selected scene changes
  const loadPreview = useCallback(async () => {
    if (!selectedScene) {
      setPreviewHtml(null);
      return;
    }
    const status = selectedScene.htmlStatus ?? "pending";
    if (status === "pending") {
      setPreviewHtml(null);
      return;
    }
    setPreviewLoading(true);
    try {
      const { html, needsGeneration } = await fetchScenePreviewHtml(
        token,
        projectName,
        selectedIndex,
      );
      if (needsGeneration) {
        setPreviewHtml(null);
      } else {
        setPreviewHtml(html);
      }
    } catch (e) {
      console.error("Failed to load preview", e);
      setPreviewHtml(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [selectedScene, token, projectName, selectedIndex]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview, selectedIndex]);

  const updateSceneStatus = useCallback((index: number, status: string) => {
    setScenes((prev) =>
      prev.map((s) =>
        s.index === index ? { ...s, htmlStatus: status as never } : s,
      ),
    );
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!selectedScene || actionLoading) return;
    setActionLoading(true);
    setError(null);
    updateSceneStatus(selectedIndex, "generating");
    try {
      const res = await generateSceneHtml(token, projectName, selectedIndex);
      if (res.ok && res.scene) {
        setScenes((prev) =>
          prev.map((s) => (s.index === selectedIndex ? res.scene! : s)),
        );
        // Auto-load preview
        const { html } = await fetchScenePreviewHtml(token, projectName, selectedIndex);
        setPreviewHtml(html);
      } else {
        setError(res.error || "生成失败");
        updateSceneStatus(selectedIndex, "pending");
      }
    } catch (e) {
      setError(String(e));
      updateSceneStatus(selectedIndex, "pending");
    } finally {
      setActionLoading(false);
    }
  }, [selectedScene, actionLoading, token, projectName, selectedIndex, updateSceneStatus]);

  const handleRegenerate = useCallback(async () => {
    if (!selectedScene || actionLoading) return;
    setActionLoading(true);
    setError(null);
    updateSceneStatus(selectedIndex, "generating");
    try {
      const res = await regenerateVideoScene(token, projectName, selectedIndex);
      if (res.ok && res.scene) {
        setScenes((prev) =>
          prev.map((s) => (s.index === selectedIndex ? res.scene! : s)),
        );
        const { html } = await fetchScenePreviewHtml(token, projectName, selectedIndex);
        setPreviewHtml(html);
      } else {
        setError(res.error || "重新生成失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setActionLoading(false);
    }
  }, [selectedScene, actionLoading, token, projectName, selectedIndex, updateSceneStatus]);

  const handleConfirm = useCallback(async () => {
    if (!selectedScene || actionLoading) return;
    setActionLoading(true);
    setError(null);
    try {
      const res = await confirmVideoScene(token, projectName, selectedIndex);
      if (res.ok) {
        updateSceneStatus(selectedIndex, "confirmed");
        if (res.allConfirmed) {
          onAllConfirmed();
        }
      } else {
        setError(res.error || "确认失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setActionLoading(false);
    }
  }, [selectedScene, actionLoading, token, projectName, selectedIndex, updateSceneStatus, onAllConfirmed]);

  const handlePlayNarration = useCallback(async () => {
    if (!selectedScene || playingIndex !== null) return;
    setPlayingIndex(selectedIndex);
    try {
      const blob = await fetchSceneNarrationBytes(token, projectName, selectedIndex);
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
  }, [selectedScene, playingIndex, token, projectName, selectedIndex]);

  const handleRewriteSubmit = useCallback(async () => {
    if (!rewriteText.trim() || rewriteLoading) return;
    setRewriteLoading(true);
    setError(null);
    try {
      const res = await rewriteVideoScene(token, projectName, selectedIndex, rewriteText.trim());
      if (res.ok && res.scene) {
        setScenes((prev) =>
          prev.map((s) => (s.index === selectedIndex ? res.scene! : s)),
        );
        setRewriteOpen(false);
        setRewriteText("");
      } else {
        setError(res.error || "重写失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRewriteLoading(false);
    }
  }, [rewriteText, rewriteLoading, token, projectName, selectedIndex]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载场景...
      </div>
    );
  }

  const confirmedCount = scenes.filter((s) => s.htmlStatus === "confirmed").length;
  const allConfirmed = scenes.length > 0 && confirmedCount === scenes.length;

  return (
    <div className="flex h-full min-h-0">
      {/* 左:场景状态列表 */}
      <div className="flex w-[200px] shrink-0 flex-col border-r border-border/70">
        <div className="shrink-0 border-b border-border/70 px-3 py-2 text-[11px] font-medium text-muted-foreground">
          场景制作 · {confirmedCount}/{scenes.length} 已确认
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-2">
          {scenes.map((s) => {
            const status = s.htmlStatus ?? "pending";
            return (
              <button
                key={s.index}
                onClick={() => setSelectedIndex(s.index)}
                className={cn(
                  "mb-1 w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                  s.index === selectedIndex
                    ? "border-primary bg-accent"
                    : "border-border/60 hover:bg-accent",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0">
                    {status === "confirmed" ? (
                      <Check className="h-3 w-3 text-emerald-500" />
                    ) : status === "generating" ? (
                      <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
                    ) : status === "previewing" ? (
                      <span className="text-[10px] text-sky-500">●</span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">○</span>
                    )}
                  </span>
                  <span className="truncate text-[12px] font-medium">
                    {s.title || `场景 ${s.index}`}
                  </span>
                </div>
                <div className="mt-0.5 pl-4 text-[10px] text-muted-foreground">
                  {s.duration}s · {statusLabel(status)}
                </div>
              </button>
            );
          })}
        </div>
        {allConfirmed && (
          <div className="shrink-0 border-t border-border/70 p-2">
            <Button
              size="sm"
              className="w-full text-[12px]"
              onClick={onAllConfirmed}
            >
              <Check className="mr-1.5 h-3.5 w-3.5" />
              进入导出
            </Button>
          </div>
        )}
      </div>

      {/* 右:预览 + 操作 */}
      <div className="flex min-h-0 flex-1 flex-col">
        {selectedScene ? (
          <>
            <div className="shrink-0 border-b border-border/70 px-4 py-2">
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-medium">
                  场景 {selectedScene.index}: {selectedScene.title || ""}
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    {selectedScene.duration}s · {statusLabel(selectedScene.htmlStatus ?? "pending")}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {previewHtml && !showHtml && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => setFullscreen(true)}
                      title="全屏预览"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setShowHtml((v) => !v)}
                  >
                    <Code2 className="mr-1 h-3 w-3" />
                    {showHtml ? "预览" : "查看 HTML"}
                  </Button>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden bg-muted/30">
              {previewLoading ? (
                <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载预览...
                </div>
              ) : showHtml ? (
                <pre className="h-full overflow-auto scrollbar-hover p-3 text-[11px] font-mono">
                  <code>{previewHtml || "(无 HTML)"}</code>
                </pre>
              ) : previewHtml ? (
                <div className="flex h-full w-full items-center justify-center p-4">
                  <iframe
                    title={`scene-${selectedIndex}-preview`}
                    srcDoc={previewHtml}
                    className="aspect-video max-h-full max-w-full border-0 shadow-lg"
                    sandbox="allow-scripts"
                    style={{ width: "min(100%, calc((100vh - 200px) * 16 / 9))" }}
                  />
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
                  <div>该场景尚未生成 HTML</div>
                  <Button
                    size="sm"
                    onClick={handleGenerate}
                    disabled={actionLoading}
                  >
                    {actionLoading ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    生成本场景 HTML
                  </Button>
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-border/70 p-3">
              {error && (
                <div className="mb-2 text-[11px] text-destructive">{error}</div>
              )}
              <div className="grid grid-cols-2 gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[12px]"
                  onClick={handlePlayNarration}
                  disabled={playingIndex !== null || !selectedScene.narration}
                >
                  {playingIndex === selectedIndex ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Volume2 className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  试听旁白
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[12px]"
                  onClick={() => setRewriteOpen(true)}
                >
                  <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                  重写分镜
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[12px]"
                  onClick={handleRegenerate}
                  disabled={actionLoading || (selectedScene.htmlStatus ?? "pending") === "pending"}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  重新生成
                </Button>
                <Button
                  size="sm"
                  className="text-[12px]"
                  onClick={handleConfirm}
                  disabled={actionLoading || (selectedScene.htmlStatus ?? "pending") === "confirmed"}
                >
                  {actionLoading ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  确认通过
                </Button>
              </div>
              <div className="mt-2">
                <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${(confirmedCount / Math.max(scenes.length, 1)) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
            选择左侧场景查看预览
          </div>
        )}
      </div>

      {/* 重写分镜对话框 */}
      <Dialog open={rewriteOpen} onOpenChange={setRewriteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重写场景 {selectedIndex} 分镜</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-[12px] text-muted-foreground">
              描述你希望这个场景如何调整，AI 会重写该场景的分镜内容（标题/画面/动画/旁白），其他场景不受影响。
            </div>
            <Textarea
              value={rewriteText}
              onChange={(e) => setRewriteText(e.target.value)}
              className="min-h-[100px] resize-none text-[12px]"
              placeholder="例如：把开场改成产品 logo 从中心放大的动效，旁白改成'欢迎体验...'"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRewriteOpen(false)} disabled={rewriteLoading}>
              取消
            </Button>
            <Button onClick={handleRewriteSubmit} disabled={!rewriteText.trim() || rewriteLoading}>
              {rewriteLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              提交重写
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 全屏预览 */}
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent className="h-[90vh] max-w-[95vw] gap-0 p-0">
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-4 py-2">
              <div className="text-[13px] font-medium">
                场景 {selectedScene?.index} 全屏预览
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setFullscreen(false)}
              >
                关闭
              </Button>
            </div>
            <div className="min-h-0 flex-1 bg-muted/30">
              {previewHtml && (
                <iframe
                  title="scene-fullscreen-preview"
                  srcDoc={previewHtml}
                  className="h-full w-full border-0"
                  sandbox="allow-scripts"
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "confirmed":
      return "已确认";
    case "generating":
      return "生成中";
    case "previewing":
      return "已预览";
    default:
      return "待制作";
  }
}
