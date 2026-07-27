import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getNotesLinkGraph, saveNotesLinkPositions, type LinkGraph, type LinkNode } from "@/lib/tauri";

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

const NODE_RADIUS = 5;
const REPULSION = 800;
const SPRING_LENGTH = 70;
const SPRING_K = 0.03;
const CENTERING_K = 0.004;
const DAMPING = 0.82;
const MAX_VELOCITY = 10;

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
  const dragRef = useRef<{ nodeId: string | null; lastX: number; lastY: number; panning: boolean; moved: boolean }>({
    nodeId: null,
    lastX: 0,
    lastY: 0,
    panning: false,
    moved: false,
  });
  const animationRef = useRef<number>(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ w: 800, h: 600 });
  const [retryCount, setRetryCount] = useState(0);

  // Load graph data once per open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      setError("加载关系图超时，请检查 vault 配置后重试");
      setLoading(false);
    }, 15000);

    getNotesLinkGraph()
      .then((data) => {
        if (cancelled) return;
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
        const savedPositions = data.positions;
        nodesRef.current = data.nodes.map((n, i) => {
          // Restore saved layout positions so the graph renders near its
          // previous state instead of starting from a ring each time.
          const saved = savedPositions?.[n.id];
          if (saved) {
            return {
              ...n,
              x: saved[0],
              y: saved[1],
              vx: 0,
              vy: 0,
              degree: degreeMap.get(n.id) ?? 0,
            };
          }
          const angle = (i / Math.max(data.nodes.length, 1)) * Math.PI * 2;
          const r = 100;
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
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      })
      .finally(() => {
        if (cancelled) return;
        window.clearTimeout(timeoutId);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [open, retryCount]);

  // Save layout positions when the dialog closes so the next open restores
  // the previous view instantly without re-running the force simulation.
  useEffect(() => {
    if (open) return;
    const nodes = nodesRef.current;
    if (nodes.length === 0) return;
    const positions: Record<string, [number, number]> = {};
    for (const n of nodes) {
      positions[n.id] = [n.x, n.y];
    }
    void saveNotesLinkPositions(positions);
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

  // Sync canvas backing buffer to physical pixels for crisp rendering.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(dimensions.w * dpr);
    canvas.height = Math.round(dimensions.h * dpr);
  }, [dimensions, graph]);

  // Force simulation + render loop.
  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

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
        const v = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (v > MAX_VELOCITY) {
          n.vx = (n.vx / v) * MAX_VELOCITY;
          n.vy = (n.vy / v) * MAX_VELOCITY;
        }
        n.x += n.vx;
        n.y += n.vy;
      }

      // Compute connected set when hovering.
      let connectedSet: Set<string> | null = null;
      if (hoveredId) {
        connectedSet = new Set<string>([hoveredId]);
        for (const e of edges) {
          if (e.source === hoveredId) connectedSet.add(e.target);
          if (e.target === hoveredId) connectedSet.add(e.source);
        }
      }

      // Render with DPR scaling for crisp output.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, dimensions.w, dimensions.h);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);

      // Draw edges.
      for (const e of edges) {
        const a = nodeMap.get(e.source);
        const b = nodeMap.get(e.target);
        if (!a || !b) continue;
        const isHighlighted = hoveredId && (e.source === hoveredId || e.target === hoveredId);
        if (hoveredId && !isHighlighted) {
          ctx.strokeStyle = "rgba(100, 100, 120, 0.06)";
        } else if (isHighlighted) {
          ctx.strokeStyle = "rgba(140, 160, 255, 0.5)";
        } else {
          ctx.strokeStyle = "rgba(120, 120, 140, 0.2)";
        }
        ctx.lineWidth = (isHighlighted ? 1.5 : 1) / scale;
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
        const isActive = n.id === activeNoteId;
        const isHovered = n.id === hoveredId;
        const baseR = NODE_RADIUS + Math.min(n.degree * 1.2, 6);
        const r = isHovered ? baseR * 1.6 : baseR;

        const isConnected = hoveredId ? connectedSet?.has(n.id) : false;
        const isDimmed = hoveredId && !isConnected;

        if (isActive) {
          ctx.fillStyle = isDimmed ? "rgba(59, 130, 246, 0.2)" : "#3b82f6";
        } else if (n.noteType === "template") {
          ctx.fillStyle = isDimmed ? "rgba(168, 85, 247, 0.2)" : "#a855f7";
        } else if (n.noteType === "moc") {
          ctx.fillStyle = isDimmed ? "rgba(245, 158, 11, 0.2)" : "#f59e0b";
        } else if (isHovered) {
          ctx.fillStyle = "#60a5fa";
        } else {
          ctx.fillStyle = isDimmed ? "rgba(107, 114, 128, 0.2)" : "#6b7280";
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();

        if (isHovered) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
          ctx.lineWidth = 2 / scale;
          ctx.stroke();
        }
      }

      // Draw labels.
      const showAllLabels = scale > 0.8 && !hoveredId;
      const showSomeLabels = scale > 0.5 || hoveredId;
      if (showSomeLabels) {
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        for (const n of nodes) {
          const isHovered = n.id === hoveredId;
          const isActive = n.id === activeNoteId;
          const isConnected = hoveredId ? connectedSet?.has(n.id) : false;
          const shouldShow = isHovered || isActive || (showAllLabels && n.degree > 0) || (hoveredId && isConnected);
          if (!shouldShow) continue;

          if (isHovered) {
            ctx.fillStyle = "#1a1a1a";
            ctx.font = `600 ${12 / scale}px sans-serif`;
          } else if (isDimmedCheck(hoveredId, isConnected)) {
            ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
            ctx.font = `${10 / scale}px sans-serif`;
          } else {
            ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
            ctx.font = `${10 / scale}px sans-serif`;
          }
          const label = n.title.length > 20 ? n.title.slice(0, 20) + "…" : n.title;
          const baseR = NODE_RADIUS + Math.min(n.degree * 1.2, 6);
          const labelR = isHovered ? baseR * 1.6 : baseR;
          ctx.fillText(label, n.x, n.y - labelR - 3 / scale);
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
      (n) => Math.sqrt((n.x - x) ** 2 + (n.y - y) ** 2) < NODE_RADIUS + 6,
    );
    dragRef.current = {
      nodeId: node?.id ?? null,
      lastX: e.clientX,
      lastY: e.clientY,
      panning: !node,
      moved: false,
    };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - offsetRef.current.x) / scaleRef.current;
    const y = (e.clientY - rect.top - offsetRef.current.y) / scaleRef.current;
    const node = nodesRef.current.find(
      (n) => Math.sqrt((n.x - x) ** 2 + (n.y - y) ** 2) < NODE_RADIUS + 6,
    );
    setHoveredId(node?.id ?? null);
    canvas.style.cursor = node ? "pointer" : dragRef.current.panning ? "grabbing" : "grab";

    const drag = dragRef.current;
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
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
    dragRef.current = { nodeId: null, lastX: 0, lastY: 0, panning: false, moved: false };
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (dragRef.current.moved) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left - offsetRef.current.x) / scaleRef.current;
      const y = (e.clientY - rect.top - offsetRef.current.y) / scaleRef.current;
      const node = nodesRef.current.find(
        (n) => Math.sqrt((n.x - x) ** 2 + (n.y - y) ** 2) < NODE_RADIUS + 6,
      );
      if (node && onSelectNote) {
        onSelectNote(node.id);
      }
    },
    [onSelectNote],
  );

  // Native non-passive wheel listener so we can call preventDefault.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const delta = -Math.sign(e.deltaY) * 0.15;
      const oldScale = scaleRef.current;
      const newScale = Math.max(0.2, Math.min(3, oldScale * (1 + delta)));
      if (newScale === oldScale) return;

      const worldX = (mouseX - offsetRef.current.x) / oldScale;
      const worldY = (mouseY - offsetRef.current.y) / oldScale;
      offsetRef.current.x = mouseX - worldX * newScale;
      offsetRef.current.y = mouseY - worldY * newScale;
      scaleRef.current = newScale;
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [open, graph]);

  const zoomIn = useCallback(() => {
    const cx = dimensions.w / 2;
    const cy = dimensions.h / 2;
    const oldScale = scaleRef.current;
    const newScale = Math.min(3, oldScale * 1.2);
    const worldX = (cx - offsetRef.current.x) / oldScale;
    const worldY = (cy - offsetRef.current.y) / oldScale;
    offsetRef.current.x = cx - worldX * newScale;
    offsetRef.current.y = cy - worldY * newScale;
    scaleRef.current = newScale;
  }, [dimensions]);
  const zoomOut = useCallback(() => {
    const cx = dimensions.w / 2;
    const cy = dimensions.h / 2;
    const oldScale = scaleRef.current;
    const newScale = Math.max(0.2, oldScale / 1.2);
    const worldX = (cx - offsetRef.current.x) / oldScale;
    const worldY = (cy - offsetRef.current.y) / oldScale;
    offsetRef.current.x = cx - worldX * newScale;
    offsetRef.current.y = cy - worldY * newScale;
    scaleRef.current = newScale;
  }, [dimensions]);
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
    <div className="flex min-h-0 flex-1 flex-col bg-background">
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
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[13px] text-destructive">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-[12px]"
              onClick={() => {
                setError(null);
                setGraph(null);
                setRetryCount((c) => c + 1);
              }}
            >
              重试
            </Button>
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
            className="absolute inset-0 h-full w-full"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onClick={handleClick}
          />
        )}
        {graph && graph.nodes.length > 0 && (
          <div className="absolute bottom-2 left-2 flex flex-col gap-0.5 rounded-md border border-border/60 bg-background px-2 py-1 text-[10px]">
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

function isDimmedCheck(hoveredId: string | null, isConnected: boolean | undefined): boolean {
  return !!hoveredId && !isConnected;
}
