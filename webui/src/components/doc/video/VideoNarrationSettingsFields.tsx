import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import type { VideoTtsConfig } from "@/lib/api";
import { VoicePreviewButton } from "./VoicePreviewButton";
import {
  EDGE_TTS_VOICES,
  TTS_PROVIDERS,
  TTS_RATE_OPTIONS,
  type TtsProvider,
} from "./video-tts-options";

interface VideoNarrationSettingsFieldsProps {
  value: VideoTtsConfig;
  onChange: (value: VideoTtsConfig) => void;
  disabled?: boolean;
}

export function VideoNarrationSettingsFields({
  value,
  onChange,
  disabled = false,
}: VideoNarrationSettingsFieldsProps) {
  const provider = value.ttsProvider === "custom" ? "custom" : "edge";

  return (
    <div className="space-y-4">
      <label className="flex min-h-8 items-center justify-between gap-3 text-ui">
        <span>启用旁白配音</span>
        <Checkbox
          checked={value.narrationEnabled === true}
          onCheckedChange={(checked) =>
            onChange({ ...value, narrationEnabled: checked === true })
          }
          disabled={disabled}
          aria-label="启用旁白配音"
        />
      </label>

      {value.narrationEnabled ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-ui font-medium text-muted-foreground">
            配音来源
            <Select
              aria-label="配音来源"
              className="mt-1 !text-caption"
              value={provider}
              disabled={disabled}
              options={TTS_PROVIDERS.map(({ value: optionValue, label }) => ({
                value: optionValue,
                label,
              }))}
              onValueChange={(nextProvider) =>
                onChange({
                  ...value,
                  ttsProvider: nextProvider as TtsProvider,
                  ttsVoice:
                    nextProvider === "custom"
                      ? ""
                      : value.ttsVoice || "zh-CN-XiaoyiNeural",
                })
              }
            />
          </label>
          <label className="block text-ui font-medium text-muted-foreground">
            语速
            <Select
              aria-label="语速"
              className="mt-1 !text-caption"
              value={value.ttsRate || "+0%"}
              disabled={disabled}
              options={TTS_RATE_OPTIONS.map(({ value: optionValue, label }) => ({
                value: optionValue,
                label,
              }))}
              onValueChange={(ttsRate) => onChange({ ...value, ttsRate })}
            />
          </label>
          {provider === "edge" ? (
            <div className="text-ui font-medium text-muted-foreground sm:col-span-2">
              <span>音色</span>
              <div className="mt-1 flex items-center gap-2">
                <Select
                  aria-label="配音音色"
                  className="min-w-0 flex-1 !text-caption"
                  value={value.ttsVoice || "zh-CN-XiaoyiNeural"}
                  disabled={disabled}
                  options={EDGE_TTS_VOICES}
                  onValueChange={(ttsVoice) => onChange({ ...value, ttsVoice })}
                />
                <VoicePreviewButton
                  provider={provider}
                  voice={value.ttsVoice || "zh-CN-XiaoyiNeural"}
                  rate={value.ttsRate || "+0%"}
                  disabled={disabled}
                />
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-caption text-muted-foreground sm:col-span-2">
              使用“设置 → 语音合成”中配置的默认音色。
              <div className="mt-2">
                <VoicePreviewButton
                  provider={provider}
                  voice={value.ttsVoice || ""}
                  rate={value.ttsRate || "+0%"}
                  disabled={disabled}
                />
              </div>
            </div>
          )}
        </div>
      ) : null}
      <label className="block text-ui font-medium text-muted-foreground">
        字幕显示
        <Select
          aria-label="字幕交付方式"
          className="mt-1 !text-caption"
          value={value.subtitleMode ?? "burned"}
          disabled={disabled}
          options={[
            { value: "burned", label: "视频内字幕" },
            { value: "external", label: "外挂字幕文件" },
            { value: "off", label: "关闭字幕" },
          ]}
          onValueChange={(subtitleMode) =>
            onChange({
              ...value,
              subtitleMode: subtitleMode as VideoTtsConfig["subtitleMode"],
            })
          }
        />
      </label>
    </div>
  );
}
