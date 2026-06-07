import { useEffect, useCallback, useMemo, useState, useRef } from "react"
import Graph from "graphology"
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSetSettings, useSigma } from "@react-sigma/core"
import "@react-sigma/core/lib/style.css"
import forceAtlas2 from "graphology-layout-forceatlas2"
import { Network, RefreshCw, ZoomIn, ZoomOut, Maximize, Layers, Tag, Filter, Search, Lightbulb, X } from "lucide-react"
import { ErrorBoundary } from "@/components/error-boundary"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useKbStore } from "@/stores/kb-store"
import type { GraphNode as KbGraphNode, GraphEdge as KbGraphEdge } from "@/lib/kb-api"
import {
  applyGraphFilters,
  DEFAULT_GRAPH_FILTERS,
  type GraphFilterState,
} from "@/lib/graph-filters"
import { searchGraphNodes } from "@/lib/graph-search"
import {
  findUnexpectedConnections,
  findKnowledgeGaps,
  type GraphInsight,
} from "@/lib/graph-insights"

// --- Types ---

interface InternalGraphNode {
  id: string
  label: string
  type: string
  path: string
  linkCount: number
  community: number
}

interface InternalGraphEdge {
  source: string
  target: string
  weight: number
}

type ColorMode = "type" | "community"
type HoverState = { node: string; neighbors: Set<string> } | null

type GraphThemePalette = {
  defaultEdge: string
  label: string
  mutedNodeMixTarget: string
  dimmedEdge: string
  activeEdge: string
}

// --- Constants ---

const NODE_TYPE_COLORS: Record<string, string> = {
  entity: "#60a5fa",
  concept: "#c084fc",
  source: "#fb923c",
  query: "#4ade80",
  synthesis: "#f87171",
  overview: "#facc15",
  comparison: "#2dd4bf",
  finding: "#a855f7",
  thesis: "#f43f5e",
  methodology: "#14b8a6",
  other: "#94a3b8",
}

const NODE_TYPE_LABELS: Record<string, string> = {
  entity: "实体",
  concept: "概念",
  source: "来源",
  query: "查询",
  synthesis: "综合",
  overview: "概览",
  comparison: "对比",
  finding: "发现",
  thesis: "论点",
  methodology: "方法",
  other: "其他",
}

function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABELS[type] ?? type
}

const COMMUNITY_COLORS = [
  "#60a5fa", "#4ade80", "#fb923c", "#c084fc",
  "#f87171", "#2dd4bf", "#facc15", "#f472b6",
  "#a78bfa", "#38bdf8", "#34d399", "#fbbf24",
]

const BASE_NODE_SIZE = 8
const MAX_NODE_SIZE = 28
const WORKER_LAYOUT_NODE_THRESHOLD = 220

// --- Helpers ---

function graphThemePalette(isDark: boolean): GraphThemePalette {
  return isDark
    ? {
        defaultEdge: "rgba(148,163,184,0.45)",
        label: "#e2e8f0",
        mutedNodeMixTarget: "#334155",
        dimmedEdge: "rgba(71,85,105,0.15)",
        activeEdge: "#38bdf8",
      }
    : {
        defaultEdge: "#94a3b8",
        label: "#1e293b",
        mutedNodeMixTarget: "#e2e8f0",
        dimmedEdge: "rgba(148,163,184,0.22)",
        activeEdge: "#1e293b",
      }
}

function useResolvedDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"))
  useEffect(() => {
    const root = document.documentElement
    const sync = () => setIsDark(root.classList.contains("dark"))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  return isDark
}

function nodeColor(type: string): string {
  return NODE_TYPE_COLORS[type] ?? NODE_TYPE_COLORS.other
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function mixColor(color1: string, color2: string, ratio: number): string {
  const hex = (c: string) => parseInt(c, 16)
  const r1 = hex(color1.slice(1, 3)), g1 = hex(color1.slice(3, 5)), b1 = hex(color1.slice(5, 7))
  const r2 = hex(color2.slice(1, 3)), g2 = hex(color2.slice(3, 5)), b2 = hex(color2.slice(5, 7))
  const r = Math.round(r1 + (r2 - r1) * ratio)
  const g = Math.round(g1 + (g2 - g1) * ratio)
  const b = Math.round(b1 + (b2 - b1) * ratio)
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}

function graphDensityScale(nodeCount: number): number {
  if (nodeCount <= 150) return 1
  return Math.max(0.35, Math.sqrt(150 / nodeCount))
}

function calcNodeSize(linkCount: number, maxLinks: number, nodeCount: number): number {
  if (maxLinks === 0) return BASE_NODE_SIZE
  const ratio = linkCount / maxLinks
  const size = BASE_NODE_SIZE + Math.sqrt(ratio) * (MAX_NODE_SIZE - BASE_NODE_SIZE)
  return size * graphDensityScale(nodeCount)
}

function layoutIterations(nodeCount: number): number {
  if (nodeCount > 2500) return 28
  if (nodeCount > 1200) return 40
  if (nodeCount > 600) return 65
  if (nodeCount > 250) return 90
  return 140
}

function edgeVisibilityThreshold(nodeCount: number): number {
  if (nodeCount > 2500) return 0.16
  if (nodeCount > 1200) return 0.1
  if (nodeCount > 700) return 0.05
  return 0
}

function labelSizeThreshold(nodeCount: number): number {
  if (nodeCount > 2500) return 18
  if (nodeCount > 1200) return 14
  if (nodeCount > 600) return 10
  return 6
}

function labelDensity(nodeCount: number): number {
  if (nodeCount > 2500) return 0.08
  if (nodeCount > 1200) return 0.14
  if (nodeCount > 600) return 0.24
  return 0.4
}

/** Strip trailing parenthesized English from labels like "标题 (English Title)" → "标题" */
function stripTrailingEnglishParen(label: string): string {
  return label.replace(/\s*\([A-Za-z][^)]*\)\s*$/, "").trim() || label
}

// Convert API graph data to internal format with linkCount
function buildInternalGraph(
  apiNodes: KbGraphNode[],
  apiEdges: KbGraphEdge[],
): { nodes: InternalGraphNode[]; edges: InternalGraphEdge[] } {
  // Count links per node
  const linkCounts = new Map<string, number>()
  for (const n of apiNodes) linkCounts.set(n.id, 0)
  for (const e of apiEdges) {
    linkCounts.set(e.source, (linkCounts.get(e.source) ?? 0) + 1)
    linkCounts.set(e.target, (linkCounts.get(e.target) ?? 0) + 1)
  }

  const nodes: InternalGraphNode[] = apiNodes.map((n) => ({
    id: n.id,
    label: stripTrailingEnglishParen(n.label),
    type: n.type,
    path: n.path ?? n.id,
    linkCount: linkCounts.get(n.id) ?? 0,
    community: 0, // no community detection for now
  }))

  const edges: InternalGraphEdge[] = apiEdges.map((e) => ({
    source: e.source,
    target: e.target,
    weight: 1,
  }))

  return { nodes, edges }
}

// --- Layout Worker ---

function makeLayoutWorker(): Worker | null {
  try {
    return new Worker(new URL("./graph-layout-worker.ts", import.meta.url), { type: "module" })
  } catch (err) {
    console.warn("[Graph] failed to start layout worker; falling back to main-thread layout:", err)
    return null
  }
}

// --- Inner components ---

const positionCache = new Map<string, { x: number; y: number }>()
let lastLayoutDataKey = ""
let pendingLayoutDataKey = ""

function GraphLoader({
  nodes,
  edges,
  colorMode,
  palette,
}: {
  nodes: InternalGraphNode[]
  edges: InternalGraphEdge[]
  colorMode: ColorMode
  palette: GraphThemePalette
}) {
  const loadGraph = useLoadGraph()
  const sigma = useSigma()

  useEffect(() => {
    const dataKey = `${nodes.length}:${edges.length}:${nodes.map((n) => n.id).sort().join(",")}`
    const needsLayout = dataKey !== lastLayoutDataKey && dataKey !== pendingLayoutDataKey
    let cancelled = false
    let worker: Worker | null = null

    const graph = new Graph()
    const maxLinks = Math.max(...nodes.map((n) => n.linkCount), 1)
    const weakEdgeThreshold = edgeVisibilityThreshold(nodes.length)

    for (const node of nodes) {
      const cached = positionCache.get(node.id)
      const color = colorMode === "community"
        ? COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length]
        : nodeColor(node.type)
      graph.addNode(node.id, {
        type: "circle",
        x: cached?.x ?? Math.random() * 100,
        y: cached?.y ?? Math.random() * 100,
        size: calcNodeSize(node.linkCount, maxLinks, nodes.length),
        color,
        label: node.label,
        nodeType: node.type,
        nodePath: node.path,
        community: node.community,
      })
    }

    for (const edge of edges) {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        const edgeKey = `${edge.source}->${edge.target}`
        if (!graph.hasEdge(edgeKey) && !graph.hasEdge(`${edge.target}->${edge.source}`)) {
          graph.addEdgeWithKey(edgeKey, edge.source, edge.target, {
            color: palette.defaultEdge,
            size: 1.5,
            weight: edge.weight,
            normalizedWeight: 1,
            sourceNode: edge.source,
            targetNode: edge.target,
            lowPriority: weakEdgeThreshold > 0,
          })
        }
      }
    }

    const runMainThreadLayout = () => {
      const settings = forceAtlas2.inferSettings(graph)
      forceAtlas2.assign(graph, {
        iterations: layoutIterations(nodes.length),
        settings: {
          ...settings,
          gravity: 1,
          scalingRatio: nodes.length > 400 ? 3 : 2,
          strongGravityMode: true,
          barnesHutOptimize: nodes.length > 50,
        },
      })
      lastLayoutDataKey = dataKey
      graph.forEachNode((nodeId, attrs) => {
        positionCache.set(nodeId, { x: attrs.x, y: attrs.y })
      })
    }

    if (needsLayout && nodes.length > 1 && nodes.length < WORKER_LAYOUT_NODE_THRESHOLD) {
      runMainThreadLayout()
    }

    loadGraph(graph)

    if (needsLayout && nodes.length >= WORKER_LAYOUT_NODE_THRESHOLD) {
      worker = makeLayoutWorker()
      if (!worker) {
        runMainThreadLayout()
        loadGraph(graph)
        return undefined
      }
      pendingLayoutDataKey = dataKey

      worker.onmessage = (event: MessageEvent<{ key: string; positions: Array<{ id: string; x: number; y: number }> }>) => {
        if (cancelled || event.data.key !== dataKey) return
        for (const { id, x, y } of event.data.positions) {
          if (!graph.hasNode(id)) continue
          graph.setNodeAttribute(id, "x", x)
          graph.setNodeAttribute(id, "y", y)
          positionCache.set(id, { x, y })
        }
        lastLayoutDataKey = dataKey
        if (pendingLayoutDataKey === dataKey) pendingLayoutDataKey = ""
        sigma.refresh()
      }
      worker.onerror = (event) => {
        if (cancelled) return
        console.warn("[Graph] layout worker failed; falling back:", event.message)
        if (pendingLayoutDataKey === dataKey) pendingLayoutDataKey = ""
        runMainThreadLayout()
        loadGraph(graph)
      }
      worker.postMessage({
        key: dataKey,
        nodes: nodes.map((node) => {
          const cached = positionCache.get(node.id)
          return {
            id: node.id,
            x: cached?.x ?? graph.getNodeAttribute(node.id, "x"),
            y: cached?.y ?? graph.getNodeAttribute(node.id, "y"),
          }
        }),
        edges: edges.map((edge) => ({ source: edge.source, target: edge.target, weight: edge.weight })),
        iterations: layoutIterations(nodes.length),
        scalingRatio: nodes.length > 400 ? 3 : 2,
      })
    }

    return () => {
      cancelled = true
      if (pendingLayoutDataKey === dataKey) pendingLayoutDataKey = ""
      worker?.terminate()
    }
  }, [loadGraph, sigma, nodes, edges, colorMode])

  return null
}

