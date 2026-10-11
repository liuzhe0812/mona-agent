interface Node { type: string; url?: string; children?: Node[] }

// Keep local URLs opaque through the HTML sanitizer. Only the project-aware
// renderer decodes them; the media API still checks resolved-path containment.
export function remarkProjectAssets() {
  return (tree: Node) => {
    const visit = (node: Node) => {
      if ((node.type === "link" || node.type === "image") && node.url
        && /^(?:file:|[a-z]:[\\/])/i.test(node.url)) {
        node.url = `mona-project:${encodeURIComponent(node.url)}`;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
