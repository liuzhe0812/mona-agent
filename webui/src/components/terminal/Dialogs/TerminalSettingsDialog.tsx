import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTerminalStore } from "../store/terminalStore";

export function TerminalSettingsDialog() {
  const open = useTerminalStore((s) => s.settingsDialogOpen);
  const setSettingsDialogOpen = useTerminalStore((s) => s.setSettingsDialogOpen);
  const fontSize = useTerminalStore((s) => s.settings.fontSize);
  const fontFamily = useTerminalStore((s) => s.settings.fontFamily);
  const scrollback = useTerminalStore((s) => s.settings.scrollback);
  const cursorStyle = useTerminalStore((s) => s.settings.cursorStyle);
  const updateSettings = useTerminalStore((s) => s.updateSettings);

  const [localFontSize, setLocalFontSize] = useState(fontSize);
  const [localFontFamily, setLocalFontFamily] = useState(fontFamily);
  const [localScrollback, setLocalScrollback] = useState(scrollback);
  const [localCursorStyle, setLocalCursorStyle] = useState(cursorStyle);

  useEffect(() => {
    if (open) {
      setLocalFontSize(fontSize);
      setLocalFontFamily(fontFamily);
      setLocalScrollback(scrollback);
      setLocalCursorStyle(cursorStyle);
    }
  }, [open, fontSize, fontFamily, scrollback, cursorStyle]);

  const handleSave = () => {
    updateSettings({
      fontSize: localFontSize,
      fontFamily: localFontFamily,
      scrollback: localScrollback,
      cursorStyle: localCursorStyle,
    });
    setSettingsDialogOpen(false);
  };

  const handleCancel = () => {
    setSettingsDialogOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setSettingsDialogOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>终端设置</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">字体大小</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={10}
                max={24}
                value={localFontSize}
                onChange={(e) => setLocalFontSize(Number(e.target.value))}
                className="flex-1"
              />
              <span className="w-8 text-right text-xs text-muted-foreground">
                {localFontSize}
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">字体</label>
            <select
              value={localFontFamily}
              onChange={(e) => setLocalFontFamily(e.target.value)}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
            >
              <option value='"JetBrains Mono", "Fira Code", "Cascadia Code", monospace'>
                JetBrains Mono
              </option>
              <option value='"Fira Code", monospace'>Fira Code</option>
              <option value='"Cascadia Code", monospace'>Cascadia Code</option>
              <option value='"Source Code Pro", monospace'>Source Code Pro</option>
              <option value="monospace">系统默认</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">回滚行数</label>
            <select
              value={localScrollback}
              onChange={(e) => setLocalScrollback(Number(e.target.value))}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
            >
              <option value={1000}>1000</option>
              <option value={5000}>5000</option>
              <option value={10000}>10000</option>
              <option value={50000}>50000</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">光标样式</label>
            <div className="flex gap-2">
              {(["block", "underline", "bar"] as const).map((style) => (
                <Button
                  key={style}
                  variant={localCursorStyle === style ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setLocalCursorStyle(style)}
                >
                  {style === "block" ? "方块" : style === "underline" ? "下划线" : "竖线"}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={handleCancel}>
            取消
          </Button>
          <Button size="sm" onClick={handleSave}>
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
