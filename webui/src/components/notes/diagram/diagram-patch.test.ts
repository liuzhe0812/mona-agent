import { describe, expect, it } from "vitest";

import {
  createBlankDiagramDocument,
  createShapeElement,
  DIAGRAM_CAPABILITY_VERSION,
  DIAGRAM_PATCH_MAX_OPS,
  DIAGRAM_PATCH_PROTOCOL_VERSION,
  paragraphBlock,
  type DiagramConnector,
  type DiagramShapeElement,
} from "./diagram-document";
import {
  applyDiagramPatch,
  parseDiagramPatch,
  pushDiagramPatch,
  type DiagramPatch,
} from "./diagram-patch";
import {
  canUndo,
  createDiagramHistory,
  createDiagramState,
  undoDiagram,
  type DiagramState,
} from "./diagram-reducer";

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

function makeState(): DiagramState {
  const doc = createBlankDiagramDocument("flowchart");
  doc.elements = [shape("a", 0, 0, "甲"), shape("b", 0, 120, "乙"), shape("c", 0, 240, "丙")];
  doc.connectors = [connector("e1", "a", "b"), connector("e2", "b", "c")];
  return createDiagramState(doc);
}

function fence(payload: unknown): string {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `\`\`\`mona-diagram-patch\n${body}\n\`\`\``;
}

