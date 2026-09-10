export type MermaidExportFormat = "png" | "svg" | "drawio";

interface DrawioNode {
  sourceId: string;
  cellId: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: "rounded" | "rectangle" | "ellipse" | "rhombus";
}

interface DrawioEdge {
  sourceId: string;
  targetId: string;
  label: string;
  directed: boolean;
}

export async function downloadMermaidDiagram(
  svg: SVGSVGElement,
  code: string,
  format: MermaidExportFormat,
  background: string,
): Promise<void> {
  if (format === "drawio") {
    downloadBlob(
      new Blob([mermaidSvgToDrawio(svg, code)], { type: "application/xml;charset=utf-8" }),
      "mona-diagram.drawio",
    );
    return;
  }

  const serialized = serializeSvg(svg);
  if (format === "svg") {
    downloadBlob(
      new Blob([serialized], { type: "image/svg+xml;charset=utf-8" }),
      "mona-diagram.svg",
    );
    return;
  }

  const { width, height } = svgSize(svg);
  const url = URL.createObjectURL(
    new Blob([serialized], { type: "image/svg+xml;charset=utf-8" }),
  );
  try {
    const image = await loadImage(url);
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(width * scale));
    canvas.height = Math.max(1, Math.ceil(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob) downloadBlob(blob, "mona-diagram.png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function mermaidSvgToDrawio(svg: SVGSVGElement, code: string): string {
  const nodes = extractNodes(svg);
  if (nodes.length === 0) return drawioImageDocument(svg);

  const parsedEdges = parseSourceEdges(code);
  const edges = extractEdges(svg, nodes, parsedEdges);
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const offsetX = 40 - minX;
  const offsetY = 40 - minY;
  const nodeXml = nodes.map((node) => {
    const style = nodeStyle(node.shape);
    return `      <mxCell id="${node.cellId}" value="${xmlText(node.label)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${round(node.x + offsetX)}" y="${round(node.y + offsetY)}" width="${round(node.width)}" height="${round(node.height)}" as="geometry"/></mxCell>`;
  }).join("\n");
  const bySourceId = new Map(nodes.map((node) => [node.sourceId, node.cellId]));
  const edgeXml = edges.flatMap((edge, index) => {
    const source = bySourceId.get(edge.sourceId);
    const target = bySourceId.get(edge.targetId);
    if (!source || !target) return [];
    const arrow = edge.directed ? "block" : "none";
    return [`      <mxCell id="e${index + 1}" value="${xmlText(edge.label)}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=0;strokeColor=#606266;endArrow=${arrow};endFill=1;fontColor=#242424;" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`];
  }).join("\n");
  const maxX = Math.max(...nodes.map((node) => node.x + offsetX + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + offsetY + node.height));

  return drawioDocument(
    `${nodeXml}${edgeXml ? `\n${edgeXml}` : ""}`,
    Math.max(850, Math.ceil(maxX + 40)),
    Math.max(600, Math.ceil(maxY + 40)),
  );
}

function extractNodes(svg: SVGSVGElement): DrawioNode[] {
  const groups = Array.from(svg.querySelectorAll<SVGGElement>("g.node"));
  return groups.flatMap((group, index) => {
    const sourceId = sourceNodeId(group, index);
    const translate = parseTranslate(group.getAttribute("transform"));
    const shape = group.querySelector<SVGGraphicsElement>("rect, ellipse, circle, polygon");
    const bounds = shapeBounds(shape, group);
    if (!bounds) return [];
    return [{
      sourceId,
      cellId: `n${index + 1}`,
      label: nodeLabel(group),
      x: translate.x + bounds.x,
      y: translate.y + bounds.y,
      width: Math.max(80, bounds.width),
      height: Math.max(40, bounds.height),
      shape: drawioShape(shape),
    }];
  });
}

function extractEdges(
  svg: SVGSVGElement,
  nodes: DrawioNode[],
  parsedEdges: DrawioEdge[],
): DrawioEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.sourceId));
  const labels = Array.from(svg.querySelectorAll<SVGGElement>("g.edgeLabel"))
    .map((label) => elementText(label));
  const paths = Array.from(svg.querySelectorAll<SVGPathElement>("path.flowchart-link, path[data-edge='true']"));
  return paths.flatMap((path, index) => {
    const classes = Array.from(path.classList);
    const source = classes.find((name) => name.startsWith("LS-"))?.slice(3);
    const target = classes.find((name) => name.startsWith("LE-"))?.slice(3);
    const fallback = parsedEdges[index];
    const sourceId = source && nodeIds.has(source) ? source : fallback?.sourceId;
    const targetId = target && nodeIds.has(target) ? target : fallback?.targetId;
    if (!sourceId || !targetId) return [];
    return [{
      sourceId,
      targetId,
      label: labels[index] || fallback?.label || "",
      directed: path.hasAttribute("marker-end") || fallback?.directed !== false,
    }];
  });
}

function parseSourceEdges(code: string): DrawioEdge[] {
  const result: DrawioEdge[] = [];
  const edgePattern = /^\s*([A-Za-z][\w.-]*)(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}))?\s*(-->|---|-.->|==>)\s*(?:\|([^|]*)\|\s*)?([A-Za-z][\w.-]*)/;
  for (const line of code.split(/\r?\n/)) {
    const match = edgePattern.exec(line);
    if (!match) continue;
    result.push({
      sourceId: match[1],
      targetId: match[4],
      label: match[3]?.trim() ?? "",
      directed: match[2] !== "---",
    });
  }
  return result;
}

