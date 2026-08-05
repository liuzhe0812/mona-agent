import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  DEFAULT_TEXT_STYLE,
  DIAGRAM_KINDS,
  ENDPOINT_MARKERS,
  SHAPE_KINDS,
  type DiagramConnector,
  type DiagramContainerElement,
  type DiagramDocument,
  type DiagramElement,
  type DiagramGroupElement,
  type DiagramShapeElement,
  type DiagramStroke,
  type DiagramTextBlock,
  type DiagramTextElement,
  type DiagramTextStyle,
  type Paint,
} from "./diagram-document";

const SHAPE_LABELS: Record<string, string> = {
  rectangle: "矩形", "rounded-rectangle": "圆角矩形", ellipse: "椭圆", circle: "圆形",
  pill: "胶囊", diamond: "菱形", hexagon: "六边形", parallelogram: "平行四边形",
  cylinder: "圆柱", document: "文档", "multi-document": "多文档", cloud: "云",
  actor: "角色", callout: "标注", chevron: "箭头", pentagon: "五边形",
  trapezoid: "梯形", process: "处理", subprocess: "子流程", database: "数据库",
  junction: "连接点", "predefined-process": "预定义流程", "manual-input": "手动输入",
  delay: "延迟", display: "显示", "off-page-connector": "页外连接符",
  "internal-storage": "内部存储", "stored-data": "存储数据",
};

const MARKER_LABELS: Record<string, string> = {
  none: "无", "arrow-open": "开放箭头", "arrow-closed": "闭合箭头", triangle: "三角形",
  circle: "圆形", "diamond-open": "开放菱形", "diamond-filled": "实心菱形", bar: "条形",
  "er-one": "一", "er-one-many": "一对多", "er-many": "多",
};

const DIAGRAM_KIND_LABELS: Record<string, string> = {
  freeform: "自由", flowchart: "流程图", swimlane: "泳道", framework: "框架",
  architecture: "架构", deployment: "部署", sequence: "时序", erd: "ER 图",
  class: "类图", state: "状态图", usecase: "用例图", orgchart: "组织架构",
  timeline: "时间线", matrix: "矩阵",
};

const SHAPE_OPTIONS: SelectOption[] = SHAPE_KINDS.map((k) => ({ value: k, label: SHAPE_LABELS[k] ?? k }));
const MARKER_OPTIONS: SelectOption[] = ENDPOINT_MARKERS.map((m) => ({ value: m, label: MARKER_LABELS[m] ?? m }));
const DIAGRAM_KIND_OPTIONS: SelectOption[] = DIAGRAM_KINDS.map((k) => ({ value: k, label: DIAGRAM_KIND_LABELS[k] ?? k }));
const STROKE_STYLE_OPTIONS: SelectOption[] = [{ value: "solid", label: "实线" }, { value: "dashed", label: "虚线" }, { value: "dotted", label: "点线" }];
const ROUTE_OPTIONS: SelectOption[] = [{ value: "straight", label: "直线" }, { value: "orthogonal", label: "折线" }, { value: "bezier", label: "曲线" }];
const FONT_WEIGHT_OPTIONS: SelectOption[] = [{ value: "400", label: "常规" }, { value: "500", label: "中等" }, { value: "600", label: "半粗" }, { value: "700", label: "粗体" }];
const ALIGN_OPTIONS: SelectOption[] = [{ value: "left", label: "左对齐" }, { value: "center", label: "居中" }, { value: "right", label: "右对齐" }];
const CANVAS_MODE_OPTIONS: SelectOption[] = [{ value: "infinite", label: "无限画布" }, { value: "page", label: "页面" }];
const BOOL_OPTIONS: SelectOption[] = [{ value: "true", label: "是" }, { value: "false", label: "否" }];

