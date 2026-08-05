/**
 * 流程图画布左侧工具栏（浮动 Rail + 抽屉模式）。
 * 100% 对齐 NoteGen canvas-tools-sidebar 的交互与视觉：
 * - 浮动 Rail（absolute inset-y-3 left-3，rounded-xl border p-1 shadow-sm）
 * - 使用 Button 组件 + Tooltip
 * - 工具按钮顺序：select → hand → separator → pen → highlighter → eraser → separator → shapes → image
 * - 抽屉：浮动 rounded-xl border bg-background shadow-lg，宽度 w-[min(18rem,calc(100vw-5.5rem))]
 * - 形状项：Button variant="outline" h-10 justify-start gap-2 px-3 font-normal，支持点击和拖拽
 */

import { useMemo, useState } from "react";
import {
  ChevronLeft,
  MousePointer2,
  Hand,
  Shapes,
  ImagePlus,
  Pen,
  Highlighter,
  Eraser,
  RectangleHorizontal,
  Diamond,
  Square,
  Type,
  ArrowRightLeft,
  FileText,
  FileStack,
  PanelTop,
  Keyboard,
  Hexagon,
  Timer,
  Monitor,
  Circle,
  Pentagon,
  Box,
  Database,
  HardDrive,
  Blocks,
  MessageSquareText,
  type LucideIcon,
} from "lucide-react";

import type { FlowchartNodeKind } from "./flowchart-document";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type CanvasTool = "select" | "hand" | "pen" | "highlighter" | "eraser";

interface ShapeMeta {
  kind: FlowchartNodeKind;
  label: string;
  icon: LucideIcon;
  group: "common" | "flowchart" | "data";
}

/** 形状定义表：对齐 NoteGen CANVAS_SHAPE_DEFINITIONS，并补充流程图常用子流程/注释
 *  - common: process, decision, terminator, text
 *  - flowchart: input-output, document, multi-document, predefined-process, subprocess, annotation, manual-input, preparation, delay, display, connector, off-page-connector
 *  - data: internal-storage, database, stored-data
 */
export const SHAPES: ShapeMeta[] = [
  // common
  { kind: "process", label: "处理", icon: RectangleHorizontal, group: "common" },
  { kind: "decision", label: "判断", icon: Diamond, group: "common" },
  { kind: "terminator", label: "起止", icon: Square, group: "common" },
  { kind: "text", label: "文本", icon: Type, group: "common" },
  // flowchart
  { kind: "input-output", label: "输入/输出", icon: ArrowRightLeft, group: "flowchart" },
  { kind: "document", label: "文档", icon: FileText, group: "flowchart" },
  { kind: "multi-document", label: "多文档", icon: FileStack, group: "flowchart" },
  { kind: "predefined-process", label: "预定义流程", icon: PanelTop, group: "flowchart" },
  { kind: "subprocess", label: "子流程", icon: Blocks, group: "flowchart" },
  { kind: "annotation", label: "注释", icon: MessageSquareText, group: "flowchart" },
  { kind: "manual-input", label: "手动输入", icon: Keyboard, group: "flowchart" },
  { kind: "preparation", label: "准备", icon: Hexagon, group: "flowchart" },
  { kind: "delay", label: "延迟", icon: Timer, group: "flowchart" },
  { kind: "display", label: "显示", icon: Monitor, group: "flowchart" },
  { kind: "connector", label: "连接圆", icon: Circle, group: "flowchart" },
  { kind: "off-page-connector", label: "跨页连接", icon: Pentagon, group: "flowchart" },
  // data
  { kind: "internal-storage", label: "内部存储", icon: Box, group: "data" },
  { kind: "database", label: "数据库", icon: Database, group: "data" },
  { kind: "stored-data", label: "存储数据", icon: HardDrive, group: "data" },
];

const SHAPE_GROUPS: { key: ShapeMeta["group"]; title: string }[] = [
  { key: "common", title: "常用形状" },
  { key: "flowchart", title: "流程图" },
  { key: "data", title: "数据" },
];

export interface FlowchartShapePanelProps {
  onAddShape: (kind: FlowchartNodeKind) => void;
  onDropShape?: (kind: FlowchartNodeKind, x: number, y: number) => void;
  /** 点击 Rail 底部图片按钮 */
  onAddImage?: () => void;
  readOnly?: boolean;
  /** 当前激活工具 */
  activeTool?: CanvasTool;
  /** 工具切换回调 */
  onToolChange?: (tool: CanvasTool) => void;
  /** 面板打开状态变化回调（用于通知父组件关闭其他浮层） */
  onPanelOpenChange?: (open: boolean) => void;
}

