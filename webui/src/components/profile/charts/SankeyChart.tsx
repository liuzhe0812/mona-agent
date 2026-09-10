/** 工作流桑基图：工具调用流向可视化（纯 SVG）。 */

import { PROFILE_COLORS } from "../profile-theme";

interface SankeyChartProps {
  /** [{chain: "tool_a→tool_b→tool_c", count: 12}] */
  chains: { chain: string; count: number }[];
  height?: number;
}

interface SankeyNode {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  total: number;
}

interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

const CHAIN_COLORS = [
  PROFILE_COLORS.emerald,
  PROFILE_COLORS.amber,
  PROFILE_COLORS.coral,
  PROFILE_COLORS.cyan,
  PROFILE_COLORS.emeraldSoft,
  PROFILE_COLORS.amberSoft,
];

export function SankeyChart({ chains, height = 200 }: SankeyChartProps) {
  if (!chains || chains.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-caption text-muted-foreground">
        暂无调用链数据
      </div>
    );
  }

  // Parse chains into nodes + links
  const nodeMap = new Map<string, { label: string; total: number; level: number }>();
  const links: SankeyLink[] = [];
  const maxLevel = Math.max(
    ...chains.flatMap((c) => {
      const tools = c.chain.split(/→|->/).map((t) => t.trim());
      return [tools.length];
    }),
    1
  );

  chains.forEach((c) => {
    const tools = c.chain.split(/→|->/).map((t) => t.trim()).filter(Boolean);
    tools.forEach((tool, i) => {
      const key = `${tool}@${i}`;
      const existing = nodeMap.get(key);
      if (existing) {
        existing.total += c.count;
      } else {
        nodeMap.set(key, { label: tool, total: c.count, level: i });
      }
    });
    for (let i = 0; i < tools.length - 1; i++) {
      const src = `${tools[i]}@${i}`;
      const tgt = `${tools[i + 1]}@${i + 1}`;
      const existing = links.find((l) => l.source === src && l.target === tgt);
      if (existing) existing.value += c.count;
      else links.push({ source: src, target: tgt, value: c.count });
    }
  });

  // Layout: columns by level
  const levels: string[][] = Array.from({ length: maxLevel }, () => []);
  nodeMap.forEach((node, key) => {
    levels[node.level].push(key);
  });

  const width = 640;
  const pad = { top: 20, right: 60, bottom: 20, left: 60 };
  const colW = (width - pad.left - pad.right) / Math.max(maxLevel - 1, 1);
  const nodes: SankeyNode[] = [];
  const colHeights: number[] = levels.map((col) => {
    return col.reduce((sum, key) => sum + (nodeMap.get(key)?.total ?? 0), 0);
  });
  const maxColHeight = Math.max(...colHeights, 1);

  levels.forEach((col, levelIdx) => {
    let y = pad.top;
    const availableH = height - pad.top - pad.bottom;
    col.forEach((key) => {
      const node = nodeMap.get(key)!;
      const h = (node.total / maxColHeight) * availableH * 0.85;
      nodes.push({
        id: key,
        label: node.label,
        x: pad.left + levelIdx * colW,
        y,
        width: 12,
        height: Math.max(h, 4),
        total: node.total,
      });
      y += h + 4;
    });
  });

  const nodeById = (id: string) => nodes.find((n) => n.id === id);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" preserveAspectRatio="xMidYMid meet">
      <defs>
        {CHAIN_COLORS.map((color, i) => (
          <linearGradient key={i} id={`sankey-grad-${i}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={color} stopOpacity="0.7" />
            <stop offset="100%" stopColor={color} stopOpacity="0.3" />
          </linearGradient>
        ))}
      </defs>

      {/* 连线 */}
      {links.map((link, i) => {
        const src = nodeById(link.source);
        const tgt = nodeById(link.target);
        if (!src || !tgt) return null;
        const midX = (src.x + src.width + tgt.x) / 2;
        const path = `M${src.x + src.width},${src.y + src.height / 2} C${midX},${src.y + src.height / 2} ${midX},${tgt.y + tgt.height / 2} ${tgt.x},${tgt.y + tgt.height / 2}`;
        const color = CHAIN_COLORS[i % CHAIN_COLORS.length];
        return (
          <path
            key={i}
            d={path}
            fill="none"
            stroke={color}
            strokeWidth={Math.max(1, Math.log(link.value + 1) * 2)}
            strokeOpacity={0.5}
          />
        );
      })}

      {/* 节点 */}
      {nodes.map((node) => {
        const color = CHAIN_COLORS[node.x % CHAIN_COLORS.length];
        return (
          <g key={node.id}>
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={2}
              fill={color}
              opacity={0.85}
            />
            <text
              x={node.x + node.width + 6}
              y={node.y + node.height / 2 + 3}
            className="fill-foreground text-micro"
            >
              {node.label}
            </text>
            <text
              x={node.x + node.width + 6}
              y={node.y + node.height / 2 + 15}
            className="fill-muted-foreground text-micro tabular-nums"
            >
              {node.total}次
            </text>
          </g>
        );
      })}
    </svg>
  );
}