function GraphRenderSettings({
  hoverState,
  highlightedNodes,
  nodeCount,
  palette,
}: {
  hoverState: HoverState
  highlightedNodes: Set<string>
  nodeCount: number
  palette: GraphThemePalette
}) {
  const sigma = useSigma()
  const setSettings = useSetSettings()

  useEffect(() => {
    setSettings({
      hideEdgesOnMove: true,
      hideLabelsOnMove: true,
      labelDensity: labelDensity(nodeCount),
      labelRenderedSizeThreshold: labelSizeThreshold(nodeCount),
      renderEdgeLabels: false,
      nodeReducer: (node, attrs) => {
        const result = { ...attrs }
        const hasHover = !!hoverState
        const hasHighlight = highlightedNodes.size > 0
        const isHoverNode = hoverState?.node === node
        const isHoverNeighbor = hoverState?.neighbors.has(node) ?? false
        const isHighlighted = highlightedNodes.has(node)

        if (isHighlighted) {
          result.size = (attrs.size ?? BASE_NODE_SIZE) * 1.5
          result.zIndex = 10
          result.forceLabel = true
        }
        if (isHoverNode) {
          result.size = (attrs.size ?? BASE_NODE_SIZE) * 1.4
          result.zIndex = 10
          result.forceLabel = true
        }
        if ((hasHover && !isHoverNode && !isHoverNeighbor) || (hasHighlight && !isHighlighted)) {
          result.color = mixColor(attrs.color ?? "#94a3b8", palette.mutedNodeMixTarget, 0.75)
          result.label = ""
          result.size = (attrs.size ?? BASE_NODE_SIZE) * 0.6
        }
        return result
      },
      edgeReducer: (_edge, attrs) => {
        const result = { ...attrs }
        const source = String(attrs.sourceNode ?? "")
        const target = String(attrs.targetNode ?? "")
        const hasHover = !!hoverState
        const hasHighlight = highlightedNodes.size > 0
        const hoverEdge = hasHover && (source === hoverState?.node || target === hoverState?.node)
        const highlightedEdge = hasHighlight && highlightedNodes.has(source) && highlightedNodes.has(target)

        if (attrs.lowPriority && !hoverEdge && !highlightedEdge) {
          result.hidden = true
          return result
        }
        if ((hasHover && !hoverEdge) || (hasHighlight && !highlightedEdge)) {
          result.color = palette.dimmedEdge
          result.size = 0.3
        }
        if (hoverEdge || highlightedEdge) {
          result.color = palette.activeEdge
          result.size = Math.max(2, (attrs.size ?? 1) * 1.5)
        }
        return result
      },
    })
    sigma.refresh()
  }, [setSettings, sigma, hoverState, highlightedNodes, nodeCount, palette])

  return null
}

