import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import type { VideoTtsConfig } from "@/lib/api";
import { VoicePreviewButton } from "./VoicePreviewButton";
import {
  EDGE_TTS_VOICES,
  TTS_PROVIDERS,
  TTS_RATE_OPTIONS,
  type TtsProvider,
} from "./video-tts-options";

interface VideoNarrationSettingsDialogProps {
  open: boolean;
  value: VideoTtsConfig;
  saving?: boolean;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (settings: VideoTtsConfig) => void;
}

export function VideoNarrationSettingsDialog({
  open,
  value,
  saving = false,
  error,
  onOpenChange,
  onSave,
}: VideoNarrationSettingsDialogProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  const provider = draft.ttsProvider === "custom" ? "custom" : "edge";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>旁白与字幕设置</DialogTitle>
          <DialogDescription>
            设置保存到当前视频项目，并用于后续场景配音与字幕交付。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-caption">
            <span>启用旁白配音</span>
            <Checkbox
              checked={draft.narrationEnabled === true}
              onCheckedChange={(checked) =>
                setDraft((current) => ({
                  ...current,
                  narrationEnabled: checked === true,
                }))
              }
              disabled={saving}
              aria-label="启用旁白配音"
            />
          </label>

          {draft.narrationEnabled ? (
            <div className="space-y-3">
              <label className="block text-micro font-medium text-muted-foreground">
                配音来源
                <Select
                  aria-label="配音来源"
                  className="mt-1 h-8 !text-caption"
                  value={provider}
                  disabled={saving}
                  options={TTS_PROVIDERS.map(({ value: optionValue, label }) => ({
                    value: optionValue,
                    label,
                  }))}
                  onValueChange={(nextProvider) =>
                    setDraft((current) => ({
                      ...current,
                      ttsProvider: nextProvider as TtsProvider,
                      ttsVoice:
                        nextProvider === "custom"
                          ? ""
                          : current.ttsVoice || "zh-CN-XiaoyiNeural",
                    }))
                  }
                />
              </label>
              {provider === "edge" ? (
                <div className="text-micro font-medium text-muted-foreground">
                  <span>音色</span>
                  <div className="mt-1 flex items-center gap-2">
                  <Select
                    aria-label="配音音色"
                    className="h-8 min-w-0 flex-1 !text-caption"
                    value={draft.ttsVoice || "zh-CN-XiaoyiNeural"}
                    disabled={saving}
                    options={EDGE_TTS_VOICES}
                    onValueChange={(ttsVoice) =>
                      setDraft((current) => ({ ...current, ttsVoice }))
                    }
                  />
                  <VoicePreviewButton provider={provider} voice={draft.ttsVoice || "zh-CN-XiaoyiNeural"} rate={draft.ttsRate || "+0%"} disabled={saving} />
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-micro text-muted-foreground">
                  使用“设置 → 语音合成”中配置的默认音色。
                  <div className="mt-2"><VoicePreviewButton provider={provider} voice={draft.ttsVoice || ""} rate={draft.ttsRate || "+0%"} disabled={saving} /></div>
                </div>
              )}
              <label className="block text-micro font-medium text-muted-foreground">
                语速
                <Select
                  aria-label="语速"
                  className="mt-1 h-8 !text-caption"
                  value={draft.ttsRate || "+0%"}
                  disabled={saving}
                  options={TTS_RATE_OPTIONS.map(({ value: optionValue, label }) => ({
                    value: optionValue,
                    label,
                  }))}
                  onValueChange={(ttsRate) =>
                    setDraft((current) => ({ ...current, ttsRate }))
                  }
                />
              </label>
              <label className="block text-micro font-medium text-muted-foreground">
                字幕交付
                <Select
                  aria-label="字幕交付方式"
                  className="mt-1 h-8 !text-caption"
                  value={draft.subtitleMode ?? "burned"}
                  disabled={saving}
                  options={[
                    { value: "burned", label: "视频内字幕" },
                    { value: "external", label: "外挂字幕文件" },
                    { value: "off", label: "关闭字幕" },
                  ]}
                  onValueChange={(subtitleMode) =>
                    setDraft((current) => ({
                      ...current,
                      subtitleMode: subtitleMode as VideoTtsConfig["subtitleMode"],
                    }))
                  }
                />
              </label>
            </div>
          ) : null}
          {error ? (
            <div className="text-caption text-destructive" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => onSave({ ...draft })}
            disabled={saving}
          >
            {saving ? "保存中…" : "保存设置"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