export function FlowchartShapePanel({
  onAddShape,
  onDropShape,
  onAddImage,
  readOnly = false,
  activeTool = "select",
  onToolChange,
  onPanelOpenChange,
}: FlowchartShapePanelProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [draggingKind, setDraggingKind] = useState<FlowchartNodeKind | null>(null);

  const groupedShapes = useMemo(() => {
    return SHAPE_GROUPS.map((g) => ({
      ...g,
      shapes: SHAPES.filter((s) => s.group === g.key),
    })).filter((g) => g.shapes.length > 0);
  }, []);

  const selectTool = (next: CanvasTool) => {
    onToolChange?.(next);
    setPanelOpen(false);
    onPanelOpenChange?.(false);
  };

  const togglePanel = () => {
    const next = !panelOpen;
    setPanelOpen(next);
    onPanelOpenChange?.(next);
  };

  const insertShape = (kind: FlowchartNodeKind) => {
    onAddShape(kind);
    setPanelOpen(false);
    onPanelOpenChange?.(false);
  };

  return (
    <div className="absolute inset-y-3 left-3 z-30 flex max-w-[calc(100%-1.5rem)] items-start">
      <TooltipProvider delayDuration={300}>
        {/* Rail：100% 对齐 NoteGen 桌面端 w-12 flex-col gap-1 rounded-xl border p-1 shadow-sm */}
        <div
          role="toolbar"
          aria-label="流程图工具"
          className="flex w-10 shrink-0 flex-col items-center gap-1 rounded-xl border border-border/60 bg-background p-1 shadow-sm"
        >
          {/* 1. 选择 */}
          <RailButton
            label="选择"
            active={activeTool === "select"}
            icon={MousePointer2}
            disabled={readOnly}
            onClick={() => selectTool("select")}
          />
          {/* 2. 平移 */}
          <RailButton
            label="平移"
            active={activeTool === "hand"}
            icon={Hand}
            disabled={readOnly}
            onClick={() => selectTool("hand")}
          />
          <Separator className="my-0.5 w-full" />
          {/* 3. 钢笔 */}
          <RailButton
            label="钢笔"
            active={activeTool === "pen"}
            icon={Pen}
            disabled={readOnly}
            onClick={() => selectTool("pen")}
          />
          {/* 4. 荧光笔 */}
          <RailButton
            label="荧光笔"
            active={activeTool === "highlighter"}
            icon={Highlighter}
            disabled={readOnly}
            onClick={() => selectTool("highlighter")}
          />
          {/* 5. 橡皮 */}
          <RailButton
            label="橡皮"
            active={activeTool === "eraser"}
            icon={Eraser}
            disabled={readOnly}
            onClick={() => selectTool("eraser")}
          />
          <Separator className="my-0.5 w-full" />
          {/* 6. 形状库 */}
          <RailButton
            label="形状库"
            active={panelOpen}
            icon={Shapes}
            onClick={togglePanel}
          />
          {/* 7. 图片 */}
          <RailButton
            label="插入图片"
            icon={ImagePlus}
            disabled={readOnly || !onAddImage}
            onClick={() => {
              setPanelOpen(false);
              onPanelOpenChange?.(false);
              onAddImage?.();
            }}
          />
        </div>
      </TooltipProvider>

      {/* 抽屉面板：100% 对齐 NoteGen ml-2 w-[min(18rem,calc(100vw-5.5rem))] rounded-xl border shadow-lg */}
      {panelOpen && (
        <div className="ml-2 flex max-h-full w-[min(18rem,calc(100vw-5.5rem))] flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-lg">
          {/* Header h-12 */}
          <div className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
            <span className="text-sm font-medium text-foreground">形状库</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="关闭"
              className="h-7 w-7"
              onClick={() => {
                setPanelOpen(false);
                onPanelOpenChange?.(false);
              }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          <Separator />
          {/* 形状列表：flex flex-col gap-4 p-3 */}
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-3">
              {groupedShapes.map((g) => (
                <section key={g.key} className="flex flex-col gap-1.5">
                  <h3 className="px-1 text-xs font-medium text-muted-foreground">{g.title}</h3>
                  {/* grid grid-cols-2 gap-1.5 */}
                  <div className="grid grid-cols-2 gap-1.5">
                    {g.shapes.map((s) => {
                      const Icon = s.icon;
                      const isDragging = draggingKind === s.kind;
                      return (
                        <Button
                          key={s.kind}
                          type="button"
                          variant="outline"
                          disabled={readOnly}
                          draggable={!readOnly && !!onDropShape}
                          onDragStart={(e) => {
                            setDraggingKind(s.kind);
                            e.dataTransfer.setData("application/x-flowchart-kind", s.kind);
                            e.dataTransfer.effectAllowed = "copy";
                          }}
                          onDragEnd={() => setDraggingKind(null)}
                          onClick={() => insertShape(s.kind)}
                          title={`添加${s.label}（点击或拖拽到画布）`}
                          className={cn(
                            "h-10 min-w-0 justify-start gap-2 px-3 font-normal",
                            isDragging && "opacity-50",
                          )}
                        >
                          <Icon className="h-4 w-4 shrink-0 text-foreground/80" />
                          <span className="truncate text-[11px] leading-tight text-foreground/80">{s.label}</span>
                        </Button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

function RailButton({
  icon: Icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? "secondary" : "ghost"}
          size="icon"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className="h-8 w-8"
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