const ELEMENT_TITLES: Record<string, string> = {
  shape: "形状属性", text: "文本属性", group: "分组属性", container: "容器属性",
  icon: "图标属性", image: "图片属性", brace: "括号属性", table: "表格属性",
  lifeline: "生命线属性", activation: "激活条属性", freehand: "手绘属性",
};

function paintColor(paint?: Paint): string {
  return paint?.type === "solid" ? paint.color : "";
}
function setPaintColor(c: string): Paint {
  return c ? { type: "solid", color: c } : { type: "none" };
}
function firstText(blocks?: DiagramTextBlock[]): string {
  return blocks?.[0]?.text ?? "";
}
function patchFirstText(blocks: DiagramTextBlock[], text: string): DiagramTextBlock[] {
  if (!blocks.length) return [{ id: "t0", kind: "paragraph", text }];
  return blocks.map((b, i) => (i === 0 ? { ...b, text } : b));
}
function patchStroke(s: DiagramStroke | undefined, p: Partial<DiagramStroke>): DiagramStroke {
  return { color: s?.color ?? "#000000", width: s?.width ?? 1, style: s?.style ?? "solid", ...p };
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={cn("h-8 w-8 shrink-0 rounded-md border border-input", !value && "bg-muted/30")}
        style={value ? { backgroundColor: value } : undefined}
        aria-label="颜色预览"
      />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="#000000" />
    </div>
  );
}

function TextStyleFields({ style, onChange }: { style: Partial<DiagramTextStyle>; onChange: (p: Partial<DiagramTextStyle>) => void }) {
  return (
    <>
      <Field label="字号">
        <Input type="number" value={style.fontSize ?? DEFAULT_TEXT_STYLE.fontSize} onChange={(e) => onChange({ fontSize: e.target.valueAsNumber || 0 })} />
      </Field>
      <Field label="字重">
        <Select value={String(style.fontWeight ?? DEFAULT_TEXT_STYLE.fontWeight)} onValueChange={(v) => onChange({ fontWeight: Number(v) as DiagramTextStyle["fontWeight"] })} options={FONT_WEIGHT_OPTIONS} />
      </Field>
      <Field label="文字颜色">
        <ColorInput value={style.color ?? DEFAULT_TEXT_STYLE.color} onChange={(v) => onChange({ color: v })} />
      </Field>
      <Field label="对齐">
        <Select value={style.align ?? DEFAULT_TEXT_STYLE.align} onValueChange={(v) => onChange({ align: v as DiagramTextStyle["align"] })} options={ALIGN_OPTIONS} />
      </Field>
    </>
  );
}

export interface DiagramInspectorProps {
  document: DiagramDocument;
  selection: { elementIds: string[]; connectorIds: string[] };
  onUpdateElement: (id: string, patch: Record<string, unknown>) => void;
  onUpdateConnector: (id: string, patch: Record<string, unknown>) => void;
  onUpdateDocument?: (patch: Record<string, unknown>) => void;
  onGroup?: (ids: string[]) => void;
  onUngroup?: (ids: string[]) => void;
}

export function DiagramInspector({
  document, selection, onUpdateElement, onUpdateConnector, onUpdateDocument, onGroup, onUngroup,
}: DiagramInspectorProps) {
  const els = selection.elementIds
    .map((id) => document.elements.find((e) => e.id === id))
    .filter((e): e is DiagramElement => !!e);
  const conns = selection.connectorIds
    .map((id) => document.connectors.find((c) => c.id === id))
    .filter((c): c is DiagramConnector => !!c);
  const total = els.length + conns.length;

  let title: string;
  let body: ReactNode;

  if (total === 0) {
    title = "文档属性";
    body = <DocumentInspector document={document} onUpdate={onUpdateDocument} />;
  } else if (total === 1 && els.length === 1) {
    const el = els[0];
    title = ELEMENT_TITLES[el.type] ?? "属性";
    body =
      el.type === "shape" ? <ShapeInspector element={el} onUpdate={onUpdateElement} />
      : el.type === "text" ? <TextInspector element={el} onUpdate={onUpdateElement} />
      : el.type === "group" || el.type === "container" ? <GroupInspector element={el as DiagramGroupElement | DiagramContainerElement} onUpdate={onUpdateElement} />
      : <p className="text-xs text-muted-foreground">该元素类型暂不支持属性编辑</p>;
  } else if (total === 1 && conns.length === 1) {
    title = "连接线属性";
    body = <ConnectorInspector connector={conns[0]} onUpdate={onUpdateConnector} />;
  } else {
    title = `已选 ${total} 个对象`;
    body = <MultiSelectInspector elementIds={selection.elementIds} onGroup={onGroup} onUngroup={onUngroup} />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center px-3">
        <span className="text-sm font-medium text-foreground">{title}</span>
      </div>
      <Separator />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-3">
        <div className="flex flex-col gap-3">{body}</div>
      </div>
    </div>
  );
}

