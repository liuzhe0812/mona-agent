/**
 * 图表左侧工具栏（浮动 Rail + 抽屉模式）。
 * 复用 FlowchartShapePanel 的交互模式：Rail 工具 + 形状库抽屉。
 * 形状定义基于 diagram-document.ts 的 ShapeKind 枚举。
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
  Square,
  Diamond,
  Circle,
  Hexagon,
  Pill,
  Cylinder,
  FileText,
  FileStack,
  Cloud,
  User,
  MessageSquareText,
  ChevronRight,
  Pentagon,
  type LucideIcon,
} from "lucide-react";

import type { ShapeKind } from "./diagram-document";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type CanvasTool = "select" | "hand" | "pen" | "highlighter" | "eraser";

interface ShapeMeta {
  kind: ShapeKind;
  label: string;
  icon: LucideIcon;
  group: "basic" | "flowchart" | "decorative";
}

const SHAPES: ShapeMeta[] = [
  // basic
  { kind: "rectangle", label: "矩形", icon: RectangleHorizontal, group: "basic" },
  { kind: "rounded-rectangle", label: "圆角矩形", icon: Square, group: "basic" },
  { kind: "ellipse", label: "椭圆", icon: Circle, group: "basic" },
  { kind: "pill", label: "胶囊", icon: Pill, group: "basic" },
  { kind: "diamond", label: "菱形", icon: Diamond, group: "basic" },
  { kind: "hexagon", label: "六边形", icon: Hexagon, group: "basic" },
  { kind: "parallelogram", label: "平行四边形", icon: Square, group: "basic" },
  // flowchart
  { kind: "process", label: "处理", icon: RectangleHorizontal, group: "flowchart" },
  { kind: "subprocess", label: "子流程", icon: Square, group: "flowchart" },
  { kind: "diamond", label: "判断", icon: Diamond, group: "flowchart" },
  { kind: "document", label: "文档", icon: FileText, group: "flowchart" },
  { kind: "multi-document", label: "多文档", icon: FileStack, group: "flowchart" },
  { kind: "cylinder", label: "圆柱", icon: Cylinder, group: "flowchart" },
  { kind: "database", label: "数据库", icon: Cylinder, group: "flowchart" },
  { kind: "callout", label: "标注", icon: MessageSquareText, group: "flowchart" },
  { kind: "chevron", label: "箭头", icon: ChevronRight, group: "flowchart" },
  { kind: "pentagon", label: "五边形", icon: Pentagon, group: "flowchart" },
  // decorative
  { kind: "cloud", label: "云", icon: Cloud, group: "decorative" },
  { kind: "actor", label: "角色", icon: User, group: "decorative" },
  { kind: "circle", label: "圆形", icon: Circle, group: "decorative" },
];

const SHAPE_GROUPS: { key: ShapeMeta["group"]; title: string }[] = [
  { key: "basic", title: "基本形状" },
  { key: "flowchart", title: "流程图" },
  { key: "decorative", title: "装饰" },
];

export interface DiagramShapePanelProps {
  onAddShape: (kind: ShapeKind) => void;
  onDropShape?: (kind: ShapeKind, x: number, y: number) => void;
  onAddImage?: () => void;
  readOnly?: boolean;
  activeTool?: CanvasTool;
  onToolChange?: (tool: CanvasTool) => void;
  onPanelOpenChange?: (open: boolean) => void;
}

export function DiagramShapePanel({
  onAddShape,
  onDropShape,
  onAddImage,
  readOnly = false,
  activeTool = "select",
  onToolChange,
  onPanelOpenChange,
}: DiagramShapePanelProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [draggingKind, setDraggingKind] = useState<ShapeKind | null>(null);

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

  const insertShape = (kind: ShapeKind) => {
    onAddShape(kind);
    setPanelOpen(false);
    onPanelOpenChange?.(false);
  };

  return (
    <div className="absolute inset-y-3 left-3 z-30 flex max-w-[calc(100%-1.5rem)] items-start">
      <TooltipProvider delayDuration={300}>
        <div
          role="toolbar"
          aria-label="图表工具"
          className="flex w-10 shrink-0 flex-col items-center gap-1 rounded-xl border border-border/60 bg-background p-1 shadow-sm"
        >
          <RailButton label="选择" active={activeTool === "select"} icon={MousePointer2} disabled={readOnly} onClick={() => selectTool("select")} />
          <RailButton label="平移" active={activeTool === "hand"} icon={Hand} disabled={readOnly} onClick={() => selectTool("hand")} />
          <Separator className="my-0.5 w-full" />
          <RailButton label="钢笔" active={activeTool === "pen"} icon={Pen} disabled={readOnly} onClick={() => selectTool("pen")} />
          <RailButton label="荧光笔" active={activeTool === "highlighter"} icon={Highlighter} disabled={readOnly} onClick={() => selectTool("highlighter")} />
          <RailButton label="橡皮" active={activeTool === "eraser"} icon={Eraser} disabled={readOnly} onClick={() => selectTool("eraser")} />
          <Separator className="my-0.5 w-full" />
          <RailButton label="形状库" active={panelOpen} icon={Shapes} onClick={togglePanel} />
          <RailButton
            label="插入图片"
            icon={ImagePlus}
            disabled={readOnly || !onAddImage}
            onClick={() => { setPanelOpen(false); onPanelOpenChange?.(false); onAddImage?.(); }}
          />
        </div>
      </TooltipProvider>

      {panelOpen && (
        <div className="ml-2 flex max-h-full w-[min(18rem,calc(100vw-5.5rem))] flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-lg">
          <div className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
            <span className="text-sm font-medium text-foreground">形状库</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="关闭"
              className="h-7 w-7"
              onClick={() => { setPanelOpen(false); onPanelOpenChange?.(false); }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          <Separator />
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-3">
              {groupedShapes.map((g) => (
                <section key={g.key} className="flex flex-col gap-1.5">
                  <h3 className="px-1 text-xs font-medium text-muted-foreground">{g.title}</h3>
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
                            e.dataTransfer.setData("application/x-diagram-shape", s.kind);
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