function EventHandler({
  onNodeClick,
  onHoverChange,
}: {
  onNodeClick: (nodeId: string) => void
  onHoverChange: (state: HoverState) => void
}) {
  const registerEvents = useRegisterEvents()
  const sigma = useSigma()

  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => onNodeClick(node),
      enterNode: ({ node }) => {
        const container = sigma.getContainer()
        container.style.cursor = "pointer"
        const graph = sigma.getGraph()
        onHoverChange({ node, neighbors: new Set(graph.neighbors(node)) })
      },
      leaveNode: () => {
        const container = sigma.getContainer()
        container.style.cursor = "default"
        onHoverChange(null)
      },
    })
  }, [registerEvents, sigma, onNodeClick, onHoverChange])

  return null
}

function ZoomControls() {
  const sigma = useSigma()

  return (
    <div className="absolute top-3 right-3 flex flex-col gap-1">
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          const camera = sigma.getCamera()
          camera.animatedZoom({ duration: 200 })
        }}
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          const camera = sigma.getCamera()
          camera.animatedUnzoom({ duration: 200 })
        }}
      >
        <ZoomOut className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          const camera = sigma.getCamera()
          camera.animatedReset({ duration: 300 })
        }}
      >
        <Maximize className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

// --- Filter dropdown ---

