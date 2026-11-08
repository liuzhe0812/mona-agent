interface Node { type: string; url?: string; children?: Node[] }

/** Remove only verified duplicate image nodes before URL sanitization. */
export function remarkDeduplicateGeneratedImages(sources: readonly string[]) {
  const omitted = new Set(sources);
  return () => (tree: Node) => {
    const visit = (node: Node) => {
      if (!node.children) return;
      node.children = node.children.filter((child) => child.type !== "image" || !child.url || !omitted.has(child.url));
      node.children.forEach(visit);
    };
    visit(tree);
  };
}
