/**
 * 流程图右侧属性面板（FC-UI-02 / FC-UI-03）。
 *
 * 面板状态：
 * - 无选区：页面样式（模式/页面尺寸/方向/背景/网格）；
 * - 单形状：图形样式（几何、旋转翻转、不透明度、锁定、文本、填充、边框、圆角）；
 * - 单连线：连线样式（label、颜色、宽度、虚线、路由、箭头）；
 * - 多形状：排列（对齐/分布/匹配大小）与公共样式（一致显示值，不一致显示“混合”）；
 * - pool/lane：容器几何 + 泳道属性占位（Batch 4 实现泳道专有字段）。
 *
 * 数值输入（FC-UI-03）：
 * - 输入期间允许临时空值，不把空输入自动写成 0；
 * - blur 或 Enter 时校验并提交；Esc 放弃；
 * - 非有限数值、负尺寸和超限值拒绝，保留原值；
 * - 不在每个键入字符上创建历史记录（仅提交时一次）。
 *
 * 本组件只读 FlowchartDocument 并上抛 patch，不维护第二份文档状态。
 */

import { useState } from "react";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowDown,
  ArrowUp,
  Bold,
  BringToFront,
  FlipHorizontal2,
  FlipVertical2,
  Italic,
  Lock,
  SendToBack,
  Underline,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import {
  isFlowchartContainerKind,
  type FlowchartCanvasSettings,
  type FlowchartDocument,
  type FlowchartEdgeStyle,
  type FlowchartNode,
  type FlowchartNodeStyle,
} from "./flowchart-document";
import type { FlowchartLayerAction } from "./flowchart-operations";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 几何属性 patch：粒度到字段，undefined 表示不修改该字段。 */
export interface FlowchartNodeGeometryPatch {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  /** 0-1；传 1 等同于清除不透明度覆盖 */
  opacity?: number;
  locked?: boolean;
}

export type FlowchartAlignMode = "left" | "center-h" | "right" | "top" | "center-v" | "bottom";

export interface FlowchartInspectorProps {
  document: FlowchartDocument;
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  readOnly?: boolean;
  onClose?: () => void;
  onCanvasSettingsChange: (patch: Partial<FlowchartCanvasSettings>) => void;
  onNodeGeometryChange: (patch: FlowchartNodeGeometryPatch) => void;
  onNodeStyleChange: (patch: Partial<FlowchartNodeStyle>) => void;
  onEdgeLabelChange: (label: string) => void;
  onEdgeStyleChange: (patch: Partial<FlowchartEdgeStyle>) => void;
  onAlign: (mode: FlowchartAlignMode) => void;
  onDistribute: (mode: "horizontal" | "vertical") => void;
  onMatchSize: (mode: "width" | "height" | "both") => void;
  onGroup: () => void;
  onUngroup: () => void;
  onReorder: (action: FlowchartLayerAction) => void;
  canGroup: boolean;
  canUngroup: boolean;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const FONT_FAMILY_OPTIONS = [
  { value: "", label: "默认字体" },
  { value: "SimSun, serif", label: "宋体" },
  { value: "Microsoft YaHei, sans-serif", label: "微软雅黑" },
  { value: "SimHei, sans-serif", label: "黑体" },
  { value: "KaiTi, serif", label: "楷体" },
  { value: "Inter, sans-serif", label: "Inter" },
  { value: "ui-monospace, monospace", label: "等宽" },
];

const FONT_SIZE_OPTIONS = [
  { value: "", label: "默认" },
  { value: "10", label: "10" },
  { value: "11", label: "11" },
  { value: "12", label: "12" },
  { value: "13", label: "13" },
  { value: "14", label: "14" },
  { value: "16", label: "16" },
  { value: "18", label: "18" },
  { value: "20", label: "20" },
  { value: "24", label: "24" },
  { value: "28", label: "28" },
  { value: "32", label: "32" },
  { value: "36", label: "36" },
  { value: "40", label: "40" },
  { value: "48", label: "48" },
];

const COLOR_PRESETS = [
  "#ffffff",
  "#f1f5f9",
  "#dbeafe",
  "#ede9fe",
  "#dcfce7",
  "#ffedd5",
  "#fee2e2",
  "#64748b",
  "#3b82f6",
  "#8b5cf6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#18181b",
];

const MIXED = Symbol("flowchart-inspector-mixed");
type MaybeMixed<T> = T | undefined | typeof MIXED;

/** 多选公共值：全部一致返回值，否则返回 MIXED。 */
function commonValue<T>(values: readonly T[]): MaybeMixed<T> {
  if (values.length === 0) return undefined;
  const first = values[0];
  return values.every((v) => v === first) ? first : MIXED;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// 基础控件
// ---------------------------------------------------------------------------

/**
 * 数值输入（FC-UI-03）：draft 为 null 表示非编辑态，显示外部值；
 * 输入期间允许任意文本（含空）；blur/Enter 校验提交，Esc 放弃；
 * 非有限、超出 min/max 一律拒绝并还原显示。
 */
function NumberField({
  value,
  mixed,
  onCommit,
  min,
  max,
  step,
  disabled,
  ariaLabel,
}: {
  value: number | undefined;
  mixed?: boolean;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? (mixed ? "" : value === undefined ? "" : String(round2(value)));

  const commit = () => {
    if (draft === null) return;
    const trimmed = draft.trim();
    let num = Number(trimmed);
    if (step !== undefined) num = Math.round(num / step) * step;
    const valid =
      trimmed !== "" &&
      Number.isFinite(num) &&
      (min === undefined || num >= min) &&
      (max === undefined || num <= max);
    if (valid && (mixed || num !== value)) onCommit(num);
    setDraft(null);
  };

  return (
    <Input
      type="text"
      inputMode="decimal"
      value={display}
      placeholder={mixed ? "混合" : undefined}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(null);
        }
      }}
      className="h-7 rounded-md px-2 text-xs"
    />
  );
}

