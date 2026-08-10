/**
 * FC-THEME-02 测试：文档主题与配色。
 *
 * 覆盖计划的测试要求：
 * - 保留模式只改变无覆盖节点（节点手动覆盖优先级 > 文档主题，主题应用不触碰 node.style）；
 * - 清理模式只删除可由主题提供的样式字段（fill/borderColor/color）；
 * - theme 变化不改变 semantic hash；
 * - undo 恢复原主题和手动覆盖（历史栈为整个文档快照，前提：应用不修改原快照）；
 * - 深色主题不改写 document theme（default palette 解析为空，回退 CSS token 跟随明暗主题）。
 */
import { describe, expect, it } from "vitest";

import {
  cloneFlowchartDocument,
  computeFlowchartSemanticHash,
  DEFAULT_FLOWCHART_CANVAS,
  DEFAULT_FLOWCHART_THEME,
  type FlowchartDocument,
  type FlowchartNode,
} from "./flowchart-document";
import {
  countNodesWithManualThemeStyles,
  FLOWCHART_PALETTES,
  getFlowchartPalette,
  resolveFlowchartThemeDefaults,
  stripThemeProvidedStyles,
  THEME_PROVIDED_STYLE_KEYS,
} from "./flowchart-themes";

function makeDoc(overrides: Partial<FlowchartDocument> = {}): FlowchartDocument {
  return {
    version: 2,
    direction: "TB",
    canvas: {
      ...DEFAULT_FLOWCHART_CANVAS,
      grid: { ...DEFAULT_FLOWCHART_CANVAS.grid },
    },
    theme: { ...DEFAULT_FLOWCHART_THEME },
    nodes: [
      { id: "n1", kind: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "n2", kind: "process", label: "处理", position: { x: 0, y: 100 } },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2" }],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...overrides,
  };
}

describe("resolveFlowchartThemeDefaults", () => {
  it("default palette 解析为空对象（回退 CSS token，跟随应用明暗主题，不改写文档主题）", () => {
    const defaults = resolveFlowchartThemeDefaults({
      stylePreset: "solid",
      paletteId: "default",
      preserveManualStyles: true,
    });
    expect(defaults).toEqual({});
  });

  it("solid：填充/描边/文字全部来自配色", () => {
    const p = getFlowchartPalette("deep-blue");
    expect(
      resolveFlowchartThemeDefaults({ stylePreset: "solid", paletteId: "deep-blue", preserveManualStyles: true }),
    ).toEqual({ fill: p.fill, stroke: p.stroke, text: p.text });
  });

  it("outline：填充透明，文字跟随描边色", () => {
    const p = getFlowchartPalette("green");
    expect(
      resolveFlowchartThemeDefaults({ stylePreset: "outline", paletteId: "green", preserveManualStyles: true }),
    ).toEqual({ fill: "transparent", stroke: p.stroke, text: p.stroke });
  });

  it("soft：使用柔和填充，描边与文字来自配色", () => {
    const p = getFlowchartPalette("red");
    expect(
      resolveFlowchartThemeDefaults({ stylePreset: "soft", paletteId: "red", preserveManualStyles: true }),
    ).toEqual({ fill: p.fillSoft, stroke: p.stroke, text: p.text });
  });

  it("未知 paletteId 回退 default", () => {
    expect(getFlowchartPalette("not-exists").id).toBe("default");
  });

  it("首批配色覆盖计划要求的 8 套", () => {
    const labels = FLOWCHART_PALETTES.map((p) => p.label);
    for (const expected of ["默认", "深蓝", "蓝灰", "绿色", "橙黄", "红色", "紫色", "单色"]) {
      expect(labels).toContain(expected);
    }
  });
});

describe("stripThemeProvidedStyles（清理模式）", () => {
  it("只删除主题可提供的字段，其余手动样式保留", () => {
    const nodes: FlowchartNode[] = [
      {
        id: "n1",
        kind: "process",
        label: "A",
        position: { x: 0, y: 0 },
        style: {
          fill: "#ff0000",
          borderColor: "#00ff00",
          color: "#0000ff",
          fontSize: 18,
          bold: true,
        },
      },
    ];
    const [stripped] = stripThemeProvidedStyles(nodes);
    expect(stripped.style).toEqual({ fontSize: 18, bold: true });
    for (const key of THEME_PROVIDED_STYLE_KEYS) {
      expect(stripped.style).not.toHaveProperty(key);
    }
  });

  it("style 清理后为空则置为 undefined", () => {
    const nodes: FlowchartNode[] = [
      {
        id: "n1",
        kind: "process",
        label: "A",
        position: { x: 0, y: 0 },
        style: { fill: "#ff0000" },
      },
    ];
    const [stripped] = stripThemeProvidedStyles(nodes);
    expect(stripped.style).toBeUndefined();
  });

  it("无主题可提供字段的节点原样返回（引用相等，保留模式语义：有覆盖节点不被触碰）", () => {
    const withOtherStyle: FlowchartNode = {
      id: "n1",
      kind: "process",
      label: "A",
      position: { x: 0, y: 0 },
      style: { fontSize: 16 },
    };
    const noStyle: FlowchartNode = {
      id: "n2",
      kind: "end",
      label: "B",
      position: { x: 0, y: 100 },
    };
    const [a, b] = stripThemeProvidedStyles([withOtherStyle, noStyle]);
    expect(a).toBe(withOtherStyle);
    expect(b).toBe(noStyle);
  });

  it("不修改输入数组与节点", () => {
    const nodes: FlowchartNode[] = [
      {
        id: "n1",
        kind: "process",
        label: "A",
        position: { x: 0, y: 0 },
        style: { fill: "#ff0000", bold: true },
      },
    ];
    const snapshot = structuredClone(nodes);
    stripThemeProvidedStyles(nodes);
    expect(nodes).toEqual(snapshot);
  });
});

describe("countNodesWithManualThemeStyles", () => {
  it("只统计有 fill/borderColor/color 覆盖的节点", () => {
    const nodes: FlowchartNode[] = [
      { id: "n1", kind: "process", label: "A", position: { x: 0, y: 0 }, style: { fill: "#f00" } },
      { id: "n2", kind: "process", label: "B", position: { x: 0, y: 0 }, style: { fontSize: 16 } },
      { id: "n3", kind: "process", label: "C", position: { x: 0, y: 0 }, style: { borderColor: "#0f0" } },
      { id: "n4", kind: "process", label: "D", position: { x: 0, y: 0 }, style: { color: "#00f" } },
      { id: "n5", kind: "process", label: "E", position: { x: 0, y: 0 } },
    ];
    expect(countNodesWithManualThemeStyles(nodes)).toBe(3);
  });
});

describe("theme 变化不改变 semantic hash", () => {
  it("仅 theme 不同的两个文档哈希相同", () => {
    const a = makeDoc();
    const b = makeDoc({
      theme: { stylePreset: "outline", paletteId: "red", preserveManualStyles: false },
    });
    expect(computeFlowchartSemanticHash(a)).toBe(computeFlowchartSemanticHash(b));
  });

  it("清理手动样式前后哈希相同", () => {
    const doc = makeDoc({
      nodes: [
        {
          id: "n1",
          kind: "start",
          label: "开始",
          position: { x: 0, y: 0 },
          style: { fill: "#ff0000", borderColor: "#00ff00", color: "#0000ff" },
        },
        { id: "n2", kind: "process", label: "处理", position: { x: 0, y: 100 } },
      ],
    });
    const stripped = { ...doc, nodes: stripThemeProvidedStyles(doc.nodes) };
    expect(computeFlowchartSemanticHash(doc)).toBe(computeFlowchartSemanticHash(stripped));
  });
});

describe("undo 恢复原主题和手动覆盖（历史快照语义）", () => {
  it("应用主题（克隆 + 清理）不修改原快照，undo 可完整恢复", () => {
    // 模拟编辑器 handleApplyTheme：克隆文档 → 改 theme → 清理手动样式 → push 新快照
    const original = makeDoc({
      nodes: [
        {
          id: "n1",
          kind: "start",
          label: "开始",
          position: { x: 0, y: 0 },
          style: { fill: "#ff0000", fontSize: 18 },
        },
        { id: "n2", kind: "process", label: "处理", position: { x: 0, y: 100 } },
      ],
    });
    const undoSnapshot = cloneFlowchartDocument(original);

    const next = cloneFlowchartDocument(original);
    next.theme = { stylePreset: "outline", paletteId: "red", preserveManualStyles: false };
    next.nodes = stripThemeProvidedStyles(next.nodes);

    // 新文档：主题已切换，手动颜色被清理，其余手动样式保留
    expect(next.theme.paletteId).toBe("red");
    expect(next.nodes[0].style).toEqual({ fontSize: 18 });
    // 原快照保持原主题和手动覆盖 → undo 回到它即完整恢复
    expect(original).toEqual(undoSnapshot);
    expect(undoSnapshot.theme).toEqual(DEFAULT_FLOWCHART_THEME);
    expect(undoSnapshot.nodes[0].style).toEqual({ fill: "#ff0000", fontSize: 18 });
  });
});
