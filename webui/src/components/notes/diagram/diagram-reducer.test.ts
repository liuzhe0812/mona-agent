import { describe, expect, it } from "vitest";

import { computeDiagramDocumentHash } from "./diagram-hash";
import {
  createBlankDiagramDocument,
  createShapeElement,
  paragraphBlock,
  type DiagramConnector,
  type DiagramDocument,
  type DiagramGroupElement,
  type DiagramShapeElement,
} from "./diagram-document";
import {
  applyDiagramCommand,
  canRedo,
  canUndo,
  computeDiagramRemovalCascade,
  createDiagramHistory,
  createDiagramState,
  pushDiagramCommand,
  redoDiagram,
  undoDiagram,
  type DiagramState,
} from "./diagram-reducer";
import { validateDiagramDocument } from "./diagram-validator";

function shape(id: string, x = 0, y = 0, label = id): DiagramShapeElement {
  return createShapeElement(id, "rectangle", label, { x, y });
}

function connector(id: string, source: string, target: string): DiagramConnector {
  return {
    id,
    source: { elementId: source },
    target: { elementId: target },
    route: "orthogonal",
    markerStart: "none",
    markerEnd: "arrow-closed",
    stroke: { color: "#1f2329", width: 1.5, style: "solid" },
    zIndex: 0,
  };
}

/** 基础文档：a → b → c 三个形状 + 两条连接器。 */
function makeState(): DiagramState {
  const doc = createBlankDiagramDocument("flowchart");
  doc.elements = [shape("a", 0, 0), shape("b", 0, 120), shape("c", 0, 240)];
  doc.connectors = [connector("e1", "a", "b"), connector("e2", "b", "c")];
  return createDiagramState(doc);
}

function elementOf(state: DiagramState, id: string) {
  const el = state.document.elements.find((e) => e.id === id);
  if (!el) throw new Error(`element ${id} not found`);
  return el;
}

describe("createDiagramState", () => {
  it("revision 从 0 开始，documentHash 已计算", () => {
    const state = makeState();
    expect(state.revision).toBe(0);
    expect(state.documentHash).toMatch(/^d[0-9a-f]+$/);
  });

  it("深拷贝文档，不影响调用方", () => {
    const doc = createBlankDiagramDocument("flowchart");
    const state = createDiagramState(doc);
    state.document.elements.push(shape("x"));
    expect(doc.elements.some((e) => e.id === "x")).toBe(false);
  });
});

