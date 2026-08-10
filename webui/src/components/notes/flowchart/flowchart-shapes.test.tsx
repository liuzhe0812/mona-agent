/**
 * 流程图形状几何测试（FC-SHAPE-02）。
 *
 * 验证：
 * 1. 每个 catalog kind 都能渲染；
 * 2. catalog 没有重复 kind；
 * 3. FLOWCHART_NODE_KINDS 与 catalog 覆盖关系明确；
 * 4. 默认 stroke/fill 是有效 token；
 * 5. circle、connector 等需要等比缩放的形状设置 keepAspectRatio；
 * 6. SVG 不包含用户输入 HTML、脚本或外部 URL。
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { FLOWCHART_NODE_KINDS } from "./flowchart-document";
import {
  FLOWCHART_SHAPE_CATALOG,
  getFlowchartShapeById,
  getFlowchartShapeId,
  groupShapesByCategory,
  renderFlowchartShape,
  renderFlowchartShapePreview,
  searchFlowchartShapes,
} from "./flowchart-shapes";

describe("FLOWCHART_SHAPE_CATALOG", () => {
  it("目录条目 id 唯一（同 kind 允许多个入口，如横向/纵向泳池）", () => {
    const ids = FLOWCHART_SHAPE_CATALOG.map((s) => getFlowchartShapeId(s));
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("每个条目都有 label、category、defaultSize", () => {
    for (const shape of FLOWCHART_SHAPE_CATALOG) {
      expect(shape.label).toBeTruthy();
      expect(["basic", "flowchart", "swimlane"]).toContain(shape.category);
      expect(shape.defaultSize.width).toBeGreaterThan(0);
      expect(shape.defaultSize.height).toBeGreaterThan(0);
    }
  });

  it("FLOWCHART_NODE_KINDS 中的容器 kind 在 catalog 中存在", () => {
    const catalogKinds = new Set(FLOWCHART_SHAPE_CATALOG.map((s) => s.kind));
    const containerKinds = ["group", "swimlane-pool", "swimlane-lane"] as const;
    for (const kind of containerKinds) {
      if (FLOWCHART_NODE_KINDS.includes(kind)) {
        // group 是容器但不在 catalog 中（通过组合操作创建，不是图形库入口）
        if (kind !== "group") {
          expect(catalogKinds.has(kind), `catalog 缺少容器 kind: ${kind}`).toBe(true);
        }
      }
    }
  });

  it("FC-SWIM-01：泳池/泳道 6 个入口齐备且 creation 合法", () => {
    const entries = FLOWCHART_SHAPE_CATALOG.filter((s) => s.category === "swimlane");
    const byId = new Map(entries.map((s) => [getFlowchartShapeId(s), s]));
    expect(byId.size).toBe(6);
    const expected: Array<[string, "pool" | "lane" | "divider", "horizontal" | "vertical"]> = [
      ["swimlane-pool-h", "pool", "horizontal"],
      ["swimlane-pool-v", "pool", "vertical"],
      ["swimlane-lane-h", "lane", "horizontal"],
      ["swimlane-lane-v", "lane", "vertical"],
      ["swimlane-divider-h", "divider", "horizontal"],
      ["swimlane-divider-v", "divider", "vertical"],
    ];
    for (const [id, action, orientation] of expected) {
      const shape = byId.get(id);
      expect(shape, `缺少入口 ${id}`).toBeTruthy();
      expect(shape?.creation?.action).toBe(action);
      expect(shape?.creation?.orientation).toBe(orientation);
    }
  });

  it("getFlowchartShapeById：普通形状 id 等于 kind（向后兼容）", () => {
    const rect = getFlowchartShapeById("rectangle");
    expect(rect?.kind).toBe("rectangle");
    expect(rect?.creation).toBeUndefined();
    expect(getFlowchartShapeById("swimlane-pool-v")?.creation?.orientation).toBe("vertical");
    expect(getFlowchartShapeById("nonexistent")).toBeUndefined();
  });

  it("circle、connector、or、summation、plus 设置 keepAspectRatio", () => {
    const aspectLocked = new Set(["circle", "connector", "or", "summation", "plus"]);
    for (const shape of FLOWCHART_SHAPE_CATALOG) {
      if (aspectLocked.has(shape.kind)) {
        expect(shape.keepAspectRatio, `${shape.kind} 应设置 keepAspectRatio`).toBe(true);
      }
    }
  });
});

describe("searchFlowchartShapes", () => {
  it("空查询返回全部形状", () => {
    const result = searchFlowchartShapes("");
    expect(result).toHaveLength(FLOWCHART_SHAPE_CATALOG.length);
  });

  it("trim 查询", () => {
    const result = searchFlowchartShapes("  矩形  ");
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((s) => s.kind === "rectangle")).toBe(true);
  });

  it("大小写不敏感", () => {
    const lower = searchFlowchartShapes("rect");
    const upper = searchFlowchartShapes("RECT");
    expect(lower).toEqual(upper);
  });

  it("匹配 label", () => {
    const result = searchFlowchartShapes("处理");
    expect(result.some((s) => s.kind === "process")).toBe(true);
  });

  it("匹配 aliases", () => {
    const result = searchFlowchartShapes("decision");
    expect(result.some((s) => s.kind === "decision")).toBe(true);
  });

  it("匹配 kind", () => {
    const result = searchFlowchartShapes("database");
    expect(result.some((s) => s.kind === "database")).toBe(true);
  });

  it("无匹配返回空数组", () => {
    const result = searchFlowchartShapes("xyzabc123");
    expect(result).toEqual([]);
  });
});

describe("groupShapesByCategory", () => {
  it("按 basic/flowchart/swimlane 分组", () => {
    const groups = groupShapesByCategory(FLOWCHART_SHAPE_CATALOG);
    expect(groups.basic.length).toBeGreaterThan(0);
    expect(groups.flowchart.length).toBeGreaterThan(0);
    expect(groups.swimlane.length).toBeGreaterThan(0);
  });

  it("分组后总数不变", () => {
    const groups = groupShapesByCategory(FLOWCHART_SHAPE_CATALOG);
    const total = groups.basic.length + groups.flowchart.length + groups.swimlane.length;
    expect(total).toBe(FLOWCHART_SHAPE_CATALOG.length);
  });
});

describe("renderFlowchartShape", () => {
  it("每个 catalog kind 都能渲染为有效 SVG", () => {
    for (const shape of FLOWCHART_SHAPE_CATALOG) {
      const node = renderFlowchartShape(shape.kind);
      // text 节点返回 null（无 SVG 形状）
      if (shape.kind === "text") {
        expect(node).toBeNull();
        continue;
      }
      expect(node).toBeTruthy();
    }
  });

  it("默认 stroke/fill 使用主题 token 而非硬编码颜色", () => {
    const shape = FLOWCHART_SHAPE_CATALOG.find((s) => s.kind === "rectangle")!;
    const node = renderFlowchartShape(shape.kind);
    const markup = renderToStaticMarkup(<svg>{node}</svg>);
    // 未自定义时应使用 fill-card stroke-border 类名
    expect(markup).toContain("fill-card");
    expect(markup).toContain("stroke-border");
  });

  it("用户自定义 fill/stroke 优先", () => {
    const shape = FLOWCHART_SHAPE_CATALOG.find((s) => s.kind === "rectangle")!;
    const node = renderFlowchartShape(shape.kind, {
      fill: "#ff0000",
      stroke: "#00ff00",
    });
    const markup = renderToStaticMarkup(<svg>{node}</svg>);
    // React 把 fill/stroke 渲染为内联样式
    expect(markup).toContain("fill:#ff0000");
    expect(markup).toContain("stroke:#00ff00");
    expect(markup).not.toContain("fill-card");
  });

  it("SVG 不包含脚本或外部 URL", () => {
    for (const shape of FLOWCHART_SHAPE_CATALOG) {
      if (shape.kind === "text") continue;
      const node = renderFlowchartShape(shape.kind);
      const markup = renderToStaticMarkup(<svg>{node}</svg>);
      expect(markup).not.toContain("<script");
      expect(markup).not.toContain("http://");
      expect(markup).not.toContain("https://");
      expect(markup).not.toContain("javascript:");
    }
  });

  it("未知 kind 回退为矩形", () => {
    // @ts-expect-error 测试未知 kind
    const node = renderFlowchartShape("unknown-kind");
    const markup = renderToStaticMarkup(<svg>{node}</svg>);
    expect(markup).toContain("<rect");
  });
});

describe("renderFlowchartShapePreview（FC-SWIM-01）", () => {
  it("分隔入口渲染为一条方向线", () => {
    const h = getFlowchartShapeById("swimlane-divider-h")!;
    const hMarkup = renderToStaticMarkup(<svg>{renderFlowchartShapePreview(h)}</svg>);
    expect(hMarkup).toContain("<line");
    // 水平分隔线：y 固定、x 延伸
    expect(hMarkup).toContain('y1="50"');

    const v = getFlowchartShapeById("swimlane-divider-v")!;
    const vMarkup = renderToStaticMarkup(<svg>{renderFlowchartShapePreview(v)}</svg>);
    expect(vMarkup).toContain("<line");
    // 垂直分隔线：x 固定、y 延伸
    expect(vMarkup).toContain('x1="100"');
  });

  it("纵向泳池标题区在顶部，横向泳池标题区在左侧", () => {
    const hPool = getFlowchartShapeById("swimlane-pool-h")!;
    const hMarkup = renderToStaticMarkup(<svg>{renderFlowchartShapePreview(hPool)}</svg>);
    expect(hMarkup).toContain('width="40"');

    const vPool = getFlowchartShapeById("swimlane-pool-v")!;
    const vMarkup = renderToStaticMarkup(<svg>{renderFlowchartShapePreview(vPool)}</svg>);
    expect(vMarkup).toContain('height="25"');
  });

  it("普通形状预览使用显眼颜色确保面板中可见", () => {
    const rect = getFlowchartShapeById("rectangle")!;
    const preview = renderToStaticMarkup(<svg>{renderFlowchartShapePreview(rect)}</svg>);
    // 预览应包含显眼的 fill 和 stroke，不能依赖 fill-card（与面板背景同色）
    expect(preview).toContain("hsl(var(--muted)");
    expect(preview).toContain("hsl(var(--muted-foreground)");
  });
});
