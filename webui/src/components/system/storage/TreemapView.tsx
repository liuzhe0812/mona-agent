import { useMemo } from "react";
import { hierarchy, treemap } from "d3-hierarchy";
import { ChevronRight, Home } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { PanelCard } from "../SystemUi";
import type { DirectorySize } from "../useSystemData";
import { formatStorage } from "../useSystemData";

const TREEMAP_WIDTH = 800;
const TREEMAP_HEIGHT = 320;

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

interface Props {
  /** 当前层级的目录列表（已按大小降序） */
  directories: DirectorySize[];
  /** 下钻路径历史，用于面包屑 */
  breadcrumb: Array<{ path: string; name: string }>;
  /** 加载状态 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 点击某个块下钻 */
  onDrillDown: (path: string) => void;
  /** 点击地址栏项回退 */
  onNavigate: (path: string | null) => void;
}

interface TreemapNode {
  name: string;
  path: string;
  sizeGb: number;
  fileCount: number;
  children?: TreemapNode[];
}

export function TreemapView({
  directories,
  breadcrumb,
  loading,
  error,
  onDrillDown,
  onNavigate,
}: Props) {
  const tiles = useMemo(() => {
    const valid = directories.filter((d) => d.sizeGb > 0);
    if (valid.length === 0) return [];
    const rootNode: TreemapNode = {
      name: "root",
      path: "",
      sizeGb: 0,
      fileCount: 0,
      children: valid.map((d) => ({
        name: d.path.split("\\").filter(Boolean).pop() ?? d.path,
        path: d.path,
        sizeGb: d.sizeGb,
        fileCount: d.fileCount,
      })),
    };
    const root = hierarchy<TreemapNode>(rootNode)
      .sum((d) => d.sizeGb)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const layout = treemap<TreemapNode>()
      .size([TREEMAP_WIDTH, TREEMAP_HEIGHT])
      .padding(2)
      .round(true);
    const laidOut = layout(root);
    return laidOut.leaves().map((node) => {
      const source = valid.find((d) => d.path === node.data.path);
      return {
        data: {
          path: node.data.path,
          sizeGb: node.data.sizeGb,
          fileCount: node.data.fileCount,
        },
        hasChildren: !!(source?.children && source.children.length > 0),
        x0: node.x0,
        y0: node.y0,
        x1: node.x1,
        y1: node.y1,
      };
    });
  }, [directories]);

  const title = "空间分布";

  // 面包屑导航（放在标题右侧，点击回退）
  const breadcrumbEl = (
    <div className="flex items-center gap-0.5 overflow-x-auto text-[11px] scrollbar-none select-none">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onNavigate(null)}
        className="h-auto px-1 py-0.5 text-[11px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground"
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
                "h-auto max-w-[160px] truncate px-1 py-0.5 text-[11px] font-normal",
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
        <div className="flex h-[320px] items-center justify-center text-xs text-muted-foreground">
          正在扫描子目录...
        </div>
      ) : error ? (
        <div className="flex h-[320px] items-center justify-center text-xs text-orange-600">
          {error}
        </div>
      ) : tiles.length === 0 ? (
        <div className="flex h-[320px] items-center justify-center text-xs text-muted-foreground">
          暂无数据
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${TREEMAP_WIDTH} ${TREEMAP_HEIGHT}`}
          className="h-[320px] w-full rounded-lg"
          preserveAspectRatio="xMidYMid meet"
        >
          {tiles.map((tile, index) => {
            const w = tile.x1 - tile.x0;
            const h = tile.y1 - tile.y0;
            const color = TREEMAP_COLORS[index % TREEMAP_COLORS.length];
            const name = tile.data.path.split("\\").filter(Boolean).pop() ?? tile.data.path;
            const showLabel = w > 60 && h > 28;
            const showSize = w > 60 && h > 44;
            return (
              <g
                key={tile.data.path}
                className={tile.hasChildren ? "cursor-pointer" : "cursor-default"}
                onClick={() => tile.hasChildren && onDrillDown(tile.data.path)}
              >
                <rect
                  x={tile.x0}
                  y={tile.y0}
                  width={w}
                  height={h}
                  fill={color}
                  fillOpacity={tile.hasChildren ? 0.85 : 0.5}
                  stroke="white"
                  strokeWidth={1}
                  className={tile.hasChildren ? "transition-all hover:fill-opacity-100 hover:stroke-2" : undefined}
                />
                {showLabel && (
                  <text
                    x={tile.x0 + 6}
                    y={tile.y0 + 16}
                    fill="white"
                    fontSize={12}
                    fontWeight={600}
                    className="pointer-events-none select-none"
                  >
                    {name.length * 7 > w - 12 ? `${name.slice(0, Math.floor((w - 12) / 7))}…` : name}
                  </text>
                )}
                {showSize && (
                  <text
                    x={tile.x0 + 6}
                    y={tile.y0 + 32}
                    fill="white"
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
      )}
    </PanelCard>
  );
}