function validPatch(state: DiagramState, ops: unknown[]): string {
  return fence({
    protocolVersion: DIAGRAM_PATCH_PROTOCOL_VERSION,
    capabilityVersion: DIAGRAM_CAPABILITY_VERSION,
    baseRevision: state.revision,
    baseDocumentHash: state.documentHash,
    ops,
  });
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

describe("parseDiagramPatch — 围栏提取", () => {
  it("提取最后一个 mona-diagram-patch 围栏", () => {
    const state = makeState();
    const text = `前文\n${validPatch(state, [])}\n中间\n${fence({
      protocolVersion: DIAGRAM_PATCH_PROTOCOL_VERSION,
      capabilityVersion: 1,
      baseRevision: 99,
      baseDocumentHash: "d0123abc",
      ops: [],
    })}\n后文`;
    const r = parseDiagramPatch(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.baseRevision).toBe(99);
  });

  it("找不到围栏报错", () => {
    const r = parseDiagramPatch("没有围栏");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("mona-diagram-patch");
  });

  it("JSON 损坏报错", () => {
    const r = parseDiagramPatch(fence("{not json}"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("格式错误");
  });

  it("payload 超限报错", () => {
    const big = "x".repeat(200 * 1024);
    const r = parseDiagramPatch(fence(`{"pad":"${big}"}`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("过大");
  });
});

describe("parseDiagramPatch — 协议头校验", () => {
  const base = {
    protocolVersion: DIAGRAM_PATCH_PROTOCOL_VERSION,
    capabilityVersion: DIAGRAM_CAPABILITY_VERSION,
    baseRevision: 0,
    baseDocumentHash: "d0123456789abc",
    ops: [],
  };

  it("合法头解析成功", () => {
    const r = parseDiagramPatch(fence(base));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch.protocolVersion).toBe(DIAGRAM_PATCH_PROTOCOL_VERSION);
      expect(r.patch.ops).toEqual([]);
    }
  });

  it("protocolVersion 不符拒绝", () => {
    const r = parseDiagramPatch(fence({ ...base, protocolVersion: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("protocolVersion");
  });

  it("capabilityVersion 超出客户端支持拒绝", () => {
    const r = parseDiagramPatch(fence({ ...base, capabilityVersion: DIAGRAM_CAPABILITY_VERSION + 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("capabilityVersion");
  });

  it("baseRevision 缺失或非法拒绝", () => {
    for (const bad of [{}, { baseRevision: -1 }, { baseRevision: "0" }]) {
      const r = parseDiagramPatch(fence({ ...base, ...bad, baseRevision: (bad as { baseRevision?: unknown }).baseRevision }));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("baseDocumentHash 缺失或非 d 前缀拒绝", () => {
    for (const bad of [undefined, "", "s0123456789abc", 42]) {
      const p: Record<string, unknown> = { ...base };
      if (bad === undefined) delete p.baseDocumentHash;
      else p.baseDocumentHash = bad;
      const r = parseDiagramPatch(fence(p));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("顶层未知字段拒绝", () => {
    const r = parseDiagramPatch(fence({ ...base, rawSvg: "<svg/>" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("rawSvg");
  });

  it("ops 超过上限拒绝", () => {
    const ops = Array.from({ length: DIAGRAM_PATCH_MAX_OPS + 1 }, () => ({ op: "removeConnectors", ids: [] }));
    const r = parseDiagramPatch(fence({ ...base, ops }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("上限");
  });
});

describe("parseDiagramPatch — op 形状校验", () => {
  const state = makeState();
  const parse = (ops: unknown[]) => parseDiagramPatch(validPatch(state, ops));

  it("未知 op 拒绝", () => {
    const r = parse([{ op: "hackDocument" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("hackDocument");
  });

  it("op 含未知字段拒绝", () => {
    const r = parse([{ op: "removeElements", ids: ["a"], extra: true }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("extra");
  });

  it("op 缺 op 字段拒绝", () => {
    const r = parse([{ ids: ["a"] }]);
    expect(r.ok).toBe(false);
  });

  it("replaceDocument 必须是唯一 op", () => {
    const doc = createBlankDiagramDocument("erd");
    const r = parse([
      { op: "replaceDocument", document: doc },
      { op: "removeElements", ids: ["a"] },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("唯一");
  });

  it("replaceDocument 缺 document 拒绝", () => {
    const r = parse([{ op: "replaceDocument" }]);
    expect(r.ok).toBe(false);
  });

  it("addElements 缺 elements 拒绝", () => {
    const r = parse([{ op: "addElements" }]);
    expect(r.ok).toBe(false);
  });

  it("updateElements 的 updates 条目缺 id/patch 拒绝", () => {
    expect(parse([{ op: "updateElements", updates: [{ patch: {} }] }]).ok).toBe(false);
    expect(parse([{ op: "updateElements", updates: [{ id: "a" }] }]).ok).toBe(false);
  });

  it("reorderElements action 非法拒绝", () => {
    const r = parse([{ op: "reorderElements", ids: ["a"], action: "middle" }]);
    expect(r.ok).toBe(false);
  });

  it("全部 14 种 op 名称均可解析", () => {
    const doc = createBlankDiagramDocument("erd");
    const r = parse([
      { op: "addElements", elements: [] },
      { op: "updateElements", updates: [] },
      { op: "removeElements", ids: [] },
      { op: "addConnectors", connectors: [] },
      { op: "updateConnectors", updates: [] },
      { op: "removeConnectors", ids: [] },
      { op: "groupElements", elementIds: [] },
      { op: "ungroupElements", groupIds: [] },
      { op: "reparentElements", elementIds: [] },
      { op: "reorderElements", ids: [], action: "front" },
      { op: "setCanvas", patch: {} },
      { op: "applyLayout", positions: [] },
      { op: "attachAssets", assets: [] },
    ]);
    expect(r.ok).toBe(true);
    const r2 = parse([{ op: "replaceDocument", document: doc }]);
    expect(r2.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stale 校验与应用
// ---------------------------------------------------------------------------

describe("applyDiagramPatch — stale 检测", () => {
  it("baseRevision 不匹配拒绝（stale）", () => {
    const state = makeState();
    const patch: DiagramPatch = {
      protocolVersion: DIAGRAM_PATCH_PROTOCOL_VERSION,
      capabilityVersion: 1,
      baseRevision: state.revision + 1,
      baseDocumentHash: state.documentHash,
      ops: [],
    };
    const r = applyDiagramPatch(state, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("已被修改");
  });

  it("baseDocumentHash 不匹配拒绝（stale）", () => {
    const state = makeState();
    const patch: DiagramPatch = {
      protocolVersion: DIAGRAM_PATCH_PROTOCOL_VERSION,
      capabilityVersion: 1,
      baseRevision: state.revision,
      baseDocumentHash: "ddeadbeef",
      ops: [],
    };
    const r = applyDiagramPatch(state, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("已被修改");
  });

  it("文档任何变化都会使旧 patch 过期", () => {
    const state = makeState();
    const text = validPatch(state, [{ op: "removeElements", ids: ["c"] }]);
    const parsed = parseDiagramPatch(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 用户在 AI 处理期间移动了节点（只改视觉）：语义未变但完整文档哈希已变
    const changedDoc = {
      ...state.document,
      elements: state.document.elements.map((e) =>
        e.id === "a" ? { ...e, position: { x: 999, y: 999 } } : e,
      ),
    };
    const staleState = createDiagramState(changedDoc);
    const r = applyDiagramPatch(staleState, parsed.patch);
    expect(r.ok).toBe(false);
  });

  it("空 ops 返回原状态（revision 不变）", () => {
    const state = makeState();
    const parsed = parseDiagramPatch(validPatch(state, []));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = applyDiagramPatch(state, parsed.patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state).toBe(state);
    expect(r.state.revision).toBe(0);
  });
});

describe("applyDiagramPatch — 执行", () => {
  it("addElements + addConnectors 顺序执行成功", () => {
    const state = makeState();
    const parsed = parseDiagramPatch(
      validPatch(state, [
        { op: "addElements", elements: [shape("d", 0, 360, "丁")] },
        { op: "addConnectors", connectors: [connector("e3", "c", "d")] },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = applyDiagramPatch(state, parsed.patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.document.elements.some((e) => e.id === "d")).toBe(true);
    expect(r.state.document.connectors.some((c) => c.id === "e3")).toBe(true);
    expect(r.state.revision).toBe(2);
    expect(r.summary.addedElementIds).toEqual(["d"]);
    expect(r.summary.addedConnectorIds).toEqual(["e3"]);
  });

  it("expected 匹配成功，不匹配拒绝", () => {
    const state = makeState();
    const okParse = parseDiagramPatch(
      validPatch(state, [
        {
          op: "updateElements",
          updates: [{ id: "a", expected: { position: { x: 0, y: 0 } }, patch: { position: { x: 7, y: 7 } } }],
        },
      ]),
    );
    expect(okParse.ok).toBe(true);
    if (!okParse.ok) return;
    const applied = applyDiagramPatch(state, okParse.patch);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      const a = applied.state.document.elements.find((e) => e.id === "a")!;
      expect(a.position).toEqual({ x: 7, y: 7 });
    }

    const badParse = parseDiagramPatch(
      validPatch(state, [
        {
          op: "updateElements",
          updates: [{ id: "a", expected: { position: { x: 123, y: 0 } }, patch: { position: { x: 7, y: 7 } } }],
        },
      ]),
    );
    expect(badParse.ok).toBe(true);
    if (!badParse.ok) return;
    const rejected = applyDiagramPatch(state, badParse.patch);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).toContain("expected");
  });

  it("原子性：第二个 op 失败时第一个 op 不生效，原状态不变", () => {
    const state = makeState();
    const parsed = parseDiagramPatch(
      validPatch(state, [
        { op: "addElements", elements: [shape("d", 0, 360)] },
        { op: "removeElements", ids: ["ghost"] },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = applyDiagramPatch(state, parsed.patch);
    expect(r.ok).toBe(false);
    expect(state.document.elements.some((e) => e.id === "d")).toBe(false);
    expect(state.revision).toBe(0);
  });

  it("patch 写入未声明字段被拒绝", () => {
    const state = makeState();
    const parsed = parseDiagramPatch(
      validPatch(state, [
        { op: "updateElements", updates: [{ id: "a", patch: { rawSvg: "<svg/>" } }] },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = applyDiagramPatch(state, parsed.patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("rawSvg");
  });

  it("replaceDocument 整体替换成功", () => {
    const state = makeState();
    const next = createBlankDiagramDocument("erd");
    const parsed = parseDiagramPatch(validPatch(state, [{ op: "replaceDocument", document: next }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = applyDiagramPatch(state, parsed.patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.document.diagramKind).toBe("erd");
    expect(r.summary.replacedDocument).toBe(true);
  });

  it("textBlocks 更新后语义内容生效", () => {
    const state = makeState();
    const parsed = parseDiagramPatch(
      validPatch(state, [
        {
          op: "updateElements",
          updates: [{ id: "a", patch: { textBlocks: [paragraphBlock("tb-1", "新甲")] } }],
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = applyDiagramPatch(state, parsed.patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.state.document.elements.find((e) => e.id === "a") as DiagramShapeElement;
    expect(a.textBlocks[0].text).toBe("新甲");
  });
});

describe("pushDiagramPatch — 历史集成", () => {
  it("整个 patch 形成一个撤销单元", () => {
    const state = makeState();
    let history = createDiagramHistory(state.document);
    const parsed = parseDiagramPatch(
      validPatch(history.present, [
        { op: "addElements", elements: [shape("x", 0, 400)] },
        { op: "addElements", elements: [shape("y", 0, 500)] },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = pushDiagramPatch(history, parsed.patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    history = r.history;
    expect(history.present.document.elements.some((e) => e.id === "x")).toBe(true);
    expect(history.present.document.elements.some((e) => e.id === "y")).toBe(true);
    // 一次 undo 回到 patch 前
    const undone = undoDiagram(history);
    expect(undone).not.toBeNull();
    if (!undone) return;
    expect(undone.present.document.elements.some((e) => e.id === "x")).toBe(false);
    expect(undone.present.document.elements.some((e) => e.id === "y")).toBe(false);
  });

  it("stale patch 不进入历史", () => {
    let history = createDiagramHistory(makeState().document);
    const patch: DiagramPatch = {
      protocolVersion: DIAGRAM_PATCH_PROTOCOL_VERSION,
      capabilityVersion: 1,
      baseRevision: 99,
      baseDocumentHash: "ddeadbeef",
      ops: [],
    };
    const r = pushDiagramPatch(history, patch);
    expect(r.ok).toBe(false);
    expect(canUndo(history)).toBe(false);
  });
});