/** 文本输入：blur/Enter 提交，Esc 放弃；空串提交为空串（由调用方决定语义）。 */
function TextField({
  value,
  onCommit,
  disabled,
  ariaLabel,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    if (draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <Input
      type="text"
      value={draft ?? value}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(null);
        }
      }}
      className="h-7 rounded-md px-2 text-xs"
    />
  );
}

/** 颜色字段：预设色板 + 十六进制输入 + 清除覆盖。undefined 表示跟随主题默认。 */
function ColorField({
  label,
  value,
  mixed,
  onCommit,
  disabled,
}: {
  label: string;
  value: string | undefined;
  mixed?: boolean;
  onCommit: (v: string | undefined) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commitHex = () => {
    if (draft === null) return;
    const t = draft.trim();
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t) || t === "transparent") {
      if (t !== value) onCommit(t);
    }
    setDraft(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        {value !== undefined && !disabled && (
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => onCommit(undefined)}
          >
            清除
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <div
          className="h-6 w-6 shrink-0 rounded-md border border-border/60"
          style={{ background: mixed ? "repeating-linear-gradient(45deg, #94a3b8 0 2px, transparent 2px 4px)" : (value ?? "transparent") }}
          aria-hidden="true"
        />
        <Input
          type="text"
          value={draft ?? (mixed ? "" : (value ?? ""))}
          placeholder={mixed ? "混合" : "默认"}
          disabled={disabled}
          aria-label={`${label}色值`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitHex();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(null);
            }
          }}
          className="h-7 flex-1 rounded-md px-2 text-xs"
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {COLOR_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            disabled={disabled}
            aria-label={`使用颜色 ${c}`}
            onClick={() => onCommit(c)}
            className={cn(
              "h-4 w-4 rounded-sm border border-border/60 transition-transform hover:scale-110",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              value === c && "ring-1 ring-ring",
              disabled && "opacity-40",
            )}
            style={{ background: c }}
          />
        ))}
      </div>
    </div>
  );
}

/** 开关式小图标按钮（加粗/斜体/翻转等）。 */
function ToggleIconButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? "secondary" : "outline"}
          size="icon"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className="h-7 w-7"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 px-3 py-3">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      {children}
    </section>
  );
}

