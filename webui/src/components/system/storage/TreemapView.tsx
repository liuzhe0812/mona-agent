import { useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, treemap } from "d3-hierarchy";
import { ChevronRight, Home } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { PanelCard } from "../SystemUi";
import type { DirectorySize } from "../useSystemData";
import { formatStorage } from "../useSystemData";

const TREEMAP_HEIGHT = 320;
const DEFAULT_WIDTH = 800;
/** 与后端 MIN_SIZE_TO_KEEP_CHILDREN_GB 对齐：低于该值的未展开空间不单独成块 */
const OTHER_TILE_MIN_GB = 0.05;

// 协调色板（对齐 ui-spec 的翡翠绿/琥珀金/珊瑚橙/青蓝体系）
const TREEMAP_COLORS = [
  "#10b981", // emerald-500
  "#8b5cf6", // violet-500
  "#3b82f6", // blue-500
  "#f59e0b", // amber-500
  "#06b6d4", // cyan-500
  "#ec4899", // pink-500
  "#84cc16", // lime-500
  "#f97316", // orange-500
  "#6366f1", // indigo-500
  "#14b8a6", // teal-500
];
const OTHER_TILE_COLOR = "#9ca3af"; // gray-400，未展开空间的中性表达

/** 字符宽度估算：中文/全角按 1.0em，拉丁/数字按 0.55em（替换 name.length * 7 的粗暴口径） */
export function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    width += (ch.codePointAt(0) ?? 0) > 0xff ? fontSize : fontSize * 0.55;
  }
  return width;
}

export function truncateToWidth(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  let acc = "";
  for (const ch of text) {
    if (estimateTextWidth(`${acc}${ch}…`, fontSize) > maxWidth) break;
    acc += ch;
  }
  return acc ? `${acc}…` : "…";
}

/** 简化相对亮度（sRGB 加权）：> 0.5 视为浅底色 */
function fillLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 文字色二选一：浅底色叠深灰字，深底色叠白字；半透明块（<0.6）在浅底上偏亮，不叠白字 */
function tileTextColor(hex: string, fillOpacity: number): string {
  if (fillOpacity < 0.6) return "#1f2937";
  return fillLuminance(hex) > 0.5 ? "#1f2937" : "#ffffff";
}

interface Props {
  /** 当前层级的目录列表（已按大小降序） */
  directories: DirectorySize[];
  /** 当前层级父目录的总大小（根层级为 totalScannedGb），用于补出「其他（未展开）」块使总和自洽 */
  currentTotalGb?: number;
  /** 下钻路径历史，用于面包屑 */
  breadcrumb: Array<{ path: string; name: string }>;
  /** 加载状态 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 点击某个块下钻 */
  onDrillDown: (path: string) => void;
  /** 当前选择，用于与目录树和 AI 上下文同步 */
  selectedPath?: string | null;
  onSelect?: (path: string) => void;
  /** 点击地址栏项回退 */
  onNavigate: (path: string | null) => void;
}

interface TreemapNode {
  name: string;
  path: string;
  sizeGb: number;
  fileCount: number;
  /** 「其他（未展开）」占位块：不可点击、灰色 */
  isOther?: boolean;
  children?: TreemapNode[];
}

