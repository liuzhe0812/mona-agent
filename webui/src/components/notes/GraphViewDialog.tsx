import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getNotesLinkGraph, type LinkGraph, type LinkNode } from "@/lib/tauri";

interface GraphViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeNoteId?: string | null;
  onSelectNote?: (noteId: string) => void;
}

interface SimNode extends LinkNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
}

interface SimEdge {
  source: string;
  target: string;
  kind: "link" | "embed";
}

const NODE_RADIUS = 6;
const REPULSION = 1200;
const SPRING_LENGTH = 80;
const SPRING_K = 0.04;
const CENTERING_K = 0.005;
const DAMPING = 0.82;
const MAX_VELOCITY = 12;

export function GraphViewDialog({
  open,
  onOpenChange,
  activeNoteId,
  onSelectNote,
}: GraphViewDialogProps) {
  const [graph, setGraph] = useState<LinkGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const offsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const scaleRef = useRef<number>(1);
  const dragRef = useRef<{ nodeId: string | null; lastX: number; lastY: number; panning: boolean }>({
    nodeId: null,
    lastX: 0,
    lastY: 0,
    panning: false,
  });
  const animationRef = useRef<number>(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ w: 800, h: 600 });

  // Load graph data once per open.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    getNotesLinkGraph()
      .then((data) => {
        if (!data) {
          setGraph(null);
          return;
        }
        setGraph(data);
        const degreeMap = new Map<string, number>();
        const edges: SimEdge[] = [];
        for (const e of data.edges) {
          if (!e.resolvedTarget) continue;
          const src = e.source;
          const tgt = e.resolvedTarget;
          edges.push({ source: src, target: tgt, kind: e.kind });
          degreeMap.set(src, (degreeMap.get(src) ?? 0) + 1);
          degreeMap.set(tgt, (degreeMap.get(tgt) ?? 0) + 1);
        }
        edgesRef.current = edges;
        const rect = containerRef.current?.getBoundingClientRect();
        const cx = (rect?.width ?? dimensions.w) / 2;
        const cy = (rect?.height ?? dimensions.h) / 2;
        nodesRef.current = data.nodes.map((n, i) => {
          const angle = (i / Math.max(data.nodes.length, 1)) * Math.PI * 2;
          const r = 120;
          return {
            ...n,
            x: cx + Math.cos(angle) * r + (Math.random() - 0.5) * 20,
            y: cy + Math.sin(angle) * r + (Math.random() - 0.5) * 20,
            vx: 0,
            vy: 0,
            degree: degreeMap.get(n.id) ?? 0,
          };
        });
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [open]);

  // Track container size.
  useEffect(() => {
    if (!open || !containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setDimensions({ w: cr.width, h: cr.height });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [open]);

  // Force simulation loop.
  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const tick = () => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const { x: ox, y: oy } = offsetRef.current;
      const scale = scaleRef.current;
      const cx = dimensions.w / 2;
      const cy = dimensions.h / 2;

      // Apply repulsion between all nodes.
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distSq = Math.max(dx * dx + dy * dy, 1);
          const force = REPULSION / distSq;
          const dist = Math.sqrt(distSq);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      // Apply spring forces along edges.
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));
      for (const e of edges) {
        const a = nodeMap.get(e.source);
        const b = nodeMap.get(e.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = SPRING_K * (dist - SPRING_LENGTH);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      // Apply centering and integrate.
      for (const n of nodes) {
        n.vx += (cx - n.x) * CENTERING_K;
        n.vy += (cy - n.y) * CENTERING_K;
        n.vx *= DAMPING;
        n.vy *= DAMPING;
        // Cap velocity.
        const v = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (v > MAX_VELOCITY) {
          n.vx = (n.vx / v) * MAX_VELOCITY;
          n.vy = (n.vy / v) * MAX_VELOCITY;
        }
        n.x += n.vx;
        n.y += n.vy;
      }

      // Render.
      ctx.clearRect(0, 0, dimensions.w, dimensions.h);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);

      // Draw edges.
      ctx.strokeStyle = "rgba(120, 120, 140, 0.25)";
      ctx.lineWidth = 1 / scale;
      for (const e of edges) {
        const a = nodeMap.get(e.source);
        const b = nodeMap.get(e.target);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        if (e.kind === "embed") {
          ctx.setLineDash([3, 3]);
        } else {
          ctx.setLineDash([]);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Draw nodes.
      for (const n of nodes) {
        const r = NODE_RADIUS + Math.min(n.degree * 1.5, 8);
        const isActive = n.id === activeNoteId;
        const isHovered = n.id === hoveredId;
        if (isActive) {
          ctx.fillStyle = "#3b82f6";
        } else if (n.noteType === "template") {
          ctx.fillStyle = "#a855f7";
        } else if (n.noteType === "moc") {
          ctx.fillStyle = "#f59e0b";
        } else {
          ctx.fillStyle = "#6b7280";
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (isHovered) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2 / scale;
          ctx.stroke();
        }
      }

      // Draw labels (only when zoomed in or hovered).
      const showLabels = scale > 0.7;
      if (showLabels) {
        ctx.fillStyle = "#d1d5db";
        ctx.font = `${10 / scale}px sans-serif`;
        ctx.textAlign = "center";
        for (const n of nodes) {
          if (n.degree === 0 && n.id !== hoveredId && n.id !== activeNoteId) continue;
          ctx.fillText(n.title.slice(0, 24), n.x, n.y - NODE_RADIUS - 4 / scale);
        }
      }

      // Draw hovered label prominently.
      if (hoveredId) {
        const n = nodes.find((x) => x.id === hoveredId);
        if (n) {
          ctx.fillStyle = "#ffffff";
          ctx.font = "12px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(n.title, n.x, n.y - NODE_RADIUS - 8);
        }
      }

      ctx.restore();
      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationRef.current);
  }, [open, dimensions, activeNoteId, hoveredId]);

  // Mouse interactions.
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - offsetRef.current.x) / scaleRef.current;
    const y = (e.clientY - rect.top - offsetRef.current.y) / scaleRef.current;
    const node = nodesRef.current.find(
      (n) => Math.sqrt((n.x - x) ** 2 + (n.y - y) ** 2) < NODE_RADIUS + 4,
    );
    if (node) {
      dragRef.current = { nodeId: node.id, lastX: e.clientX, lastY: e.clientY, panning: false };
    } else {
      dragRef.current = { nodeId: null, lastX: e.clientX, lastY: e.clientY, panning: true };
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - offsetRef.current.x) / scaleRef.current;
    const y = (e.clientY - rect.top - offsetRef.current.y) / scaleRef.current;
    const node = nodesRef.current.find(
      (n) => Math.sqrt((n.x - x) ** 2 + (n.y - y) ** 2) < NODE_RADIUS + 4,
    );
    setHoveredId(node?.id ?? null);
    canvas.style.cursor = node ? "pointer" : dragRef.current.panning ? "grabbing" : "grab";

    const drag = dragRef.current;
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;

    if (drag.nodeId) {
      const n = nodesRef.current.find((x) => x.id === drag.nodeId);
      if (n) {
        n.x += dx / scaleRef.current;
        n.y += dy / scaleRef.current;
        n.vx = 0;
        n.vy = 0;
      }
    } else if (drag.panning) {
      offsetRef.current.x += dx;
      offsetRef.current.y += dy;
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    dragRef.current = { nodeId: null, lastX: 0, lastY: 0, panning: false };
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // Only navigate if the click didn't come from a drag.
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left - offsetRef.current.x) / scaleRef.current;
      const y = (e.clientY - rect.top - offsetRef.current.y) / scaleRef.current;
      const node = nodesRef.current.find(
        (n) => Math.sqrt((n.x - x) ** 2 + (n.y - y) ** 2) < NODE_RADIUS + 4,
      );
      if (node && onSelectNote) {
        onSelectNote(node.id);
        onOpenChange(false);
      }
    },
    [onSelectNote, onOpenChange],
  );

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = -Math.sign(e.deltaY) * 0.15;
    scaleRef.current = Math.max(0.2, Math.min(3, scaleRef.current * (1 + delta)));
  }, []);

  const zoomIn = useCallback(() => {
    scaleRef.current = Math.min(3, scaleRef.current * 1.2);
  }, []);
  const zoomOut = useCallback(() => {
    scaleRef.current = Math.max(0.2, scaleRef.current / 1.2);
  }, []);
  const resetView = useCallback(() => {
    scaleRef.current = 1;
    offsetRef.current = { x: 0, y: 0 };
  }, []);

  const stats = useMemo(() => {
    if (!graph) return null;
    const connected = graph.nodes.filter((n) =>
      graph.edges.some((e) => e.source === n.id || e.resolvedTarget === n.id),
    ).length;
    return {
      nodes: graph.nodes.length,
      edges: graph.edges.filter((e) => e.resolvedTarget).length,
      connected,
      orphans: graph.nodes.length - connected,
    };
  }, [graph]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-background/95 backdrop-blur-sm">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <span>关系图</span>
          {stats && (
            <span className="text-[11px] text-muted-foreground">
              {stats.nodes} 节点 · {stats.edges} 连接 · {stats.orphans} 孤立
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={zoomIn}>
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={zoomOut}>
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={resetView}>
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div ref={containerRef} className={cn("relative min-h-0 flex-1")}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-muted-foreground">
            正在加载关系图...
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-destructive">
            {error}
          </div>
        )}
        {!loading && !error && graph && graph.nodes.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <p className="text-[13px] text-muted-foreground">暂无笔记</p>
            <p className="text-[11px] text-muted-foreground/70">
              先创建笔记并使用 [[双链]] 标记，关系图将自动生成
            </p>
          </div>
        )}
        {!loading && !error && graph && graph.nodes.length > 0 && (
          <canvas
            ref={canvasRef}
            width={dimensions.w}
            height={dimensions.h}
            className="absolute inset-0 h-full w-full"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onClick={handleClick}
            onWheel={handleWheel}
          />
        )}
        {graph && graph.nodes.length > 0 && (
          <div className="absolute bottom-2 left-2 flex flex-col gap-0.5 rounded-md border border-border/60 bg-background/80 px-2 py-1 text-[10px] backdrop-blur-sm">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              <span>当前笔记</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              <span>MOC 索引笔记</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-purple-500" />
              <span>模板</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-gray-500" />
              <span>普通笔记</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
