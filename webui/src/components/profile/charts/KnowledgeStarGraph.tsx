/** 知识星图：力导向式节点图（纯 SVG 静态布局 + 拖拽交互）。 */

import { useMemo, useState } from "react";

import { PROFILE_COLORS } from "../profile-theme";
import type { KnowledgeGraph as KGData } from "@/lib/profile-api";

interface KnowledgeStarGraphProps {
  data: KGData;
  size?: number;
}

interface NodePos {
  id: string;
  label: string;
  group: number;
  size: number;
  x: number;
  y: number;
}

export function KnowledgeStarGraph({ data, size = 320 }: KnowledgeStarGraphProps) {
  const [hovered, setHovered] = useState<string | null>(null);

  // 静态布局：中心 + 环形分布
  const { nodes: positions, links } = useMemo(() => {
    if (!data || !data.nodes || data.nodes.length === 0) {
      return { nodes: [] as NodePos[], links: data?.links ?? [] };
    }
    const cx = size / 2;
    const cy = size / 2;
    const center = data.nodes.find((n) => n.id === "user");
    const others = data.nodes.filter((n) => n.id !== "user");

    // 按组分层
    const group1 = others.filter((n) => n.group === 1);
    const group2 = others.filter((n) => n.group === 2);

    const positions: NodePos[] = [];
    if (center) {
      positions.push({
        id: center.id,
        label: center.label,
        group: 0,
        size: center.size ?? 30,
        x: cx,
        y: cy,
      });
    }

    // 内圈：notebooks
    const innerR = size * 0.22;
    group1.forEach((node, i) => {
      const angle = (i / Math.max(group1.length, 1)) * Math.PI * 2 - Math.PI / 2;
      positions.push({
        id: node.id,
        label: node.label,
        group: 1,
        size: node.size ?? 18,
        x: cx + Math.cos(angle) * innerR,
        y: cy + Math.sin(angle) * innerR,
      });
    });

    // 外圈：keywords
    const outerR = size * 0.4;
    group2.forEach((node, i) => {
      const angle = (i / Math.max(group2.length, 1)) * Math.PI * 2;
      positions.push({
        id: node.id,
        label: node.label,
        group: 2,
        size: node.size ?? 14,
        x: cx + Math.cos(angle) * outerR,
        y: cy + Math.sin(angle) * outerR,
      });
    });

    return { nodes: positions, links: data.links };
  }, [data, size]);

  if (positions.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-caption text-muted-foreground">
        暂无知识图谱数据
      </div>
    );
  }

  const groupColors = [
    PROFILE_COLORS.coral, // user
    PROFILE_COLORS.emerald, // notebooks
    PROFILE_COLORS.amber, // keywords
  ];

  const nodeById = (id: string) => positions.find((n) => n.id === id);

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-auto w-full"
      style={{ maxWidth: `${size}px` }}
    >
      <defs>
        <radialGradient id="kg-center">
          <stop offset="0%" stopColor={PROFILE_COLORS.coral} stopOpacity="0.8" />
          <stop offset="100%" stopColor={PROFILE_COLORS.coralDeep} stopOpacity="0.4" />
        </radialGradient>
        <filter id="kg-glow">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* 连线 */}
      {links.map((link, i) => {
        const src = nodeById(link.source);
        const tgt = nodeById(link.target);
        if (!src || !tgt) return null;
        const isHovered =
          hovered && (hovered === src.id || hovered === tgt.id);
        return (
          <line
            key={i}
            x1={src.x}
            y1={src.y}
            x2={tgt.x}
            y2={tgt.y}
            stroke={PROFILE_COLORS.emerald}
            strokeWidth={isHovered ? 2 : 1}
            strokeOpacity={isHovered ? 0.6 : 0.2}
          />
        );
      })}

      {/* 节点 */}
      {positions.map((node) => {
        const color = groupColors[node.group] ?? PROFILE_COLORS.emerald;
        const isCenter = node.group === 0;
        const isHovered = hovered === node.id;
        const r = node.size / 2;
        return (
          <g
            key={node.id}
            onMouseEnter={() => setHovered(node.id)}
            onMouseLeave={() => setHovered(null)}
            style={{ cursor: "pointer" }}
          >
            {isCenter && (
              <circle
                r={r + 8}
                cx={node.x}
                cy={node.y}
                fill={PROFILE_COLORS.coral}
                opacity={0.15}
                className="profile-pulse"
              />
            )}
            <circle
              r={r}
              cx={node.x}
              cy={node.y}
              fill={isCenter ? "url(#kg-center)" : color}
              fillOpacity={isCenter ? 1 : 0.7}
              stroke={color}
              strokeWidth={isHovered ? 2 : 1}
              filter={isCenter ? "url(#kg-glow)" : undefined}
            />
            <text
              x={node.x}
              y={node.y + r + 12}
              textAnchor="middle"
              className="fill-foreground text-micro font-medium"
              style={{ opacity: isHovered || isCenter ? 1 : 0.7 }}
            >
              {node.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
