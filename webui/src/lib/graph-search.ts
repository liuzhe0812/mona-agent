export function searchGraphNodes(
  nodes: Array<{ id: string; label: string; type: string }>,
  query: string,
): Set<string> {
  if (!query.trim()) return new Set(nodes.map((n) => n.id))

  const lowerQuery = query.toLowerCase()
  const matchingIds = new Set<string>()

  for (const node of nodes) {
    if (
      node.id.toLowerCase().includes(lowerQuery) ||
      node.label.toLowerCase().includes(lowerQuery) ||
      node.type.toLowerCase().includes(lowerQuery)
    ) {
      matchingIds.add(node.id)
    }
  }

  return matchingIds
}