export function TreemapView({
  directories,
  currentTotalGb,
  breadcrumb,
  loading,
  error,
  onDrillDown,
  selectedPath = null,
  onSelect,
  onNavigate,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  // 响应式：容器实际宽度驱动 treemap 布局，替换固定 viewBox 拉伸
  useEffect(() => {
    const target = containerRef.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const measured = Math.floor(target.clientWidth);
      if (measured > 0) setWidth(measured);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const tiles = useMemo(() => {
    const valid = directories.filter((d) => d.sizeGb > 0);
    const shownSum = valid.reduce((acc, d) => acc + d.sizeGb, 0);
    // 未扫描/未展开空间（当前目录总大小 − 已展开 children 之和），让总和与目录大小自洽
    const otherGb = currentTotalGb !== undefined ? Math.max(currentTotalGb - shownSum, 0) : 0;
    if (valid.length === 0 && otherGb < OTHER_TILE_MIN_GB) return [];

    const childNodes: TreemapNode[] = valid.map((d) => ({
      name: d.path.split("\\").filter(Boolean).pop() ?? d.path,
      path: d.path,
      sizeGb: d.sizeGb,
      fileCount: d.fileCount,
    }));
    if (otherGb >= OTHER_TILE_MIN_GB) {
      childNodes.push({
        name: "其他（未展开）",
        path: "(other)",
        sizeGb: otherGb,
        fileCount: 0,
        isOther: true,
      });
    }

    const rootNode: TreemapNode = {
      name: "root",
      path: "",
      sizeGb: 0,
      fileCount: 0,
      children: childNodes,
    };
    const root = hierarchy<TreemapNode>(rootNode)
      .sum((d) => d.sizeGb)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const layout = treemap<TreemapNode>()
      .size([width, TREEMAP_HEIGHT])
      .padding(2)
      .round(true);
    const laidOut = layout(root);

    let colorIndex = 0;
    return laidOut.leaves().map((node) => {
      const source = node.data.isOther
        ? undefined
        : valid.find((d) => d.path === node.data.path);
      const isOther = !!node.data.isOther;
      const color = isOther
        ? OTHER_TILE_COLOR
        : TREEMAP_COLORS[colorIndex++ % TREEMAP_COLORS.length];
      return {
        data: {
          name: node.data.name,
          path: node.data.path,
          sizeGb: node.data.sizeGb,
          fileCount: node.data.fileCount,
          isOther,
        },
        color,
        hasChildren: !!(source?.children && source.children.length > 0),
        x0: node.x0,
        y0: node.y0,
        x1: node.x1,
        y1: node.y1,
      };
    });
  }, [directories, currentTotalGb, width]);

  const title = "空间分布";

  // 面包屑导航（放在标题右侧，点击回退）
  const breadcrumbEl = (
    <div className="flex items-center gap-0.5 overflow-x-auto text-micro scrollbar-none select-none">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onNavigate(null)}
        className="h-auto px-1 py-0.5 text-micro font-normal text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Home className="h-3 w-3" />
        <span>此电脑</span>
      </Button>
      {breadcrumb.map((item, index) => {
        const isLast = index === breadcrumb.length - 1;
        return (
          <div key={item.path} className="flex shrink-0 items-center">
            <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => !isLast && onNavigate(item.path)}
              className={cn(
                "h-auto max-w-[160px] truncate px-1 py-0.5 text-micro font-normal",
                isLast
                  ? "pointer-events-none font-medium text-foreground hover:bg-transparent"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              title={item.path}
            >
              {item.name}
            </Button>
          </div>
        );
      })}
    </div>
  );

  return (
    <PanelCard title={title} className="h-full" action={breadcrumbEl}>
      {loading ? (
        <div className="flex h-[320px] items-center justify-center text-caption text-muted-foreground">
          正在扫描子目录...
        </div>
      ) : error ? (
        <div className="flex h-[320px] items-center justify-center text-caption text-warning">
          {error}
        </div>
      ) : tiles.length === 0 ? (
        <div className="flex h-[320px] items-center justify-center text-caption text-muted-foreground">
          暂无数据
        </div>
      ) : (
        <div ref={containerRef} className="h-[320px] w-full">
          <svg width={width} height={TREEMAP_HEIGHT} className="block rounded-lg">
            {tiles.map((tile) => {
              const w = tile.x1 - tile.x0;
              const h = tile.y1 - tile.y0;
              const fillOpacity = tile.data.isOther ? 0.3 : tile.hasChildren ? 0.85 : 0.5;
              const textColor = tileTextColor(tile.color, fillOpacity);
              const clickable = !tile.data.isOther && tile.hasChildren;
              const selectable = !tile.data.isOther;
              const selected = selectedPath === tile.data.path;
              const showLabel = w > 60 && h > 28;
              const showSize = w > 60 && h > 44;
              const activate = () => {
                if (!selectable) return;
                onSelect?.(tile.data.path);
                if (clickable) onDrillDown(tile.data.path);
              };
              return (
                <g
                  key={tile.data.path}
                  role={selectable ? "button" : undefined}
                  tabIndex={selectable ? 0 : undefined}
                  aria-label={selectable ? `${tile.data.name}，${formatStorage(tile.data.sizeGb)}` : undefined}
                  className={selectable ? "cursor-pointer" : "cursor-default"}
                  onClick={activate}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && selectable) {
                      event.preventDefault();
                      activate();
                    }
                  }}
                >
                  <title>{tile.data.path}</title>
                  <rect
                    x={tile.x0}
                    y={tile.y0}
                    width={w}
                    height={h}
                    fill={tile.color}
                    fillOpacity={fillOpacity}
                    stroke={selected ? "hsl(var(--foreground))" : "hsl(var(--background))"}
                    strokeWidth={selected ? 2 : 1}
                    className={clickable ? "transition-all hover:fill-opacity-100 hover:stroke-2" : undefined}
                  />
                  {showLabel && (
                    <text
                      x={tile.x0 + 6}
                      y={tile.y0 + 16}
                      fill={textColor}
                      fontSize={12}
                      fontWeight={600}
                      className="pointer-events-none select-none"
                    >
                      {truncateToWidth(tile.data.name, w - 12, 12)}
                    </text>
                  )}
                  {showSize && (
                    <text
                      x={tile.x0 + 6}
                      y={tile.y0 + 32}
                      fill={textColor}
                      fillOpacity={0.9}
                      fontSize={11}
                      className="pointer-events-none select-none"
                    >
                      {formatStorage(tile.data.sizeGb)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </PanelCard>
  );
}