function shapeBounds(
  shape: SVGGraphicsElement | null,
  group: SVGGElement,
): { x: number; y: number; width: number; height: number } | null {
  const tag = shape?.tagName.toLowerCase();
  if (shape && tag === "rect") {
    return {
      x: numberAttr(shape, "x"),
      y: numberAttr(shape, "y"),
      width: numberAttr(shape, "width"),
      height: numberAttr(shape, "height"),
    };
  }
  if (shape && tag === "ellipse") {
    const rx = numberAttr(shape, "rx");
    const ry = numberAttr(shape, "ry");
    return { x: numberAttr(shape, "cx") - rx, y: numberAttr(shape, "cy") - ry, width: rx * 2, height: ry * 2 };
  }
  if (shape && tag === "circle") {
    const radius = numberAttr(shape, "r");
    return { x: numberAttr(shape, "cx") - radius, y: numberAttr(shape, "cy") - radius, width: radius * 2, height: radius * 2 };
  }
  if (shape && tag === "polygon") {
    const points = (shape.getAttribute("points") ?? "")
      .trim()
      .split(/\s+/)
      .map((point) => point.split(",").map(Number))
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (points.length > 0) {
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
    }
  }
  try {
    const bounds = group.getBBox();
    if (bounds.width > 0 && bounds.height > 0) return bounds;
  } catch {
    return null;
  }
  return null;
}

function drawioShape(shape: SVGGraphicsElement | null): DrawioNode["shape"] {
  const tag = shape?.tagName.toLowerCase();
  if (tag === "ellipse" || tag === "circle") return "ellipse";
  if (tag === "polygon") return "rhombus";
  if (shape && tag === "rect" && numberAttr(shape, "rx") <= 0) return "rectangle";
  return "rounded";
}

function sourceNodeId(group: SVGGElement, index: number): string {
  const dataId = group.getAttribute("data-id")?.trim();
  if (dataId) return dataId;
  const id = group.id.replace(/^flowchart-/, "").replace(/-\d+$/, "");
  return id || `node-${index + 1}`;
}

function nodeLabel(group: SVGGElement): string {
  const label = group.querySelector<SVGElement>(".nodeLabel, foreignObject, text");
  return label ? elementText(label) : sourceNodeId(group, 0);
}

function elementText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  return (clone.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

function parseTranslate(transform: string | null): { x: number; y: number } {
  const match = /translate\(\s*(-?[\d.]+)(?:[ ,]+(-?[\d.]+))?\s*\)/.exec(transform ?? "");
  return { x: Number(match?.[1] ?? 0), y: Number(match?.[2] ?? 0) };
}

function numberAttr(element: Element, name: string): number {
  const value = Number.parseFloat(element.getAttribute(name) ?? "0");
  return Number.isFinite(value) ? value : 0;
}

function nodeStyle(shape: DrawioNode["shape"]): string {
  const base = "whiteSpace=wrap;html=0;strokeColor=#d9d9d9;fillColor=#ffffff;fontColor=#242424;fontSize=16;align=center;verticalAlign=middle;";
  if (shape === "ellipse") return `${base}ellipse;aspect=fixed;`;
  if (shape === "rhombus") return `${base}rhombus;`;
  if (shape === "rectangle") return `${base}rounded=0;`;
  return `${base}rounded=1;arcSize=16;`;
}

function drawioImageDocument(svg: SVGSVGElement): string {
  const serialized = serializeSvg(svg);
  const { width, height } = svgSize(svg);
  const image = `data:image/svg+xml,${encodeURIComponent(serialized)}`;
  const cell = `      <mxCell id="n1" value="" style="shape=image;imageAspect=0;aspect=fixed;image=${image};" vertex="1" parent="1"><mxGeometry x="40" y="40" width="${round(width)}" height="${round(height)}" as="geometry"/></mxCell>`;
  return drawioDocument(cell, Math.max(850, Math.ceil(width + 80)), Math.max(600, Math.ceil(height + 80)));
}

function drawioDocument(cells: string, pageWidth: number, pageHeight: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="Mona" type="device" compressed="false">
  <diagram id="mona-mermaid" name="Page-1">
    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${pageWidth}" pageHeight="${pageHeight}" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
${cells}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
}

function serializeSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const { width, height } = svgSize(svg);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  return new XMLSerializer().serializeToString(clone);
}

function svgSize(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = (svg.getAttribute("viewBox") ?? "").trim().split(/[ ,]+/).map(Number);
  const width = viewBox.length === 4 && viewBox[2] > 0
    ? viewBox[2]
    : Number.parseFloat(svg.getAttribute("width") ?? "800");
  const height = viewBox.length === 4 && viewBox[3] > 0
    ? viewBox[3]
    : Number.parseFloat(svg.getAttribute("height") ?? "600");
  return {
    width: Number.isFinite(width) && width > 0 ? width : 800,
    height: Number.isFinite(height) && height > 0 ? height : 600,
  };
}

function xmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "&#xa;");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image load failed"));
    image.src = src;
  });
}