function FilterDropdown({
  filters,
  onFiltersChange,
  typeCounts,
}: {
  filters: GraphFilterState
  onFiltersChange: (filters: GraphFilterState) => void
  typeCounts: Record<string, number>
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  const toggleType = (type: string) => {
    const next = new Set(filters.hiddenTypes)
    if (next.has(type)) next.delete(type)
    else next.add(type)
    onFiltersChange({ ...filters, hiddenTypes: next })
  }

  const activeFilterCount =
    filters.hiddenTypes.size +
    (filters.hideStructural ? 1 : 0) +
    (filters.hideIsolated ? 1 : 0)

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="sm"
        className={`text-xs gap-1 h-7 ${activeFilterCount > 0 ? "text-primary" : ""}`}
        onClick={() => setOpen(!open)}
      >
        <Filter className="h-3 w-3" />
        筛选
        {activeFilterCount > 0 && (
          <span className="rounded-full bg-primary px-1 py-0.5 text-[10px] text-primary-foreground">
            {activeFilterCount}
          </span>
        )}
      </Button>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 w-56 rounded-lg border bg-background p-3 shadow-lg">
          <div className="mb-2 text-xs font-medium text-muted-foreground">节点类型</div>
          {Object.entries(typeCounts).map(([type, count]) => (
            <label
              key={type}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-accent/50"
            >
              <input
                type="checkbox"
                checked={!filters.hiddenTypes.has(type)}
                onChange={() => toggleType(type)}
                className="rounded"
              />
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: nodeColor(type) }}
              />
              <span className="flex-1">{nodeTypeLabel(type)}</span>
              <span className="text-muted-foreground">{count}</span>
            </label>
          ))}
          <div className="my-2 border-t" />
          <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-accent/50">
            <input
              type="checkbox"
              checked={filters.hideStructural}
              onChange={() =>
                onFiltersChange({ ...filters, hideStructural: !filters.hideStructural })
              }
              className="rounded"
            />
            <span className="flex-1">隐藏结构页面</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-accent/50">
            <input
              type="checkbox"
              checked={filters.hideIsolated}
              onChange={() =>
                onFiltersChange({ ...filters, hideIsolated: !filters.hideIsolated })
              }
              className="rounded"
            />
            <span className="flex-1">隐藏孤立节点</span>
          </label>
          <div className="mt-2 border-t pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-full text-[11px]"
              onClick={() => onFiltersChange({ ...DEFAULT_GRAPH_FILTERS, hiddenTypes: new Set() })}
            >
              重置筛选
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// --- Insights panel ---

