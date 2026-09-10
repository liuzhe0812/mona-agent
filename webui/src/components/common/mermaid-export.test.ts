import { describe, expect, it } from "vitest";

import { mermaidSvgToDrawio } from "./mermaid-export";

function flowchartSvg(): SVGSVGElement {
  const document = new DOMParser().parseFromString(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 220">
      <g class="node" id="flowchart-client-0" data-id="client" transform="translate(100,60)">
        <rect x="-70" y="-25" width="140" height="50" rx="8"/>
        <foreignObject><div><span class="nodeLabel">Mona 客户端</span></div></foreignObject>
      </g>
      <g class="node" id="flowchart-api-1" data-id="api" transform="translate(310,160)">
        <rect x="-60" y="-25" width="120" height="50" rx="8"/>
        <foreignObject><div><span class="nodeLabel">业务 API</span></div></foreignObject>
      </g>
      <path class="flowchart-link LS-client LE-api" marker-end="url(#arrow)"/>
      <g class="edgeLabel">HTTPS</g>
    </svg>
  `, "image/svg+xml");
  return document.documentElement as unknown as SVGSVGElement;
}

describe("Mermaid Draw.io export", () => {
  it("creates editable Draw.io nodes and a connected edge", () => {
    const xml = mermaidSvgToDrawio(
      flowchartSvg(),
      "flowchart TD\n  client[Mona 客户端] -->|HTTPS| api[业务 API]",
    );
    const document = new DOMParser().parseFromString(xml, "application/xml");

    expect(document.querySelector("parsererror")).toBeNull();
    const nodes = Array.from(document.querySelectorAll("mxCell[vertex='1']"));
    const edges = Array.from(document.querySelectorAll("mxCell[edge='1']"));
    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.getAttribute("value"))).toEqual(["Mona 客户端", "业务 API"]);
    expect(edges).toHaveLength(1);
    expect(edges[0].getAttribute("source")).toBe("n1");
    expect(edges[0].getAttribute("target")).toBe("n2");
    expect(edges[0].getAttribute("value")).toBe("HTTPS");
  });

  it("falls back to an embedded SVG for Mermaid types without flowchart nodes", () => {
    const document = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><text>Timeline</text></svg>',
      "image/svg+xml",
    );
    const xml = mermaidSvgToDrawio(
      document.documentElement as unknown as SVGSVGElement,
      "timeline\n  2026 : Launch",
    );
    const drawio = new DOMParser().parseFromString(xml, "application/xml");

    expect(drawio.querySelector("parsererror")).toBeNull();
    expect(drawio.querySelector("mxCell[vertex='1']")?.getAttribute("style"))
      .toContain("shape=image");
  });
});