/** 层级按钮组（FC-LAYER-01）：置顶/上移一层/下移一层/置底，单选与多选共用。 */
function LayerButtons({
  readOnly,
  onReorder,
}: {
  readOnly: boolean;
  onReorder: (action: FlowchartLayerAction) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <ToggleIconButton label="置顶" disabled={readOnly} onClick={() => onReorder("front")}>
        <BringToFront className="h-3.5 w-3.5" />
      </ToggleIconButton>
      <ToggleIconButton label="上移一层" disabled={readOnly} onClick={() => onReorder("forward")}>
        <ArrowUp className="h-3.5 w-3.5" />
      </ToggleIconButton>
      <ToggleIconButton label="下移一层" disabled={readOnly} onClick={() => onReorder("backward")}>
        <ArrowDown className="h-3.5 w-3.5" />
      </ToggleIconButton>
      <ToggleIconButton label="置底" disabled={readOnly} onClick={() => onReorder("back")}>
        <SendToBack className="h-3.5 w-3.5" />
      </ToggleIconButton>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function CheckRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-foreground">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
      />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function FlowchartInspector({
  document: doc,
  selectedNodeIds,
  selectedEdgeIds,
  readOnly = false,
  onClose,
  onCanvasSettingsChange,
  onNodeGeometryChange,
  onNodeStyleChange,
  onEdgeLabelChange,
  onEdgeStyleChange,
  onAlign,
  onDistribute,
  onMatchSize,
  onGroup,
  onUngroup,
  onReorder,
  canGroup,
  canUngroup,
}: FlowchartInspectorProps) {
  const selectedNodes = doc.nodes.filter((n) => selectedNodeIds.includes(n.id));
  const singleNode = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const singleEdge =
    selectedEdgesSingle(doc, selectedEdgeIds) ?? null;
  const isContainer = singleNode ? isFlowchartContainerKind(singleNode.kind) : false;

  const title = singleNode
    ? isContainer
      ? "容器"
      : "图形"
    : selectedNodes.length > 1
      ? `多选（${selectedNodes.length}）`
      : singleEdge
        ? "连线"
        : "页面";

  return (
    <div
      className="flex h-full w-64 shrink-0 flex-col border-l border-border/60 bg-background"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <span className="text-xs font-medium">{title}</span>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="关闭属性面板"
            onClick={onClose}
            className="h-6 w-6"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col divide-y divide-border/40">
          {selectedNodes.length === 0 && !singleEdge && (
            <PageSection
              canvas={doc.canvas}
              readOnly={readOnly}
              onChange={onCanvasSettingsChange}
            />
          )}

          {singleNode && !isContainer && (
            <SingleNodeSection
              node={singleNode}
              readOnly={readOnly}
              onGeometry={onNodeGeometryChange}
              onStyle={onNodeStyleChange}
              onReorder={onReorder}
            />
          )}

          {singleNode && isContainer && (
            <ContainerSection
              node={singleNode}
              readOnly={readOnly}
              onGeometry={onNodeGeometryChange}
              onReorder={onReorder}
              onUngroup={onUngroup}
            />
          )}

          {selectedNodes.length > 1 && (
            <MultiNodeSection
              nodes={selectedNodes}
              readOnly={readOnly}
              onStyle={onNodeStyleChange}
              onAlign={onAlign}
              onDistribute={onDistribute}
              onMatchSize={onMatchSize}
              onGroup={onGroup}
              onUngroup={onUngroup}
              onReorder={onReorder}
              canGroup={canGroup}
              canUngroup={canUngroup}
            />
          )}

          {singleEdge && (
            <EdgeSection
              edge={singleEdge}
              readOnly={readOnly}
              onLabel={onEdgeLabelChange}
              onStyle={onEdgeStyleChange}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function selectedEdgesSingle(doc: FlowchartDocument, edgeIds: string[]) {
  if (edgeIds.length !== 1) return null;
  return doc.edges.find((e) => e.id === edgeIds[0]) ?? null;
}

// ---------------------------------------------------------------------------
// 页面样式
// ---------------------------------------------------------------------------

const PAGE_SIZE_PRESETS = [
  { value: "a4-landscape", label: "A4 横向", width: 1169, height: 827 },
  { value: "a4-portrait", label: "A4 纵向", width: 827, height: 1169 },
  { value: "a3-landscape", label: "A3 横向", width: 1654, height: 1169 },
  { value: "16:9", label: "16:9", width: 1600, height: 900 },
  { value: "4:3", label: "4:3", width: 1200, height: 900 },
];

function PageSection({
  canvas,
  readOnly,
  onChange,
}: {
  canvas: FlowchartCanvasSettings;
  readOnly: boolean;
  onChange: (patch: Partial<FlowchartCanvasSettings>) => void;
}) {
  const isPage = canvas.mode === "page";
  const grid = canvas.grid;

  return (
    <>
      <Section title="画布">
        <FieldRow label="模式">
          <Select
            value={canvas.mode}
            disabled={readOnly}
            onValueChange={(v) => {
              const mode = v as "infinite" | "page";
              if (mode === "page") {
                const preset = PAGE_SIZE_PRESETS[0];
                onChange({
                  mode,
                  width: canvas.width ?? preset.width,
                  height: canvas.height ?? preset.height,
                  orientation: canvas.orientation ?? "landscape",
                });
              } else {
                onChange({ mode });
              }
            }}
            options={[
              { value: "infinite", label: "无限画布" },
              { value: "page", label: "页面" },
            ]}
          />
        </FieldRow>
        {isPage && (
          <>
            <FieldRow label="页面尺寸">
              <Select
                value=""
                disabled={readOnly}
                placeholder="选择预设"
                onValueChange={(v) => {
                  const preset = PAGE_SIZE_PRESETS.find((p) => p.value === v);
                  if (!preset) return;
                  onChange({
                    width: preset.width,
                    height: preset.height,
                    orientation: preset.width >= preset.height ? "landscape" : "portrait",
                  });
                }}
                options={PAGE_SIZE_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
              />
            </FieldRow>
            <div className="grid grid-cols-2 gap-2">
              <FieldRow label="宽">
                <NumberField
                  value={canvas.width}
                  min={100}
                  max={10000}
                  disabled={readOnly}
                  ariaLabel="页面宽度"
                  onCommit={(v) => onChange({ width: v })}
                />
              </FieldRow>
              <FieldRow label="高">
                <NumberField
                  value={canvas.height}
                  min={100}
                  max={10000}
                  disabled={readOnly}
                  ariaLabel="页面高度"
                  onCommit={(v) => onChange({ height: v })}
                />
              </FieldRow>
            </div>
            <FieldRow label="方向">
              <Select
                value={canvas.orientation ?? "landscape"}
                disabled={readOnly}
                onValueChange={(v) => onChange({ orientation: v as "portrait" | "landscape" })}
                options={[
                  { value: "landscape", label: "横向" },
                  { value: "portrait", label: "纵向" },
                ]}
              />
            </FieldRow>
          </>
        )}
        <ColorField
          label="背景"
          value={canvas.background}
          disabled={readOnly}
          onCommit={(v) => onChange({ background: v })}
        />
      </Section>

      <Section title="网格">
        <CheckRow
          label="显示网格"
          checked={grid.visible}
          disabled={readOnly}
          onChange={(v) => onChange({ grid: { ...grid, visible: v } })}
        />
        <CheckRow
          label="吸附到网格"
          checked={grid.snap}
          disabled={readOnly}
          onChange={(v) => onChange({ grid: { ...grid, snap: v } })}
        />
        <FieldRow label="网格大小">
          <NumberField
            value={grid.size}
            min={4}
            max={64}
            disabled={readOnly}
            ariaLabel="网格大小"
            onCommit={(v) => onChange({ grid: { ...grid, size: v } })}
          />
        </FieldRow>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 单形状
// ---------------------------------------------------------------------------

/** 支持圆角半径调整的形状 kind。 */
const CORNER_RADIUS_KINDS = new Set(["rectangle", "rounded-rectangle"]);

function SingleNodeSection({
  node,
  readOnly,
  onGeometry,
  onStyle,
  onReorder,
}: {
  node: FlowchartNode;
  readOnly: boolean;
  onGeometry: (patch: FlowchartNodeGeometryPatch) => void;
  onStyle: (patch: Partial<FlowchartNodeStyle>) => void;
  onReorder: (action: FlowchartLayerAction) => void;
}) {
  const s = node.style ?? {};
  const locked = !!node.locked;
  const geomDisabled = readOnly || locked;
  const size = node.size ?? { width: 200, height: 100 };
  const showCornerRadius = CORNER_RADIUS_KINDS.has(node.kind);

  return (
    <>
      <Section title="层级">
        <LayerButtons readOnly={readOnly} onReorder={onReorder} />
      </Section>
      <Section title="位置与尺寸">
        <div className="grid grid-cols-2 gap-2">
          <FieldRow label="X">
            <NumberField
              value={node.position.x}
              disabled={geomDisabled}
              ariaLabel="X 坐标"
              onCommit={(v) => onGeometry({ x: v })}
            />
          </FieldRow>
          <FieldRow label="Y">
            <NumberField
              value={node.position.y}
              disabled={geomDisabled}
              ariaLabel="Y 坐标"
              onCommit={(v) => onGeometry({ y: v })}
            />
          </FieldRow>
          <FieldRow label="宽">
            <NumberField
              value={size.width}
              min={4}
              max={5000}
              disabled={geomDisabled}
              ariaLabel="宽度"
              onCommit={(v) => onGeometry({ width: v })}
            />
          </FieldRow>
          <FieldRow label="高">
            <NumberField
              value={size.height}
              min={4}
              max={5000}
              disabled={geomDisabled}
              ariaLabel="高度"
              onCommit={(v) => onGeometry({ height: v })}
            />
          </FieldRow>
        </div>
        <FieldRow label="旋转">
          <NumberField
            value={node.rotation ?? 0}
            min={0}
            max={359}
            disabled={geomDisabled}
            ariaLabel="旋转角度"
            onCommit={(v) => onGeometry({ rotation: v })}
          />
        </FieldRow>
        <div className="flex items-center gap-1.5">
          <ToggleIconButton
            label="水平翻转"
            active={!!node.flipX}
            disabled={geomDisabled}
            onClick={() => onGeometry({ flipX: !node.flipX })}
          >
            <FlipHorizontal2 className="h-3.5 w-3.5" />
          </ToggleIconButton>
          <ToggleIconButton
            label="垂直翻转"
            active={!!node.flipY}
            disabled={geomDisabled}
            onClick={() => onGeometry({ flipY: !node.flipY })}
          >
            <FlipVertical2 className="h-3.5 w-3.5" />
          </ToggleIconButton>
          <Separator orientation="vertical" className="mx-1 h-4" />
          <ToggleIconButton
            label={locked ? "解锁（允许移动和缩放）" : "锁定（禁止移动和缩放）"}
            active={locked}
            disabled={readOnly}
            onClick={() => onGeometry({ locked: !locked })}
          >
            <Lock className="h-3.5 w-3.5" />
          </ToggleIconButton>
        </div>
        <FieldRow label="不透明">
          <NumberField
            value={Math.round((node.opacity ?? 1) * 100)}
            min={0}
            max={100}
            disabled={readOnly}
            ariaLabel="不透明度百分比"
            onCommit={(v) => onGeometry({ opacity: v / 100 })}
          />
        </FieldRow>
      </Section>

      <Section title="文本">
        <FieldRow label="字体">
          <Select
            value={s.fontFamily ?? ""}
            disabled={readOnly}
            onValueChange={(v) => onStyle({ fontFamily: v || undefined })}
            options={FONT_FAMILY_OPTIONS}
          />
        </FieldRow>
        <div className="grid grid-cols-2 gap-2">
          <FieldRow label="字号">
            <Select
              value={s.fontSize != null ? String(s.fontSize) : ""}
              disabled={readOnly}
              onValueChange={(v) => onStyle({ fontSize: v ? Number(v) : undefined })}
              options={FONT_SIZE_OPTIONS}
            />
          </FieldRow>
          <FieldRow label="行高">
            <NumberField
              value={s.lineHeight ?? 1.5}
              min={0.8}
              max={3}
              step={0.1}
              disabled={readOnly}
              ariaLabel="行高倍数"
              onCommit={(v) => onStyle({ lineHeight: v })}
            />
          </FieldRow>
        </div>
        <div className="flex items-center gap-1.5">
          <ToggleIconButton
            label="加粗"
            active={!!s.bold}
            disabled={readOnly}
            onClick={() => onStyle({ bold: !s.bold })}
          >
            <Bold className="h-3.5 w-3.5" />
          </ToggleIconButton>
          <ToggleIconButton
            label="斜体"
            active={!!s.italic}
            disabled={readOnly}
            onClick={() => onStyle({ italic: !s.italic })}
          >
            <Italic className="h-3.5 w-3.5" />
          </ToggleIconButton>
          <ToggleIconButton
            label="下划线"
            active={!!s.underline}
            disabled={readOnly}
            onClick={() => onStyle({ underline: !s.underline })}
          >
            <Underline className="h-3.5 w-3.5" />
          </ToggleIconButton>
          <Separator orientation="vertical" className="mx-1 h-4" />
          <ToggleIconButton
            label="文字左对齐"
            active={s.textAlign === "left"}
            disabled={readOnly}
            onClick={() => onStyle({ textAlign: s.textAlign === "left" ? undefined : "left" })}
          >
            <AlignLeft className="h-3.5 w-3.5" />
          </ToggleIconButton>
          <ToggleIconButton
            label="文字居中"
            active={!s.textAlign || s.textAlign === "center"}
            disabled={readOnly}
            onClick={() => onStyle({ textAlign: undefined })}
          >
            <AlignCenter className="h-3.5 w-3.5" />
          </ToggleIconButton>
          <ToggleIconButton
            label="文字右对齐"
            active={s.textAlign === "right"}
            disabled={readOnly}
            onClick={() => onStyle({ textAlign: s.textAlign === "right" ? undefined : "right" })}
          >
            <AlignRight className="h-3.5 w-3.5" />
          </ToggleIconButton>
        </div>
        <FieldRow label="垂直对齐">
          <Select
            value={s.verticalAlign ?? "middle"}
            disabled={readOnly}
            onValueChange={(v) =>
              onStyle({ verticalAlign: v === "middle" ? undefined : (v as "top" | "bottom") })
            }
            options={[
              { value: "top", label: "顶部" },
              { value: "middle", label: "居中（默认）" },
              { value: "bottom", label: "底部" },
            ]}
          />
        </FieldRow>
        <ColorField
          label="文字颜色"
          value={s.color}
          disabled={readOnly}
          onCommit={(v) => onStyle({ color: v })}
        />
      </Section>

      <Section title="填充与边框">
        <ColorField
          label="填充"
          value={s.fill}
          disabled={readOnly}
          onCommit={(v) => onStyle({ fill: v })}
        />
        <ColorField
          label="边框颜色"
          value={s.borderColor}
          disabled={readOnly}
          onCommit={(v) => onStyle({ borderColor: v })}
        />
        <div className="grid grid-cols-2 gap-2">
          <FieldRow label="线宽">
            <NumberField
              value={s.borderWidth}
              min={0.5}
              max={10}
              disabled={readOnly}
              ariaLabel="边框宽度"
              onCommit={(v) => onStyle({ borderWidth: v })}
            />
          </FieldRow>
          {showCornerRadius && (
            <FieldRow label="圆角">
              <NumberField
                value={s.cornerRadius}
                min={0}
                max={99}
                disabled={readOnly}
                ariaLabel="圆角半径"
                onCommit={(v) => onStyle({ cornerRadius: v })}
              />
            </FieldRow>
          )}
        </div>
        <FieldRow label="线型">
          <Select
            value={s.borderStyle ?? "solid"}
            disabled={readOnly}
            onValueChange={(v) =>
              onStyle({ borderStyle: v === "solid" ? undefined : (v as "dashed" | "dotted") })
            }
            options={[
              { value: "solid", label: "实线（默认）" },
              { value: "dashed", label: "虚线" },
              { value: "dotted", label: "点线" },
            ]}
          />
        </FieldRow>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 容器（group / pool / lane）
// ---------------------------------------------------------------------------

function ContainerSection({
  node,
  readOnly,
  onGeometry,
  onReorder,
  onUngroup,
}: {
  node: FlowchartNode;
  readOnly: boolean;
  onGeometry: (patch: FlowchartNodeGeometryPatch) => void;
  onReorder: (action: FlowchartLayerAction) => void;
  onUngroup: () => void;
}) {
  const size = node.size ?? { width: 600, height: 300 };
  const locked = !!node.locked;
  const geomDisabled = readOnly || locked;
  return (
    <>
      <Section title="层级">
        <LayerButtons readOnly={readOnly} onReorder={onReorder} />
        {node.kind === "group" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 w-full text-xs"
            disabled={readOnly}
            onClick={onUngroup}
          >
            取消组合
          </Button>
        )}
      </Section>
      <Section title="位置与尺寸">
        <div className="grid grid-cols-2 gap-2">
          <FieldRow label="X">
            <NumberField
              value={node.position.x}
              disabled={geomDisabled}
              ariaLabel="X 坐标"
              onCommit={(v) => onGeometry({ x: v })}
            />
          </FieldRow>
          <FieldRow label="Y">
            <NumberField
              value={node.position.y}
              disabled={geomDisabled}
              ariaLabel="Y 坐标"
              onCommit={(v) => onGeometry({ y: v })}
            />
          </FieldRow>
          <FieldRow label="宽">
            <NumberField
              value={size.width}
              min={40}
              max={8000}
              disabled={geomDisabled}
              ariaLabel="宽度"
              onCommit={(v) => onGeometry({ width: v })}
            />
          </FieldRow>
          <FieldRow label="高">
            <NumberField
              value={size.height}
              min={40}
              max={8000}
              disabled={geomDisabled}
              ariaLabel="高度"
              onCommit={(v) => onGeometry({ height: v })}
            />
          </FieldRow>
        </div>
        <CheckRow
          label="锁定"
          checked={locked}
          disabled={readOnly}
          onChange={(v) => onGeometry({ locked: v })}
        />
      </Section>
      <Section title="泳道属性">
        <div className="text-xs text-muted-foreground">
          泳道方向、标题栏和泳道管理将在下一批次提供。
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 多选
// ---------------------------------------------------------------------------

function MultiNodeSection({
  nodes,
  readOnly,
  onStyle,
  onAlign,
  onDistribute,
  onMatchSize,
  onGroup,
  onUngroup,
  onReorder,
  canGroup,
  canUngroup,
}: {
  nodes: FlowchartNode[];
  readOnly: boolean;
  onStyle: (patch: Partial<FlowchartNodeStyle>) => void;
  onAlign: (mode: FlowchartAlignMode) => void;
  onDistribute: (mode: "horizontal" | "vertical") => void;
  onMatchSize: (mode: "width" | "height" | "both") => void;
  onGroup: () => void;
  onUngroup: () => void;
  onReorder: (action: FlowchartLayerAction) => void;
  canGroup: boolean;
  canUngroup: boolean;
}) {
  const fill = commonValue(nodes.map((n) => n.style?.fill));
  const borderColor = commonValue(nodes.map((n) => n.style?.borderColor));
  const color = commonValue(nodes.map((n) => n.style?.color));
  const fontSize = commonValue(nodes.map((n) => n.style?.fontSize));

  return (
    <>
      <Section title="组合与层级">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 flex-1 text-xs"
            disabled={readOnly || !canGroup}
            onClick={onGroup}
          >
            组合
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 flex-1 text-xs"
            disabled={readOnly || !canUngroup}
            onClick={onUngroup}
          >
            取消组合
          </Button>
        </div>
        <LayerButtons readOnly={readOnly} onReorder={onReorder} />
      </Section>

      <Section title="对齐">
        <div className="flex items-center gap-1">
          <ToggleIconButton label="左对齐" disabled={readOnly} onClick={() => onAlign("left")}>
            <AlignStartVertical className="h-3.5 w-3.5" />
          </ToggleIconButton>
          <ToggleIconButton label="水平居中" disabled={readOnly} onClick={() => onAlign("center-h")}>
            <AlignCenterVertical className="h-3.5 w-3.5" />
          </ToggleIconButton>
          <ToggleIconButton label="右对齐" disabled={readOnly} onClick={() => onAlign("right")}>
            <AlignEndVertical className="h-3.5 w-3.5" />
          </ToggleIconButton>
          <ToggleIconButton label="顶对齐" disabled={readOnly} onClick={() => onAlign("top")}>
            <AlignStartHorizontal className="h-3.5 w-3.5" />
          </ToggleIconButton>
          <ToggleIconButton label="垂直居中" disabled={readOnly} onClick={() => onAlign("center-v")}>
            <AlignCenterHorizontal className="h-3.5 w-3.5" />
          </ToggleIconButton>
          <ToggleIconButton label="底对齐" disabled={readOnly} onClick={() => onAlign("bottom")}>
            <AlignEndHorizontal className="h-3.5 w-3.5" />
          </ToggleIconButton>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 flex-1 text-xs"
            disabled={readOnly || nodes.length < 3}
            onClick={() => onDistribute("horizontal")}
          >
            水平分布
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 flex-1 text-xs"
            disabled={readOnly || nodes.length < 3}
            onClick={() => onDistribute("vertical")}
          >
            垂直分布
          </Button>
        </div>
      </Section>

      <Section title="匹配大小（以首个选中为基准）">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 flex-1 text-xs"
            disabled={readOnly}
            onClick={() => onMatchSize("width")}
          >
            同宽
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 flex-1 text-xs"
            disabled={readOnly}
            onClick={() => onMatchSize("height")}
          >
            同高
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 flex-1 text-xs"
            disabled={readOnly}
            onClick={() => onMatchSize("both")}
          >
            同大小
          </Button>
        </div>
      </Section>

      <Section title="公共样式">
        <ColorField
          label="填充"
          value={fill === MIXED ? undefined : fill}
          mixed={fill === MIXED}
          disabled={readOnly}
          onCommit={(v) => onStyle({ fill: v })}
        />
        <ColorField
          label="边框颜色"
          value={borderColor === MIXED ? undefined : borderColor}
          mixed={borderColor === MIXED}
          disabled={readOnly}
          onCommit={(v) => onStyle({ borderColor: v })}
        />
        <ColorField
          label="文字颜色"
          value={color === MIXED ? undefined : color}
          mixed={color === MIXED}
          disabled={readOnly}
          onCommit={(v) => onStyle({ color: v })}
        />
        <FieldRow label="字号">
          <Select
            value={fontSize === MIXED || fontSize == null ? "" : String(fontSize)}
            disabled={readOnly}
            onValueChange={(v) => onStyle({ fontSize: v ? Number(v) : undefined })}
            options={FONT_SIZE_OPTIONS}
          />
        </FieldRow>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 连线
// ---------------------------------------------------------------------------

function EdgeSection({
  edge,
  readOnly,
  onLabel,
  onStyle,
}: {
  edge: FlowchartDocument["edges"][number];
  readOnly: boolean;
  onLabel: (label: string) => void;
  onStyle: (patch: Partial<FlowchartEdgeStyle>) => void;
}) {
  const s = edge.style ?? {};
  return (
    <Section title="连线样式">
      <FieldRow label="标签">
        <TextField
          value={edge.label ?? ""}
          disabled={readOnly}
          ariaLabel="连线标签"
          placeholder="无标签"
          onCommit={onLabel}
        />
      </FieldRow>
      <ColorField
        label="线条颜色"
        value={s.stroke}
        disabled={readOnly}
        onCommit={(v) => onStyle({ stroke: v })}
      />
      <FieldRow label="线宽">
        <NumberField
          value={s.strokeWidth}
          min={0.5}
          max={10}
          disabled={readOnly}
          ariaLabel="线宽"
          onCommit={(v) => onStyle({ strokeWidth: v })}
        />
      </FieldRow>
      <FieldRow label="线型">
        <Select
          value={s.strokeDasharray ?? "solid"}
          disabled={readOnly}
          onValueChange={(v) =>
            onStyle({ strokeDasharray: v === "solid" ? undefined : (v as "dashed" | "dotted") })
          }
          options={[
            { value: "solid", label: "实线（默认）" },
            { value: "dashed", label: "虚线" },
            { value: "dotted", label: "点线" },
          ]}
        />
      </FieldRow>
      <FieldRow label="路由">
        <Select
          value={s.route ?? "smoothstep"}
          disabled={readOnly}
          onValueChange={(v) =>
            onStyle({ route: v === "smoothstep" ? undefined : (v as "bezier" | "straight") })
          }
          options={[
            { value: "smoothstep", label: "圆角折线（默认）" },
            { value: "bezier", label: "贝塞尔曲线" },
            { value: "straight", label: "直线" },
          ]}
        />
      </FieldRow>
      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="起点">
          <Select
            value={s.markerStart ?? "none"}
            disabled={readOnly}
            onValueChange={(v) =>
              onStyle({ markerStart: v === "none" ? undefined : (v as "arrow" | "arrowclosed") })
            }
            options={[
              { value: "none", label: "无（默认）" },
              { value: "arrow", label: "开放箭头" },
              { value: "arrowclosed", label: "实心箭头" },
            ]}
          />
        </FieldRow>
        <FieldRow label="终点">
          <Select
            value={s.markerEnd ?? "arrowclosed"}
            disabled={readOnly}
            onValueChange={(v) =>
              onStyle({ markerEnd: v === "arrowclosed" ? undefined : (v as "none" | "arrow") })
            }
            options={[
              { value: "arrowclosed", label: "实心箭头（默认）" },
              { value: "arrow", label: "开放箭头" },
              { value: "none", label: "无" },
            ]}
          />
        </FieldRow>
      </div>
    </Section>
  );
}