describe("addElements", () => {
  it("新增元素成功：revision+1、hash 变化、结果通过校验", () => {
    const state = makeState();
    const r = applyDiagramCommand(state, { type: "addElements", elements: [shape("d", 0, 360)] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.revision).toBe(1);
    expect(r.state.documentHash).not.toBe(state.documentHash);
    expect(r.state.document.elements.map((e) => e.id)).toContain("d");
    expect(validateDiagramDocument(r.state.document).ok).toBe(true);
    expect(r.summary.addedElementIds).toEqual(["d"]);
  });

  it("id 重复拒绝且原状态不变", () => {
    const state = makeState();
    const r = applyDiagramCommand(state, { type: "addElements", elements: [shape("a")] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("a");
    expect(state.revision).toBe(0);
  });

  it("空 elements 拒绝", () => {
    const r = applyDiagramCommand(makeState(), { type: "addElements", elements: [] });
    expect(r.ok).toBe(false);
  });
});

describe("updateElements", () => {
  it("更新 position/textBlocks 成功", () => {
    const state = makeState();
    const r = applyDiagramCommand(state, {
      type: "updateElements",
      updates: [
        { id: "a", patch: { position: { x: 50, y: 50 } } },
        { id: "b", patch: { textBlocks: [paragraphBlock("tb-1", "新标签")] } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(elementOf(r.state, "a").position).toEqual({ x: 50, y: 50 });
    const b = elementOf(r.state, "b") as DiagramShapeElement;
    expect(b.textBlocks[0].text).toBe("新标签");
    expect(r.summary.updatedElementIds).toEqual(["a", "b"]);
  });

  it("patch 含未声明字段拒绝", () => {
    const r = applyDiagramCommand(makeState(), {
      type: "updateElements",
      updates: [{ id: "a", patch: { rawSvg: "<svg/>" } }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("rawSvg");
  });

  it("patch 不允许修改 id/type/parentId", () => {
    for (const patch of [{ id: "z" }, { type: "text" }, { parentId: "g" }]) {
      const r = applyDiagramCommand(makeState(), {
        type: "updateElements",
        updates: [{ id: "a", patch }],
      });
      expect(r.ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it("元素不存在拒绝", () => {
    const r = applyDiagramCommand(makeState(), {
      type: "updateElements",
      updates: [{ id: "ghost", patch: { opacity: 0.5 } }],
    });
    expect(r.ok).toBe(false);
  });

  it("原子性：第二条 update 非法时第一条也不生效", () => {
    const state = makeState();
    const r = applyDiagramCommand(state, {
      type: "updateElements",
      updates: [
        { id: "a", patch: { position: { x: 1, y: 1 } } },
        { id: "b", patch: { size: { width: -5, height: 10 } } },
      ],
    });
    expect(r.ok).toBe(false);
    expect(elementOf(state, "a").position).toEqual({ x: 0, y: 0 });
  });

  it("空 patch 拒绝", () => {
    const r = applyDiagramCommand(makeState(), {
      type: "updateElements",
      updates: [{ id: "a", patch: {} }],
    });
    expect(r.ok).toBe(false);
  });
});

describe("removeElements", () => {
  it("删除元素并级联删除关联连接器", () => {
    const state = makeState();
    const r = applyDiagramCommand(state, { type: "removeElements", ids: ["b"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.document.elements.map((e) => e.id)).toEqual(["a", "c"]);
    expect(r.state.document.connectors).toEqual([]);
    expect(r.summary.removedElementIds).toEqual(["b"]);
    expect(r.summary.removedConnectorIds.sort()).toEqual(["e1", "e2"]);
  });

  it("删除 group 级联删除子元素", () => {
    const state = makeState();
    const g = applyDiagramCommand(state, {
      type: "groupElements",
      elementIds: ["a", "b"],
      groupId: "g1",
    });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const r = applyDiagramCommand(g.state, { type: "removeElements", ids: ["g1"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.document.elements.map((e) => e.id)).toEqual(["c"]);
    expect(r.summary.removedElementIds.sort()).toEqual(["a", "b", "g1"]);
  });

  it("元素不存在拒绝", () => {
    const r = applyDiagramCommand(makeState(), { type: "removeElements", ids: ["ghost"] });
    expect(r.ok).toBe(false);
  });
});

describe("connector 命令", () => {
  it("addConnectors / updateConnectors / removeConnectors", () => {
    let state = makeState();
    const add = applyDiagramCommand(state, { type: "addConnectors", connectors: [connector("e3", "a", "c")] });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    state = add.state;

    const upd = applyDiagramCommand(state, {
      type: "updateConnectors",
      updates: [{ id: "e3", patch: { route: "bezier", markerEnd: "triangle" } }],
    });
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    const e3 = upd.state.document.connectors.find((c) => c.id === "e3");
    expect(e3?.route).toBe("bezier");
    expect(e3?.markerEnd).toBe("triangle");
    state = upd.state;

    const del = applyDiagramCommand(state, { type: "removeConnectors", ids: ["e3"] });
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.state.document.connectors.map((c) => c.id).sort()).toEqual(["e1", "e2"]);
  });

  it("updateConnectors 未声明字段拒绝", () => {
    const r = applyDiagramCommand(makeState(), {
      type: "updateConnectors",
      updates: [{ id: "e1", patch: { rawStyle: "red" } }],
    });
    expect(r.ok).toBe(false);
  });

  it("addConnectors 端点指向不存在元素时整条命令失败", () => {
    const state = makeState();
    const r = applyDiagramCommand(state, { type: "addConnectors", connectors: [connector("e9", "a", "ghost")] });
    expect(r.ok).toBe(false);
    expect(state.document.connectors.some((c) => c.id === "e9")).toBe(false);
  });
});

describe("groupElements / ungroupElements", () => {
  it("组合：创建 group、设置 parentId、父先子后、包围盒正确", () => {
    const state = makeState();
    const r = applyDiagramCommand(state, { type: "groupElements", elementIds: ["a", "b"], groupId: "g1", title: "分组" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = elementOf(r.state, "g1") as DiagramGroupElement;
    expect(g.type).toBe("group");
    expect(g.title).toBe("分组");
    // a(0,0,160x60) 与 b(0,120,160x60)：bbox (0,0)-(160,180)，padding 16
    expect(g.position).toEqual({ x: -16, y: -16 });
    expect(g.size).toEqual({ width: 192, height: 212 });
    expect(elementOf(r.state, "a").parentId).toBe("g1");
    expect(elementOf(r.state, "b").parentId).toBe("g1");
    // group 必须排在子元素之前
    const ids = r.state.document.elements.map((e) => e.id);
    expect(ids.indexOf("g1")).toBeLessThan(ids.indexOf("a"));
    expect(validateDiagramDocument(r.state.document).ok).toBe(true);
  });

  it("未指定 groupId 时自动生成", () => {
    const r = applyDiagramCommand(makeState(), { type: "groupElements", elementIds: ["a", "b"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.addedElementIds[0]).toMatch(/^group-/);
  });

  it("同时选中父子元素拒绝", () => {
    let state = makeState();
    const g = applyDiagramCommand(state, { type: "groupElements", elementIds: ["a", "b"], groupId: "g1" });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    state = g.state;
    const r = applyDiagramCommand(state, { type: "groupElements", elementIds: ["g1", "c"] });
    // g1 不是 c 的祖先，这个应该成功；再测真正的父子同选
    expect(r.ok).toBe(true);
    const r2 = applyDiagramCommand(state, { type: "groupElements", elementIds: ["g1", "a"] });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.message).toContain("父子");
  });

  it("ungroup 恢复子元素到根级并删除 group", () => {
    let state = makeState();
    const g = applyDiagramCommand(state, { type: "groupElements", elementIds: ["a", "b"], groupId: "g1" });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    state = g.state;
    const r = applyDiagramCommand(state, { type: "ungroupElements", groupIds: ["g1"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.document.elements.some((e) => e.id === "g1")).toBe(false);
    expect(elementOf(r.state, "a").parentId).toBeUndefined();
    expect(elementOf(r.state, "b").parentId).toBeUndefined();
    expect(validateDiagramDocument(r.state.document).ok).toBe(true);
  });

  it("ungroup 非 group 元素拒绝", () => {
    const r = applyDiagramCommand(makeState(), { type: "ungroupElements", groupIds: ["a"] });
    expect(r.ok).toBe(false);
  });
});

describe("reparentElements", () => {
  function stateWithGroup(): DiagramState {
    let state = makeState();
    const g = applyDiagramCommand(state, { type: "groupElements", elementIds: ["a", "b"], groupId: "g1" });
    if (!g.ok) throw new Error("setup failed");
    state = g.state;
    return state;
  }

  it("移入 group 与移回根级", () => {
    let state = stateWithGroup();
    const into = applyDiagramCommand(state, { type: "reparentElements", elementIds: ["c"], parentId: "g1" });
    expect(into.ok).toBe(true);
    if (!into.ok) return;
    expect(elementOf(into.state, "c").parentId).toBe("g1");
    const ids = into.state.document.elements.map((e) => e.id);
    expect(ids.indexOf("g1")).toBeLessThan(ids.indexOf("c"));

    const out = applyDiagramCommand(into.state, { type: "reparentElements", elementIds: ["c"] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(elementOf(out.state, "c").parentId).toBeUndefined();
  });

  it("目标必须是 group/container", () => {
    const r = applyDiagramCommand(makeState(), { type: "reparentElements", elementIds: ["c"], parentId: "a" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("group/container");
  });

  it("不能移动进自身或自身的子元素", () => {
    const state = stateWithGroup();
    const r1 = applyDiagramCommand(state, { type: "reparentElements", elementIds: ["g1"], parentId: "g1" });
    expect(r1.ok).toBe(false);
    const r2 = applyDiagramCommand(state, { type: "reparentElements", elementIds: ["g1"], parentId: "a" });
    expect(r2.ok).toBe(false);
  });
});

describe("reorderElements", () => {
  function zOrder(state: DiagramState): string[] {
    return [...state.document.elements]
      .sort((x, y) => x.zIndex - y.zIndex)
      .map((e) => e.id);
  }

  it("front / back", () => {
    let state = makeState(); // a,b,c zIndex 0,0,0 → 稳定排序按原序
    const front = applyDiagramCommand(state, { type: "reorderElements", ids: ["a"], action: "front" });
    expect(front.ok).toBe(true);
    if (!front.ok) return;
    expect(zOrder(front.state)).toEqual(["b", "c", "a"]);

    const back = applyDiagramCommand(front.state, { type: "reorderElements", ids: ["a"], action: "back" });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(zOrder(back.state)).toEqual(["a", "b", "c"]);
  });

  it("forward / backward 每次移动一层", () => {
    let state = makeState();
    const fwd = applyDiagramCommand(state, { type: "reorderElements", ids: ["a"], action: "forward" });
    expect(fwd.ok).toBe(true);
    if (!fwd.ok) return;
    expect(zOrder(fwd.state)).toEqual(["b", "a", "c"]);

    const bwd = applyDiagramCommand(fwd.state, { type: "reorderElements", ids: ["a"], action: "backward" });
    expect(bwd.ok).toBe(true);
    if (!bwd.ok) return;
    expect(zOrder(bwd.state)).toEqual(["a", "b", "c"]);
  });

  it("多选 front 保持相对顺序", () => {
    const state = makeState();
    const r = applyDiagramCommand(state, { type: "reorderElements", ids: ["a", "b"], action: "front" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(zOrder(r.state)).toEqual(["c", "a", "b"]);
  });

  it("元素不存在拒绝", () => {
    const r = applyDiagramCommand(makeState(), { type: "reorderElements", ids: ["ghost"], action: "front" });
    expect(r.ok).toBe(false);
  });
});

describe("setCanvas / applyLayout / attachAssets / replaceDocument", () => {
  it("setCanvas 浅合并并支持嵌套 grid", () => {
    const state = makeState();
    const r = applyDiagramCommand(state, {
      type: "setCanvas",
      patch: { padding: 24, grid: { visible: false, snap: true, size: 16 } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.document.canvas.padding).toBe(24);
    expect(r.state.document.canvas.grid).toEqual({ visible: false, snap: true, size: 16 });
    // mode 未被 patch 时保持原值
    expect(r.state.document.canvas.mode).toBe(state.document.canvas.mode);
  });

  it("setCanvas 未声明字段拒绝", () => {
    const r = applyDiagramCommand(makeState(), { type: "setCanvas", patch: { theme: "dark" } as never });
    expect(r.ok).toBe(false);
  });

  it("setCanvas 非法值由校验器拒绝", () => {
    const r = applyDiagramCommand(makeState(), {
      type: "setCanvas",
      patch: { grid: { visible: true, snap: true, size: -1 } },
    });
    expect(r.ok).toBe(false);
  });

  it("applyLayout 批量写入坐标与尺寸", () => {
    const state = makeState();
    const r = applyDiagramCommand(state, {
      type: "applyLayout",
      positions: [
        { id: "a", position: { x: 10, y: 20 } },
        { id: "b", position: { x: 30, y: 40 }, size: { width: 200, height: 80 } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(elementOf(r.state, "a").position).toEqual({ x: 10, y: 20 });
    expect(elementOf(r.state, "b").size).toEqual({ width: 200, height: 80 });
  });

  it("attachAssets 登记资产；重复 id 拒绝", () => {
    let state = makeState();
    const add = applyDiagramCommand(state, {
      type: "attachAssets",
      assets: [{ id: "asset-1", path: "assets/a.png", mime: "image/png" }],
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    state = add.state;
    expect(state.document.assets?.[0].id).toBe("asset-1");
    const dup = applyDiagramCommand(state, {
      type: "attachAssets",
      assets: [{ id: "asset-1", path: "assets/b.png", mime: "image/png" }],
    });
    expect(dup.ok).toBe(false);
  });

  it("replaceDocument 整体替换；非法文档拒绝且原子", () => {
    const state = makeState();
    const next = createBlankDiagramDocument("erd");
    const r = applyDiagramCommand(state, { type: "replaceDocument", document: next });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.document.diagramKind).toBe("erd");
    expect(r.state.revision).toBe(1);

    const bad = JSON.parse(JSON.stringify(next)) as DiagramDocument;
    bad.elements = [];
    (bad as unknown as Record<string, unknown>).diagramKind = "not-a-kind";
    const r2 = applyDiagramCommand(r.state, { type: "replaceDocument", document: bad });
    expect(r2.ok).toBe(false);
    expect(r.state.document.diagramKind).toBe("erd");
  });
});

describe("computeDiagramRemovalCascade", () => {
  it("计算后代与关联连接器", () => {
    const doc = createBlankDiagramDocument("flowchart");
    doc.elements = [
      {
        id: "g",
        type: "group",
        position: { x: 0, y: 0 },
        size: { width: 300, height: 300 },
        rotation: 0,
        zIndex: 0,
      },
      shape("child", 10, 10),
      shape("outside", 500, 500),
    ];
    doc.elements[1].parentId = "g";
    doc.connectors = [connector("e1", "child", "outside")];
    const cascade = computeDiagramRemovalCascade(doc, ["g"]);
    expect([...cascade.elementIds].sort()).toEqual(["child", "g"]);
    expect([...cascade.connectorIds]).toEqual(["e1"]);
  });
});

describe("revision 与哈希", () => {
  it("每条成功命令 revision+1；失败命令不产生新状态", () => {
    let state = makeState();
    for (let i = 1; i <= 3; i++) {
      const r = applyDiagramCommand(state, { type: "addElements", elements: [shape(`n${i}`, i * 10, 0)] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.state.revision).toBe(i);
      state = r.state;
    }
    const before = state;
    const fail = applyDiagramCommand(state, { type: "removeElements", ids: ["ghost"] });
    expect(fail.ok).toBe(false);
    expect(state).toBe(before);
    expect(state.revision).toBe(3);
    expect(state.documentHash).toBe(computeDiagramDocumentHash(state.document));
  });
});

describe("历史：undo / redo", () => {
  it("push → undo → redo 往返", () => {
    let history = createDiagramHistory(makeState().document);
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);

    const push1 = pushDiagramCommand(history, { type: "addElements", elements: [shape("x", 0, 400)] });
    expect(push1.ok).toBe(true);
    if (!push1.ok) return;
    history = push1.history;
    expect(canUndo(history)).toBe(true);
    expect(history.present.document.elements.some((e) => e.id === "x")).toBe(true);

    const undone = undoDiagram(history);
    expect(undone).not.toBeNull();
    if (!undone) return;
    history = undone;
    expect(history.present.document.elements.some((e) => e.id === "x")).toBe(false);
    expect(canRedo(history)).toBe(true);

    const redone = redoDiagram(history);
    expect(redone).not.toBeNull();
    if (!redone) return;
    history = redone;
    expect(history.present.document.elements.some((e) => e.id === "x")).toBe(true);
  });

  it("新命令清空 future", () => {
    let history = createDiagramHistory(makeState().document);
    const p1 = pushDiagramCommand(history, { type: "addElements", elements: [shape("x")] });
    if (!p1.ok) throw new Error("push failed");
    history = p1.history;
    const u = undoDiagram(history);
    if (!u) throw new Error("undo failed");
    history = u;
    const p2 = pushDiagramCommand(history, { type: "addElements", elements: [shape("y")] });
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    history = p2.history;
    expect(canRedo(history)).toBe(false);
  });

  it("失败命令不进入历史", () => {
    let history = createDiagramHistory(makeState().document);
    const r = pushDiagramCommand(history, { type: "removeElements", ids: ["ghost"] });
    expect(r.ok).toBe(false);
    expect(canUndo(history)).toBe(false);
  });

  it("undo 空历史返回 null", () => {
    const history = createDiagramHistory(makeState().document);
    expect(undoDiagram(history)).toBeNull();
    expect(redoDiagram(history)).toBeNull();
  });
});
