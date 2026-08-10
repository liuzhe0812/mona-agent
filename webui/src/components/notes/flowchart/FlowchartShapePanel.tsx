/**
 * 流程图画布左侧图形库（Rail + 可折叠面板）。
 *
 * 设计依据（FC-LIB-01）：
 * - Rail 宽 40px（w-10），常驻；
 * - 展开面板宽 280px（w-[17.5rem]），可折叠；
 * - 顶部搜索框，分类顺序固定为基础形状、流程图、泳池/泳道；
 * - 分类可折叠，每行 5 个真实形状图标（grid-cols-5）；
 * - hover tooltip 显示名称，点击在视口中心创建，拖拽在落点创建；
 * - 搜索无结果显示明确空状态；
 * - 真实几何预览：使用 renderFlowchartShape，与画布节点共用同一渲染函数。
 */

import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronDown,
  MousePointer2,
  Hand,
  Shapes,
  ImagePlus,
  Pen,
  Highlighter,
  Eraser,
  Search,
  Palette,
  type LucideIcon,
} from "lucide-react";

import type { FlowchartThemeSettings } from "./flowchart-document";
import {
  getFlowchartShapeId,
  groupShapesByCategory,
  renderFlowchartShapePreview,
  searchFlowchartShapes,
  type FlowchartShapeCategory,
  type FlowchartShapeDefinition,
} from "./flowchart-shapes";
import { FlowchartThemePanel } from "./FlowchartThemePanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type CanvasTool = "select" | "hand" | "pen" | "highlighter" | "eraser";

const CATEGORY_TITLES: Record<FlowchartShapeCategory, string> = {
  basic: "基础形状",
  flowchart: "流程图",
  swimlane: "泳池 / 泳道",
};

const CATEGORY_ORDER: FlowchartShapeCategory[] = ["basic", "flowchart", "swimlane"];

export interface FlowchartShapePanelProps {
  onAddShape: (shape: FlowchartShapeDefinition) => void;
  /** 点击 Rail 底部图片按钮 */
  onAddImage?: () => void;
  readOnly?: boolean;
  /** 当前激活工具 */
  activeTool?: CanvasTool;
  /** 工具切换回调 */
  onToolChange?: (tool: CanvasTool) => void;
  /** 面板打开状态变化回调（用于通知父组件关闭其他浮层） */
  onPanelOpenChange?: (open: boolean) => void;
  /** 当前文档主题（FC-THEME-02 样式面板）；不传则不显示样式入口 */
  theme?: FlowchartThemeSettings;
  /** 有手动颜色样式的节点数（用于清理确认提示） */
  manualStyleNodeCount?: number;
  /** 应用主题回调 */
  onApplyTheme?: (theme: FlowchartThemeSettings, options: { stripManualStyles: boolean }) => void;
}