function InsightsPanel({
  insights,
  onClose,
  onHighlightNodes,
}: {
  insights: GraphInsight[]
  onClose: () => void
  onHighlightNodes: (nodeIds: Set<string>) => void
}) {
  return (
    <div className="absolute top-3 left-3 z-40 w-72 rounded-lg border bg-background/95 backdrop-blur-sm p-3 shadow-lg">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">图谱洞察</span>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {insights.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂无洞察</p>
      ) : (
        <div className="flex flex-col gap-2 max-h-60 overflow-auto">
          {insights.map((insight, i) => (
            <button
              key={i}
              className="rounded border px-2.5 py-2 text-left text-xs transition-colors hover:bg-accent"
              onClick={() => onHighlightNodes(new Set(insight.nodeIds))}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                    insight.type === "unexpected-connection"
                      ? "bg-amber-500/10 text-amber-600"
                      : "bg-blue-500/10 text-blue-600"
                  }`}
                >
                  {insight.type === "unexpected-connection" ? "意外连接" : "知识缺口"}
                </span>
              </div>
              <p className="mt-1 font-medium">{insight.title}</p>
              <p className="mt-0.5 text-muted-foreground">{insight.detail}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Main component ---

interface GraphViewProps {
  onNavigateToWiki?: (path: string) => void
}

export function GraphView({ onNavigateToWiki }: GraphViewProps) {
  const { graphData, loadWikiPage, loadGraph: reloadGraph } = useKbStore()
  const isDarkMode = useResolvedDarkMode()
  const graphPalette = useMemo(() => graphThemePalette(isDarkMode), [isDarkMode])

  const [colorMode, setColorMode] = useState<ColorMode>("type")
  const [hoverState, setHoverState] = useState<HoverState>(null)
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set())
  const [legendCollapsed, setLegendCollapsed] = useState(false)
  const [hoveredType, setHoveredType] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [showInsights, setShowInsights] = useState(false)
  const [filters, setFilters] = useState<GraphFilterState>({
    ...DEFAULT_GRAPH_FILTERS,
    hiddenTypes: new Set(),
  })

  // Convert API data to internal format
  const { nodes, edges } = useMemo(() => {
    if (!graphData) return { nodes: [], edges: [] }
    return buildInternalGraph(graphData.nodes, graphData.edges)
  }, [graphData])

  // Apply filters
  const { filteredNodes, filteredEdges } = useMemo(() => {
    const { filteredNodeIds } = applyGraphFilters(
      nodes.map((n) => ({ id: n.id, type: n.type, linkCount: n.linkCount })),
      edges.map((e) => ({ source: e.source, target: e.target })),
      filters,
    )
    return {
      filteredNodes: nodes.filter((n) => filteredNodeIds.has(n.id)),
      filteredEdges: edges.filter(
        (e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target),
      ),
    }
  }, [nodes, edges, filters])

  // Apply search highlighting
  const searchMatchIds = useMemo(() => {
    return searchGraphNodes(filteredNodes, searchQuery)
  }, [filteredNodes, searchQuery])

  // Combine search and insight highlights
  const effectiveHighlighted = useMemo(() => {
    const combined = new Set(highlightedNodes)
    if (searchQuery.trim()) {
      for (const id of searchMatchIds) combined.add(id)
    }
    return combined
  }, [highlightedNodes, searchQuery, searchMatchIds])

  // Count nodes by type for legend
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const n of filteredNodes) counts[n.type] = (counts[n.type] ?? 0) + 1
    return counts
  }, [filteredNodes])

  // Compute insights
  const insights = useMemo(() => {
    if (!showInsights) return []
    return [
      ...findUnexpectedConnections(filteredNodes, filteredEdges),
      ...findKnowledgeGaps(filteredNodes, filteredEdges),
    ]
  }, [filteredNodes, filteredEdges, showInsights])

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId)
      if (node?.path) {
        loadWikiPage(node.path)
        onNavigateToWiki?.(node.path)
      }
    },
    [nodes, loadWikiPage, onNavigateToWiki],
  )

  const handleHoverChange = useCallback((state: HoverState) => {
    setHoverState(state)
  }, [])

  const handleHighlightNodes = useCallback((nodeIds: Set<string>) => {
    setHighlightedNodes(nodeIds)
  }, [])

  if (!graphData || nodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Network className="h-10 w-10 opacity-30" />
        <p className="text-sm">暂无知识图谱数据</p>
        <p className="text-xs">编译源文件后自动生成</p>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">知识图谱</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5">{filteredNodes.length} 节点</span>
            <span className="rounded bg-muted px-1.5 py-0.5">{filteredEdges.length} 连线</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索节点..."
              className="h-7 w-32 pl-7 text-xs"
            />
            {searchQuery && (
              <button
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setSearchQuery("")}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <FilterDropdown
            filters={filters}
            onFiltersChange={setFilters}
            typeCounts={typeCounts}
          />
          <Button
            variant={colorMode === "type" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setColorMode("type")}
            className="text-xs gap-1 h-7"
          >
            <Tag className="h-3 w-3" />
            类型
          </Button>
          <Button
            variant={colorMode === "community" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setColorMode("community")}
            className="text-xs gap-1 h-7"
          >
            <Layers className="h-3 w-3" />
            社区
          </Button>
          <Button
            variant={showInsights ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowInsights(!showInsights)}
            className="text-xs gap-1 h-7"
          >
            <Lightbulb className="h-3 w-3" />
            洞察
          </Button>
          <Button variant="ghost" size="sm" onClick={reloadGraph} className="text-xs gap-1 h-7">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Graph canvas */}
      <div className="relative flex-1 min-h-0 overflow-hidden bg-background">
        <ErrorBoundary>
          <SigmaContainer
            style={{ width: "100%", height: "100%", background: "transparent" }}
            settings={{
              defaultNodeType: "circle",
              renderEdgeLabels: false,
              hideEdgesOnMove: true,
              hideLabelsOnMove: true,
              defaultEdgeColor: graphPalette.defaultEdge,
              defaultNodeColor: "#94a3b8",
              labelSize: 13,
              labelWeight: "bold",
              labelColor: { color: graphPalette.label },
              stagePadding: 30,
            }}
          >
            <GraphLoader nodes={filteredNodes} edges={filteredEdges} colorMode={colorMode} palette={graphPalette} />
            <EventHandler onNodeClick={handleNodeClick} onHoverChange={handleHoverChange} />
            <GraphRenderSettings
              hoverState={hoverState}
              highlightedNodes={effectiveHighlighted}
              nodeCount={filteredNodes.length}
              palette={graphPalette}
            />
            <ZoomControls />
          </SigmaContainer>
        </ErrorBoundary>

        {/* Insights panel */}
        {showInsights && (
          <InsightsPanel
            insights={insights}
            onClose={() => setShowInsights(false)}
            onHighlightNodes={handleHighlightNodes}
          />
        )}

        {/* Legend */}
        <div className="absolute bottom-3 left-3 rounded-lg border bg-background/90 backdrop-blur-sm px-3 py-2 text-xs shadow-sm max-w-[260px]">
          <div className="flex items-center justify-between mb-1.5">
            <span className="font-semibold text-foreground">
              {colorMode === "type" ? "节点类型" : "社区"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => setLegendCollapsed(!legendCollapsed)}
            >
              {legendCollapsed ? "▶" : "▼"}
            </Button>
          </div>
          {!legendCollapsed && (
            colorMode === "type" ? (
              <div className="flex flex-col gap-0.5">
                {Object.entries(NODE_TYPE_COLORS)
                  .filter(([type]) => (typeCounts[type] ?? 0) > 0)
                  .map(([type, color]) => (
                    <div
                      key={type}
                      className="flex items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-accent/50"
                      onMouseEnter={() => setHoveredType(type)}
                      onMouseLeave={() => setHoveredType(null)}
                    >
                      <span
                        className="inline-block h-3 w-3 rounded-full shrink-0 shadow-sm"
                        style={{
                          backgroundColor: color,
                          boxShadow: `0 0 4px ${hexToRgba(color, 0.4)}`,
                        }}
                      />
                      <span className={hoveredType === type ? "text-foreground font-medium" : "text-muted-foreground"}>
                        {nodeTypeLabel(type)}
                      </span>
                      <span className="text-muted-foreground/60 ml-auto">{typeCounts[type]}</span>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="text-muted-foreground text-[11px]">
                社区检测需要更多节点数据
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}
