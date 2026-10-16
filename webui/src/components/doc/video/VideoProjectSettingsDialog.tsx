import { useEffect, useRef, useState } from "react";
import { Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import type { VideoAspectVariant, VideoLanguage, VideoTtsConfig } from "@/lib/api";
import { VideoNarrationSettingsFields } from "./VideoNarrationSettingsFields";

export const VIDEO_LANGUAGE_OPTIONS: Array<{ value: VideoLanguage; label: string }> = [
  { value: "zh-CN", label: "简体中文" }, { value: "zh-TW", label: "繁体中文" },
  { value: "en-US", label: "English" }, { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" }, { value: "es-ES", label: "Español" },
  { value: "fr-FR", label: "Français" }, { value: "de-DE", label: "Deutsch" },
];

export interface VideoProjectSettingsValue extends VideoTtsConfig {
  aspect: VideoAspectVariant;
  language: VideoLanguage;
  showTimeline: boolean;
}

export function VideoProjectSettingsDialog({ open, value, saving, busy, error, onOpenChange, onSave }: {
  open: boolean;
  value: VideoProjectSettingsValue;
  saving: boolean;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (value: VideoProjectSettingsValue) => void;
}) {
  const [draft, setDraft] = useState(value);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setDraft(value);
    wasOpen.current = open;
  }, [open, value]);
  const changesPlan = draft.aspect !== value.aspect || draft.language !== value.language;
  const disabled = saving || busy;

  return <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
    <DialogContent className="flex max-h-[85vh] max-w-lg flex-col">
      <DialogHeader><DialogTitle>视频设置</DialogTitle><DialogDescription>画面、声音与字幕。</DialogDescription></DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto scrollbar-hover">
        <div className="grid grid-cols-2 gap-4">
          <label className="space-y-1.5 text-ui font-medium">画面比例
            <Select aria-label="画面比例" value={draft.aspect} disabled={disabled}
              onValueChange={(aspect) => setDraft((current) => ({ ...current, aspect: aspect as VideoAspectVariant }))}
              options={[{ value: "16:9", label: "横屏 · 16:9" }, { value: "9:16", label: "竖屏 · 9:16" }, { value: "1:1", label: "方形 · 1:1" }]} />
          </label>
          <label className="space-y-1.5 text-ui font-medium">视频语言
            <Select aria-label="视频语言" value={draft.language} disabled={disabled}
              onValueChange={(language) => setDraft((current) => ({ ...current, language: language as VideoLanguage }))}
              options={VIDEO_LANGUAGE_OPTIONS} />
          </label>
        </div>
        {changesPlan ? <p className="text-caption text-muted-foreground">画幅或语言变化会更新导演方案，确认后再制作。</p> : null}
        <div className="border-t border-border/70 pt-4">
          <VideoNarrationSettingsFields value={draft} disabled={disabled} onChange={(next) => setDraft((current) => ({ ...current, ...next }))} />
        </div>
        <div className="border-t border-border/70 pt-4">
          <label className="flex items-center gap-2 text-ui">
            <Checkbox checked={draft.showTimeline} disabled={disabled} aria-label="显示辅助线和时间轴详情"
              onCheckedChange={(checked) => setDraft((current) => ({ ...current, showTimeline: checked === true }))} />
            显示辅助线和时间轴详情
          </label>
          <p className="mt-1.5 text-caption text-muted-foreground">只影响工作台预览，导出的视频不会显示这些辅助信息。</p>
        </div>
        {busy ? <p className="text-caption text-muted-foreground">制作或导出完成后可以修改设置。</p> : null}
        {error ? <p className="text-caption text-destructive" role="alert">{error}</p> : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
        <Button size="sm" disabled={disabled} aria-busy={saving} onClick={() => onSave(draft)}>
          {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
          {changesPlan ? "保存并更新方案" : "保存设置"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