export function FlowchartShapePanel({
  onAddShape,
  onAddImage,
  readOnly = false,
  activeTool = "select",
  onToolChange,
  onPanelOpenChange,
  theme,
  manualStyleNodeCount = 0,
  onApplyTheme,
}: FlowchartShapePanelProps) {
  // 展开的面板：shapes 形状库 / theme 样式；null 表示全部收起
  const [openPanel, setOpenPanel] = useState<"shapes" | "theme" | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedCategories, setCollapsedCategories] = useState<Set<FlowchartShapeCategory>>(new Set());

  // 搜索过滤
  const filteredShapes = useMemo(() => searchFlowchartShapes(searchQuery), [searchQuery]);

  // 按分类分组
  const groupedShapes = useMemo(() => {
    const groups = groupShapesByCategory(filteredShapes);
    return CATEGORY_ORDER.map((category) => ({
      category,
      title: CATEGORY_TITLES[category],
      shapes: groups[category],
    })).filter((g) => g.shapes.length > 0);
  }, [filteredShapes]);

  const closePanels = () => {
    setOpenPanel(null);
    onPanelOpenChange?.(false);
  };

  const selectTool = (next: CanvasTool) => {
    onToolChange?.(next);
    closePanels();
  };

  const togglePanel = (panel: "shapes" | "theme") => {
    const next = openPanel === panel ? null : panel;
    setOpenPanel(next);
    onPanelOpenChange?.(next !== null);
  };

  const toggleCategory = (category: FlowchartShapeCategory) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const insertShape = (shape: FlowchartShapeDefinition) => {
    onAddShape(shape);
    closePanels();
  };

  // Esc 关闭展开的面板（FC-LIB-03）
  useEffect(() => {
    if (openPanel === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePanels();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPanel, onPanelOpenChange]);

  return (
    <div className="absolute inset-y-3 left-3 z-30 flex max-w-[calc(100%-1.5rem)] items-start">
      <TooltipProvider delayDuration={300}>
        {/* Rail：w-10 (40px) */}
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
            active={openPanel === "shapes"}
            icon={Shapes}
            onClick={() => togglePanel("shapes")}
          />
          {/* 7. 样式（主题与配色，FC-THEME-02） */}
          {theme && onApplyTheme && (
            <RailButton
              label="样式"
              active={openPanel === "theme"}
              icon={Palette}
              disabled={readOnly}
              onClick={() => togglePanel("theme")}
            />
          )}
          {/* 8. 图片 */}
          <RailButton
            label="插入图片"
            icon={ImagePlus}
            disabled={readOnly || !onAddImage}
            onClick={() => {
              closePanels();
              onAddImage?.();
            }}
          />
        </div>
      </TooltipProvider>

      {/* 展开面板：w-[17.5rem] (280px) */}
      {openPanel === "shapes" && (
        <div className="ml-2 flex max-h-full w-[17.5rem] flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-lg">
          {/* Header：搜索框 */}
          <div className="flex h-12 shrink-0 items-center gap-2 px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              type="search"
              placeholder="搜索形状..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 flex-1 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
              aria-label="搜索形状"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="关闭"
              className="h-7 w-7 shrink-0"
              onClick={closePanels}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          <Separator />
          {/* 形状列表 */}
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 p-3">
              {groupedShapes.length === 0 ? (
                <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                  未找到匹配的形状
                </div>
              ) : (
                groupedShapes.map((group) => {
                  const isCollapsed = collapsedCategories.has(group.category);
                  return (
                    <section key={group.category} className="flex flex-col gap-1.5">
                      {/* 分类标题：可折叠 */}
                      <button
                        type="button"
                        onClick={() => toggleCategory(group.category)}
                        className="flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                        aria-expanded={!isCollapsed}
                        aria-label={`${isCollapsed ? "展开" : "折叠"}${group.title}`}
                      >
                        <ChevronDown
                          className={cn(
                            "h-3 w-3 transition-transform",
                            isCollapsed && "-rotate-90",
                          )}
                        />
                        <span>{group.title}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground/60">
                          {group.shapes.length}
                        </span>
                      </button>
                      {/* 形状网格：每行 5 个 */}
                      {!isCollapsed && (
                        <div className="grid grid-cols-5 gap-1.5">
                          {group.shapes.map((shape) => {
                            const shapeId = getFlowchartShapeId(shape);
                            return (
                              <ShapeGridItem
                                key={shapeId}
                                shape={shape}
                                readOnly={readOnly}
                                isDragging={draggingId === shapeId}
                                onDragStart={(e) => {
                                  setDraggingId(shapeId);
                                  e.dataTransfer.setData("application/x-flowchart-kind", shapeId);
                                  e.dataTransfer.effectAllowed = "copy";
                                }}
                                onDragEnd={() => setDraggingId(null)}
                                onClick={() => insertShape(shape)}
                              />
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </div>
      )}

      {/* 样式面板（FC-THEME-02）：主题风格与配色 */}
      {openPanel === "theme" && theme && onApplyTheme && (
        <div className="ml-2 flex max-h-full w-[17.5rem] flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-lg">
          {/* Header：标题 */}
          <div className="flex h-12 shrink-0 items-center gap-2 px-3">
            <Palette className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 text-sm font-medium">样式</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="关闭"
              className="h-7 w-7 shrink-0"
              onClick={closePanels}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          <Separator />
          <ScrollArea className="min-h-0 flex-1">
            <FlowchartThemePanel
              theme={theme}
              manualStyleNodeCount={manualStyleNodeCount}
              readOnly={readOnly}
              onApplyTheme={onApplyTheme}
            />
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

/** 形状网格项：真实几何预览（pool/lane 按方向渲染标题区，分隔渲染为方向线） */
function ShapeGridItem({
  shape,
  readOnly,
  isDragging,
  onDragStart,
  onDragEnd,
  onClick,
}: {
  shape: FlowchartShapeDefinition;
  readOnly: boolean;
  isDragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onClick: () => void;
}) {
  const shapeNode = renderFlowchartShapePreview(shape);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* span 包裹：disabled button 无 pointer events，tooltip 需要挂在外层 */}
        <span className="w-full">
          <button
            type="button"
            disabled={readOnly}
            draggable={!readOnly}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onClick={onClick}
            aria-label={`添加${shape.label}`}
            className={cn(
              "flex h-12 w-full items-center justify-center rounded-md border border-border/60 bg-background transition-colors",
              "hover:border-border hover:bg-accent",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:pointer-events-none disabled:opacity-50",
              isDragging && "opacity-50",
            )}
          >
            <svg
              viewBox="0 0 200 100"
              preserveAspectRatio="none"
              className="h-8 w-8"
              aria-hidden="true"
            >
              {shapeNode}
            </svg>
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{shape.label}</TooltipContent>
    </Tooltip>
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
