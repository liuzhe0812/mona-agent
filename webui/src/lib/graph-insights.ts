export interface GraphInsight {
  type: "unexpected-connection" | "knowledge-gap"
  title: string
  detail: string
  nodeIds: string[]
}

interface InsightNode {
  id: string
  label: string
  type: string
  linkCount: number
}

interface InsightEdge {
  source: string
  target: string
}

/**
 * Find edges connecting nodes of different types where that type pair
 * is rare (below average cross-type edge count).
 */
export function findUnexpectedConnections(
  nodes: InsightNode[],
  edges: InsightEdge[],
): GraphInsight[] {
  if (nodes.length === 0 || edges.length === 0) return []

  const nodeTypeMap = new Map<string, string>()
  for (const n of nodes) nodeTypeMap.set(n.id, n.type)

  // Count cross-type edges
  const crossTypeCount = new Map<string, number>()
  let totalCrossType = 0

  for (const e of edges) {
    const srcType = nodeTypeMap.get(e.source)
    const tgtType = nodeTypeMap.get(e.target)
    if (!srcType || !tgtType || srcType === tgtType) continue
    const key = [srcType, tgtType].sort().join("→")
    crossTypeCount.set(key, (crossTypeCount.get(key) ?? 0) + 1)
    totalCrossType++
  }

  if (totalCrossType === 0) return []

  const avgCount = totalCrossType / Math.max(crossTypeCount.size, 1)

  // Find rare cross-type edges (below half of average)
  const rareTypePairs = new Set<string>()
  for (const [key, count] of crossTypeCount) {
    if (count <= Math.max(1, avgCount * 0.5)) {
      rareTypePairs.add(key)
    }
  }

  const insights: GraphInsight[] = []
  const seen = new Set<string>()

  for (const e of edges) {
    const srcType = nodeTypeMap.get(e.source)
    const tgtType = nodeTypeMap.get(e.target)
    if (!srcType || !tgtType || srcType === tgtType) continue
    const key = [srcType, tgtType].sort().join("→")
    if (!rareTypePairs.has(key)) continue

    const edgeKey = `${e.source}-${e.target}`
    if (seen.has(edgeKey)) continue
    seen.add(edgeKey)

    const srcNode = nodes.find((n) => n.id === e.source)
    const tgtNode = nodes.find((n) => n.id === e.target)
    if (!srcNode || !tgtNode) continue

    insights.push({
      type: "unexpected-connection",
      title: `${srcNode.label} ↔ ${tgtNode.label}`,
      detail: `跨类型连接 (${srcType} → ${tgtType})，此类连接较少见`,
      nodeIds: [e.source, e.target],
    })
  }

  return insights.slice(0, 20)
}

/**
 * Find isolated nodes (no edges) and sparse communities (nodes with only 1 edge).
 */
export function findKnowledgeGaps(
  nodes: InsightNode[],
  edges: InsightEdge[],
): GraphInsight[] {
  if (nodes.length === 0) return []

  const neighborCount = new Map<string, number>()
  for (const e of edges) {
    neighborCount.set(e.source, (neighborCount.get(e.source) ?? 0) + 1)
    neighborCount.set(e.target, (neighborCount.get(e.target) ?? 0) + 1)
  }

  const insights: GraphInsight[] = []

  // Isolated nodes
  const isolated = nodes.filter(
    (n) => (neighborCount.get(n.id) ?? 0) === 0,
  )
  if (isolated.length > 0) {
    insights.push({
      type: "knowledge-gap",
      title: `${isolated.length} 个孤立节点`,
      detail: `这些页面没有任何连接: ${isolated
        .slice(0, 5)
        .map((n) => n.label)
        .join(", ")}${isolated.length > 5 ? ` 等 ${isolated.length} 个` : ""}`,
      nodeIds: isolated.map((n) => n.id),
    })
  }

  // Sparse nodes (only 1 connection)
  const sparse = nodes.filter(
    (n) => (neighborCount.get(n.id) ?? 0) === 1,
  )
  if (sparse.length > 0) {
    insights.push({
      type: "knowledge-gap",
      title: `${sparse.length} 个稀疏节点`,
      detail: `这些页面仅有 1 个连接，可能缺少关联: ${sparse
        .slice(0, 5)
        .map((n) => n.label)
        .join(", ")}${sparse.length > 5 ? ` 等 ${sparse.length} 个` : ""}`,
      nodeIds: sparse.map((n) => n.id),
    })
  }

  return insights
}
