/**
 * v1 → v2 迁移测试（FC-DOC-03）。
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_FLOWCHART_CANVAS,
  DEFAULT_FLOWCHART_THEME,
} from "./flowchart-document";
import { migrateFlowchartV1ToV2 } from "./flowchart-migrate";

function v1Fixture(): Record<string, unknown> {
  return {
    version: 1,
    direction: "TB",
    nodes: [
      { id: "n-1", kind: "start", label: "开始", position: { x: 0, y: 0 } },
      {
        id: "n-2",
        kind: "process",
        label: "处理",
        position: { x: 0, y: 120 },
        size: { width: 200, height: 60 },
        style: { fill: "#ffffff", bold: true },
      },
      {
        id: "n-3",
        kind: "freehand",
        label: "",
        position: { x: 10, y: 10 },
        points: [{ x: 0, y: 0, pressure: 0.5 }],
        path: "M0 0L1 1",
        drawingTool: "pen",
        color: "#000000",
        opacity: 0.9,
        strokeWidth: 4,
      },
      {
        id: "n-4",
        kind: "image",
        label: "截图",
        position: { x: 50, y: 50 },
        imagePath: "assets/a.png",
      },
    ],
    edges: [
      {
        id: "e-1",
        source: "n-1",
        target: "n-2",
        label: "下一步",
        sourceHandle: "bottom",
        targetHandle: "top",
        style: { route: "smoothstep", stroke: "#333333" },
      },
    ],
    viewport: { x: 100, y: 50, zoom: 1.5 },
  };
}

describe("migrateFlowchartV1ToV2", () => {
  it("补 canvas / theme 默认值并升级 version", () => {
    const out = migrateFlowchartV1ToV2(v1Fixture());
    expect(out.version).toBe(2);
    expect(out.canvas).toEqual(DEFAULT_FLOWCHART_CANVAS);
    expect(out.theme).toEqual(DEFAULT_FLOWCHART_THEME);
  });

  it("节点按数组顺序补默认 zIndex", () => {
    const out = migrateFlowchartV1ToV2(v1Fixture());
    const nodes = out.nodes as Array<Record<string, unknown>>;
    expect(nodes.map((n) => n.zIndex)).toEqual([0, 1, 2, 3]);
  });

  it("已有 zIndex 的节点保留原值", () => {
    const raw = v1Fixture();
    (raw.nodes as Array<Record<string, unknown>>)[0].zIndex = 99;
    const out = migrateFlowchartV1ToV2(raw);
    const nodes = out.nodes as Array<Record<string, unknown>>;
    expect(nodes[0].zIndex).toBe(99);
  });

  it("v1 顶层字段、节点、边、viewport 原样保留", () => {
    const raw = v1Fixture();
    const out = migrateFlowchartV1ToV2(raw);
    expect(out.direction).toBe("TB");
    expect(out.viewport).toEqual({ x: 100, y: 50, zoom: 1.5 });
    const nodes = out.nodes as Array<Record<string, unknown>>;
    expect(nodes[1].style).toEqual({ fill: "#ffffff", bold: true });
    expect(nodes[1].size).toEqual({ width: 200, height: 60 });
    expect(nodes[2].points).toEqual([{ x: 0, y: 0, pressure: 0.5 }]);
    expect(nodes[2].path).toBe("M0 0L1 1");
    expect(nodes[3].imagePath).toBe("assets/a.png");
    const edges = out.edges as Array<Record<string, unknown>>;
    expect(edges[0]).toMatchObject({
      id: "e-1",
      source: "n-1",
      target: "n-2",
      label: "下一步",
      sourceHandle: "bottom",
      targetHandle: "top",
    });
  });

  it("不删除未知字段", () => {
    const raw = v1Fixture();
    raw.customField = { nested: [1, 2, 3] };
    const out = migrateFlowchartV1ToV2(raw);
    expect(out.customField).toEqual({ nested: [1, 2, 3] });
  });

  it("幂等：多次迁移结果一致", () => {
    const once = migrateFlowchartV1ToV2(v1Fixture());
    const twice = migrateFlowchartV1ToV2(once);
    expect(twice).toEqual(once);
  });

  it("确定性：相同输入产生相同输出", () => {
    const a = migrateFlowchartV1ToV2(v1Fixture());
    const b = migrateFlowchartV1ToV2(v1Fixture());
    expect(a).toEqual(b);
  });

  it("保留已存在的合法 canvas / theme 设置", () => {
    const raw = v1Fixture();
    raw.canvas = {
      mode: "page",
      width: 794,
      height: 1123,
      orientation: "portrait",
      background: "#ffffff",
      grid: { visible: false, snap: false, size: 8 },
    };
    raw.theme = { stylePreset: "outline", paletteId: "deep-blue", preserveManualStyles: false };
    const out = migrateFlowchartV1ToV2(raw);
    expect(out.canvas).toEqual({
      mode: "page",
      width: 794,
      height: 1123,
      orientation: "portrait",
      background: "#ffffff",
      grid: { visible: false, snap: false, size: 8 },
    });
    expect(out.theme).toEqual({
      stylePreset: "outline",
      paletteId: "deep-blue",
      preserveManualStyles: false,
    });
  });

  it("非法 canvas / theme 字段回退默认值", () => {
    const raw = v1Fixture();
    raw.canvas = { mode: "weird", grid: { size: -5 } };
    raw.theme = { stylePreset: "neon", paletteId: 42 };
    const out = migrateFlowchartV1ToV2(raw);
    expect(out.canvas).toEqual(DEFAULT_FLOWCHART_CANVAS);
    expect(out.theme).toEqual(DEFAULT_FLOWCHART_THEME);
  });

  it("不修改输入对象", () => {
    const raw = v1Fixture();
    const snapshot = JSON.parse(JSON.stringify(raw));
    migrateFlowchartV1ToV2(raw);
    expect(raw).toEqual(snapshot);
  });
});