function ShapeInspector({ element, onUpdate }: { element: DiagramShapeElement; onUpdate: (id: string, p: Record<string, unknown>) => void }) {
  const ts = element.textStyle ?? {};
  return (
    <>
      <Field label="形状类型">
        <Select value={element.shapeKind} onValueChange={(v) => onUpdate(element.id, { shapeKind: v })} options={SHAPE_OPTIONS} />
      </Field>
      <Separator />
      <Field label="填充颜色">
        <ColorInput value={paintColor(element.fill)} onChange={(v) => onUpdate(element.id, { fill: setPaintColor(v) })} />
      </Field>
      <Field label="描边颜色">
        <ColorInput value={element.stroke?.color ?? ""} onChange={(v) => onUpdate(element.id, { stroke: patchStroke(element.stroke, { color: v }) })} />
      </Field>
      <Field label="描边宽度">
        <Input type="number" value={element.stroke?.width ?? 1} onChange={(e) => onUpdate(element.id, { stroke: patchStroke(element.stroke, { width: e.target.valueAsNumber || 1 }) })} />
      </Field>
      <Field label="描边样式">
        <Select value={element.stroke?.style ?? "solid"} onValueChange={(v) => onUpdate(element.id, { stroke: patchStroke(element.stroke, { style: v as DiagramStroke["style"] }) })} options={STROKE_STYLE_OPTIONS} />
      </Field>
      <Field label="圆角">
        <Input type="number" value={element.cornerRadius ?? 0} onChange={(e) => onUpdate(element.id, { cornerRadius: e.target.valueAsNumber || 0 })} />
      </Field>
      <Separator />
      <Field label="文本内容">
        <Textarea value={firstText(element.textBlocks)} onChange={(e) => onUpdate(element.id, { textBlocks: patchFirstText(element.textBlocks, e.target.value) })} />
      </Field>
      <TextStyleFields style={ts} onChange={(p) => onUpdate(element.id, { textStyle: { ...ts, ...p } })} />
    </>
  );
}

function TextInspector({ element, onUpdate }: { element: DiagramTextElement; onUpdate: (id: string, p: Record<string, unknown>) => void }) {
  const ts = element.textStyle ?? {};
  return (
    <>
      <Field label="文本内容">
        <Textarea value={firstText(element.textBlocks)} onChange={(e) => onUpdate(element.id, { textBlocks: patchFirstText(element.textBlocks, e.target.value) })} />
      </Field>
      <Separator />
      <TextStyleFields style={ts} onChange={(p) => onUpdate(element.id, { textStyle: { ...ts, ...p } })} />
    </>
  );
}

