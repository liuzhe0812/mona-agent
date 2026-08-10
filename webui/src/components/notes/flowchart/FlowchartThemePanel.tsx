/**
 * 流程图主题样式面板（FC-THEME-02）。
 *
 * 内容：
 * - “切换时保留手动样式”复选框；
 * - 三个风格缩略图（solid 纯色 / outline 描边 / soft 柔和），用当前配色实时渲染；
 * - 配色缩略图网格（内置 8 套）；
 * - 点击风格/配色立即应用，每次点击形成一个撤销单元；
 * - 不保留手动样式时弹出确认，展示将清理手动颜色样式的节点数量。
 *
 * 本组件只负责展示与交互；主题写入文档与手动样式清理由父组件（编辑器）执行，
 * 通过 onApplyTheme(theme, { stripManualStyles }) 上抛。
 */

import { useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import type { FlowchartThemeSettings } from "./flowchart-document";
import { renderFlowchartShape } from "./flowchart-shapes";
import {
  FLOWCHART_PALETTES,
  FLOWCHART_STYLE_PRESETS,
  resolveFlowchartThemeDefaults,
  type FlowchartPalette,
  type FlowchartStylePresetId,
} from "./flowchart-themes";

export interface FlowchartThemePanelProps {
  /** 当前文档主题 */
  theme: FlowchartThemeSettings;
  /** 有手动颜色样式（fill/borderColor/color）的节点数量，用于清理确认提示 */
  manualStyleNodeCount: number;
  readOnly?: boolean;
  /** 应用主题；stripManualStyles=true 时同时清理节点手动颜色样式 */
  onApplyTheme: (theme: FlowchartThemeSettings, options: { stripManualStyles: boolean }) => void;
}

export function FlowchartThemePanel({
  theme,
  manualStyleNodeCount,
  readOnly = false,
  onApplyTheme,
}: FlowchartThemePanelProps) {
  // 待确认的主题应用（preserveManualStyles=false 且存在手动样式节点时）
  const [pendingTheme, setPendingTheme] = useState<FlowchartThemeSettings | null>(null);

  const requestApply = (next: FlowchartThemeSettings) => {
    if (readOnly) return;
    if (!next.preserveManualStyles && manualStyleNodeCount > 0) {
      setPendingTheme(next);
      return;
    }
    onApplyTheme(next, { stripManualStyles: false });
  };

  const handlePresetClick = (presetId: FlowchartStylePresetId) => {
    requestApply({ ...theme, stylePreset: presetId });
  };

  const handlePaletteClick = (paletteId: string) => {
    requestApply({ ...theme, paletteId });
  };

  // 复选框只是“切换时是否保留”的设置，本身不触发清理
  const handlePreserveChange = (checked: boolean) => {
    if (readOnly) return;
    onApplyTheme({ ...theme, preserveManualStyles: checked }, { stripManualStyles: false });
  };

  const handleConfirmApply = () => {
    if (pendingTheme) {
      onApplyTheme(pendingTheme, { stripManualStyles: true });
    }
    setPendingTheme(null);
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* 保留手动样式 */}
      <label
        className={cn(
          "flex items-center gap-2 px-1",
          readOnly ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        )}
      >
        <Checkbox
          checked={theme.preserveManualStyles}
          onCheckedChange={(v) => handlePreserveChange(v === true)}
          disabled={readOnly}
          aria-label="切换时保留手动样式"
        />
        <span className="text-xs text-foreground">切换时保留手动样式</span>
      </label>

      {/* 风格 */}
      <section className="flex flex-col gap-1.5">
        <div className="px-1 text-xs font-medium text-muted-foreground">风格</div>
        <div className="grid grid-cols-3 gap-1.5">
          {FLOWCHART_STYLE_PRESETS.map((preset) => {
            const selected = theme.stylePreset === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                disabled={readOnly}
                onClick={() => handlePresetClick(preset.id)}
                aria-pressed={selected}
                aria-label={`风格：${preset.label}`}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md border border-border/60 bg-background p-1.5 transition-colors",
                  "hover:bg-accent",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  "disabled:pointer-events-none disabled:opacity-50",
                  selected && "ring-2 ring-ring ring-offset-1 ring-offset-background",
                )}
              >
                <PresetThumbnail presetId={preset.id} paletteId={theme.paletteId} />
                <span className="text-[11px] text-foreground">{preset.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 配色 */}
      <section className="flex flex-col gap-1.5">
        <div className="px-1 text-xs font-medium text-muted-foreground">配色</div>
        <div className="grid grid-cols-4 gap-1.5">
          {FLOWCHART_PALETTES.map((palette) => (
            <PaletteSwatch
              key={palette.id}
              palette={palette}
              selected={theme.paletteId === palette.id}
              disabled={readOnly}
              onClick={() => handlePaletteClick(palette.id)}
            />
          ))}
        </div>
      </section>

      {/* 清理手动样式确认 */}
      <AlertDialog
        open={pendingTheme !== null}
        onOpenChange={(open) => {
          if (!open) setPendingTheme(null);
        }}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>应用主题并清理手动样式？</AlertDialogTitle>
            <AlertDialogDescription>
              将清理 {manualStyleNodeCount} 个图形的手动颜色（填充、边框、文字），使其跟随新主题。
              字号、加粗等其他手动样式会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmApply}>应用主题</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 风格缩略图：用当前配色渲染矩形 + 菱形真实几何，预览 preset 效果 */
function PresetThumbnail({
  presetId,
  paletteId,
}: {
  presetId: FlowchartStylePresetId;
  paletteId: string;
}) {
  const defaults = resolveFlowchartThemeDefaults({
    stylePreset: presetId,
    paletteId,
    preserveManualStyles: true,
  });
  // default palette 返回空 → 回退 CSS token，与画布节点默认渲染一致
  const fill = defaults.fill ?? "hsl(var(--card))";
  const stroke = defaults.stroke ?? "hsl(var(--border))";
  return (
    <div className="flex h-9 items-center justify-center gap-1" aria-hidden="true">
      <svg viewBox="0 0 200 100" preserveAspectRatio="none" className="h-5 w-9">
        {renderFlowchartShape("process", { fill, stroke, strokeWidth: 1.5, cornerRadius: 4 })}
      </svg>
      <svg viewBox="0 0 200 100" preserveAspectRatio="none" className="h-5 w-9">
        {renderFlowchartShape("decision", { fill, stroke, strokeWidth: 1.5 })}
      </svg>
    </div>
  );
}

/** 配色缩略图：填充色块 + 描边 + 文字色（Aa），default 配色回退 CSS token */
function PaletteSwatch({
  palette,
  selected,
  disabled,
  onClick,
}: {
  palette: FlowchartPalette;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const isDefault = palette.id === "default";
  const fill = isDefault ? "hsl(var(--card))" : palette.fill;
  const stroke = isDefault ? "hsl(var(--border))" : palette.stroke;
  const text = isDefault ? "hsl(var(--foreground))" : palette.text;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`配色：${palette.label}`}
      className={cn(
        "flex flex-col items-center gap-1 rounded-md p-1 transition-colors",
        "hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:pointer-events-none disabled:opacity-50",
      )}
    >
      <span
        className={cn(
          "flex h-8 w-full items-center justify-center rounded-md text-[10px] font-medium",
          selected && "ring-2 ring-ring ring-offset-1 ring-offset-background",
        )}
        style={{ backgroundColor: fill, border: `1.5px solid ${stroke}`, color: text }}
      >
        Aa
      </span>
      <span className="text-[10px] text-muted-foreground">{palette.label}</span>
    </button>
  );
}
