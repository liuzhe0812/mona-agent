export interface GraphFilterState {
  hiddenTypes: Set<string>
  hideStructural: boolean
  hideIsolated: boolean
}

export const DEFAULT_GRAPH_FILTERS: GraphFilterState = {
  hiddenTypes: new Set(),
  hideStructural: true,
  hideIsolated: false,
}

const STRUCTURAL_IDS = new Set([
  "index",
  "overview",
  "log",
  "schema",
  "purpose",
])

export function isStructuralNode(node: {
  id: string
  type: string
}): boolean {
  if (STRUCTURAL_IDS.has(node.id.toLowerCase())) return true
  if (node.type === "overview") return true
  return false
}

export function applyGraphFilters(
  nodes: Array<{ id: string; type: string; linkCount: number }>,
  edges: Array<{ source: string; target: string }>,
  filters: GraphFilterState,
): { filteredNodeIds: Set<string>; filteredEdgeCount: number } {
  const nodeIds = new Set(nodes.map((n) => n.id))
  const neighborCount = new Map<string, number>()
  for (const e of edges) {
    if (nodeIds.has(e.source) && nodeIds.has(e.target)) {
      neighborCount.set(e.source, (neighborCount.get(e.source) ?? 0) + 1)
      neighborCount.set(e.target, (neighborCount.get(e.target) ?? 0) + 1)
    }
  }

  const filteredNodeIds = new Set<string>()

  for (const node of nodes) {
    // Filter by type
    if (filters.hiddenTypes.has(node.type)) continue
    // Filter structural nodes
    if (filters.hideStructural && isStructuralNode(node)) continue
    // Filter isolated nodes
    if (filters.hideIsolated && (neighborCount.get(node.id) ?? 0) === 0)
      continue
    filteredNodeIds.add(node.id)
  }

  let filteredEdgeCount = 0
  for (const e of edges) {
    if (filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target)) {
      filteredEdgeCount++
    }
  }

  return { filteredNodeIds, filteredEdgeCount }
}