function ConnectorInspector({ connector, onUpdate }: { connector: DiagramConnector; onUpdate: (id: string, p: Record<string, unknown>) => void }) {
  const s = connector.stroke;
  return (
    <>
      <Field label="路由类型">
        <Select value={connector.route} onValueChange={(v) => onUpdate(connector.id, { route: v })} options={ROUTE_OPTIONS} />
      </Field>
      <Separator />
      <Field label="起始端点">
        <Select value={connector.markerStart} onValueChange={(v) => onUpdate(connector.id, { markerStart: v })} options={MARKER_OPTIONS} />
      </Field>
      <Field label="结束端点">
        <Select value={connector.markerEnd} onValueChange={(v) => onUpdate(connector.id, { markerEnd: v })} options={MARKER_OPTIONS} />
      </Field>
      <Separator />
      <Field label="描边颜色">
        <ColorInput value={s.color} onChange={(v) => onUpdate(connector.id, { stroke: { ...s, color: v } })} />
      </Field>
      <Field label="描边宽度">
        <Input type="number" value={s.width} onChange={(e) => onUpdate(connector.id, { stroke: { ...s, width: e.target.valueAsNumber || 1 } })} />
      </Field>
      <Field label="描边样式">
        <Select value={s.style} onValueChange={(v) => onUpdate(connector.id, { stroke: { ...s, style: v as DiagramStroke["style"] } })} options={STROKE_STYLE_OPTIONS} />
      </Field>
      <Separator />
      <Field label="标签文本">
        <Textarea value={firstText(connector.label)} onChange={(e) => onUpdate(connector.id, { label: patchFirstText(connector.label ?? [], e.target.value) })} />
      </Field>
    </>
  );
}

function GroupInspector({ element, onUpdate }: { element: DiagramGroupElement | DiagramContainerElement; onUpdate: (id: string, p: Record<string, unknown>) => void }) {
  return (
    <>
      <Field label="标题">
        <Input value={element.title ?? ""} onChange={(e) => onUpdate(element.id, { title: e.target.value })} />
      </Field>
      <Field label="背景色">
        <ColorInput value={paintColor(element.background)} onChange={(v) => onUpdate(element.id, { background: setPaintColor(v) })} />
      </Field>
    </>
  );
}

function DocumentInspector({ document, onUpdate }: { document: DiagramDocument; onUpdate?: (p: Record<string, unknown>) => void }) {
  const c = document.canvas;
  const setCanvas = (patch: Partial<typeof c>) => onUpdate?.({ canvas: { ...c, ...patch } });
  return (
    <>
      <Field label="图表类型">
        <Select value={document.diagramKind} onValueChange={(v) => onUpdate?.({ diagramKind: v })} options={DIAGRAM_KIND_OPTIONS} disabled={!onUpdate} />
      </Field>
      <Separator />
      <Field label="画布模式">
        <Select value={c.mode} onValueChange={(v) => setCanvas({ mode: v as "infinite" | "page" })} options={CANVAS_MODE_OPTIONS} disabled={!onUpdate} />
      </Field>
      <Field label="显示网格">
        <Select value={String(c.grid.visible)} onValueChange={(v) => setCanvas({ grid: { ...c.grid, visible: v === "true" } })} options={BOOL_OPTIONS} disabled={!onUpdate} />
      </Field>
      <Field label="网格吸附">
        <Select value={String(c.grid.snap)} onValueChange={(v) => setCanvas({ grid: { ...c.grid, snap: v === "true" } })} options={BOOL_OPTIONS} disabled={!onUpdate} />
      </Field>
      <Field label="网格大小">
        <Input type="number" value={c.grid.size} disabled={!onUpdate} onChange={(e) => setCanvas({ grid: { ...c.grid, size: e.target.valueAsNumber || 8 } })} />
      </Field>
    </>
  );
}

function MultiSelectInspector({ elementIds, onGroup, onUngroup }: { elementIds: string[]; onGroup?: (ids: string[]) => void; onUngroup?: (ids: string[]) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" disabled={!onGroup} onClick={() => onGroup?.(elementIds)}>组合</Button>
      <Button variant="outline" disabled={!onUngroup} onClick={() => onUngroup?.(elementIds)}>取消组合</Button>
    </div>
  );
}