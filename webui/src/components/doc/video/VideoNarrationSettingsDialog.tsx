import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { VideoTtsConfig } from "@/lib/api";
import { VideoNarrationSettingsFields } from "./VideoNarrationSettingsFields";

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
          <VideoNarrationSettingsFields
            value={draft}
            onChange={setDraft}
            disabled={saving}
          />
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
            onClick={() => onSave({
              narrationEnabled: draft.narrationEnabled,
              ttsProvider: draft.ttsProvider,
              ttsVoice: draft.ttsVoice,
              ttsRate: draft.ttsRate,
              subtitleMode: draft.subtitleMode,
            })}
            disabled={saving}
          >
            {saving ? "保存中…" : "保存设置"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
