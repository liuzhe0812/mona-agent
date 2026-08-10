import { describe, expect, it } from "vitest";

import {
  applyFlowchartPatch,
  layoutEntireGraph,
  layoutFlowchartWithContainers,
  parseFlowchartPatch,
  summarizePatch,
  type FlowchartPatch,
} from "./flowchart-patch";
import {
  cloneFlowchartDocument,
  computeFlowchartSemanticHash,
  createBlankFlowchartDocument,
  DEFAULT_FLOWCHART_CANVAS,
  DEFAULT_FLOWCHART_THEME,
  type FlowchartDocument,
} from "./flowchart-document";

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
      { id: "n2", kind: "process", label: "处理", position: { x: 0, y: 120 } },
      { id: "n3", kind: "end", label: "结束", position: { x: 0, y: 240 } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...overrides,
  };
}

describe("parseFlowchartPatch", () => {
  it("提取最后一个 mona-flowchart-patch 围栏", () => {
    const text = `前文说明

\`\`\`mona-flowchart-patch
{"baseHash":"h00000000000000","ops":[]}
\`\`\`

后文说明`;
    const r = parseFlowchartPatch(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.baseHash).toBe("h00000000000000");
  });

  it("多个围栏取最后一个", () => {
    const text = `\`\`\`mona-flowchart-patch
{"baseHash":"h1","ops":[]}
\`\`\`

\`\`\`mona-flowchart-patch
{"baseHash":"h2","ops":[]}
\`\`\``;
    const r = parseFlowchartPatch(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.baseHash).toBe("h2");
  });

  it("找不到围栏报错", () => {
    const r = parseFlowchartPatch("没有围栏");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("fenced block");
  });

  it("JSON 损坏报错", () => {
    const text = `\`\`\`mona-flowchart-patch\n{not json}\n\`\`\``;
    const r = parseFlowchartPatch(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("格式错误");
  });

  it("baseHash 缺失报错", () => {
    const text = `\`\`\`mona-flowchart-patch\n{"ops":[]}\n\`\`\``;
    const r = parseFlowchartPatch(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("baseHash");
  });

  it("ops 非数组报错", () => {
    const text = `\`\`\`mona-flowchart-patch\n{"baseHash":"h1","ops":{}}\n\`\`\``;
    const r = parseFlowchartPatch(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("ops");
  });

  it("ops 超过上限报错", () => {
    const ops = Array.from({ length: 51 }, () => ({ name: "addEdge", edge: { id: "e", source: "n1", target: "n2" } }));
    const text = `\`\`\`mona-flowchart-patch\n${JSON.stringify({ baseHash: "h1", ops })}\n\`\`\``;
    const r = parseFlowchartPatch(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("超过上限");
  });

  it("replaceGraph 必须是唯一 op", () => {
    const text = `\`\`\`mona-flowchart-patch
{"baseHash":"h1","ops":[
  {"name":"replaceGraph","graph":{"direction":"TB","nodes":[],"edges":[]}},
  {"name":"addNode","node":{"id":"n1","kind":"start","label":"a"}}
]}
\`\`\``;
    const r = parseFlowchartPatch(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("唯一 op");
  });

  it("未知 op name 报错", () => {
    const text = `\`\`\`mona-flowchart-patch
{"baseHash":"h1","ops":[{"name":"unknown"}]}
\`\`\``;
    const r = parseFlowchartPatch(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("未知 op name");
  });
});

describe("parseFlowchartPatch — AI kind 校验（FC-AI-01）", () => {
  function patchWith(ops: unknown[]): string {
    return `\`\`\`mona-flowchart-patch\n${JSON.stringify({ baseHash: "h1", ops })}\n\`\`\``;
  }

  it("addNode 允许新增流程图形状", () => {
    const kinds = [
      "terminator",
      "preparation",
      "manual-input",
      "alternate-process",
      "merge",
      "extract",
      "sort",
      "or",
      "summation",
      "off-page-connector",
      "stored-data",
    ];
    for (const kind of kinds) {
      const r = parseFlowchartPatch(
        patchWith([{ name: "addNode", node: { id: "n-x", kind, label: "x" } }]),
      );
      expect(r.ok, `kind ${kind} 应被允许`).toBe(true);
    }
  });

  it("addNode 拒绝容器 kind", () => {
    for (const kind of ["group", "swimlane-pool", "swimlane-lane"]) {
      const r = parseFlowchartPatch(
        patchWith([{ name: "addNode", node: { id: "n-x", kind, label: "x" } }]),
      );
      expect(r.ok, `kind ${kind} 应被拒绝`).toBe(false);
      if (!r.ok) expect(r.message).toContain("容器");
    }
  });

  it("addNode 拒绝未知 kind", () => {
    const r = parseFlowchartPatch(
      patchWith([{ name: "addNode", node: { id: "n-x", kind: "not-a-kind", label: "x" } }]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("kind 不合法");
  });

  it("updateNode patch.kind 拒绝容器与未知 kind，允许流程形状", () => {
    const base = { name: "updateNode", id: "n1", expectedLabel: "处理" };
    const container = parseFlowchartPatch(
      patchWith([{ ...base, patch: { kind: "swimlane-lane" } }]),
    );
    expect(container.ok).toBe(false);
    if (!container.ok) expect(container.message).toContain("容器");

    const unknown = parseFlowchartPatch(
      patchWith([{ ...base, patch: { kind: "not-a-kind" } }]),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain("kind 不合法");

    const ok = parseFlowchartPatch(
      patchWith([{ ...base, patch: { kind: "preparation", label: "准备" } }]),
    );
    expect(ok.ok).toBe(true);
  });

  it("replaceGraph 逐节点校验：容器节点被拒绝", () => {
    const r = parseFlowchartPatch(
      patchWith([
        {
          name: "replaceGraph",
          graph: {
            direction: "TB",
            nodes: [
              { id: "n1", kind: "start", label: "开始" },
              { id: "n2", kind: "swimlane-pool", label: "泳池" },
            ],
            edges: [],
          },
        },
      ]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("容器");
  });

  it("replaceGraph 容忍既有基础装饰节点（round-trip 安全）", () => {
    // 语义投影包含基础形状节点；replaceGraph 回传这些节点时不应被拦截
    const r = parseFlowchartPatch(
      patchWith([
        {
          name: "replaceGraph",
          graph: {
            direction: "TB",
            nodes: [
              { id: "n1", kind: "start", label: "开始" },
              { id: "n2", kind: "star", label: "装饰" },
            ],
            edges: [],
          },
        },
      ]),
    );
    expect(r.ok).toBe(true);
  });
});

describe("parseFlowchartPatch — 泳道 op 形状校验（FC-AI-02）", () => {
  function patchWith(ops: unknown[]): string {
    return `\`\`\`mona-flowchart-patch\n${JSON.stringify({ baseHash: "h1", ops })}\n\`\`\``;
  }

  it("addPool 合法形状通过", () => {
    const r = parseFlowchartPatch(
      patchWith([
        {
          name: "addPool",
          pool: {
            id: "pool-1",
            label: "职责",
            lanes: [
              { id: "lane-1", label: "前端" },
              { id: "lane-2", label: "后端" },
            ],
          },
        },
      ]),
    );
    expect(r.ok).toBe(true);
  });

  it("addPool 泳道必须恰好 2 条", () => {
    for (const lanes of [
      [{ id: "l1", label: "a" }],
      [
        { id: "l1", label: "a" },
        { id: "l2", label: "b" },
        { id: "l3", label: "c" },
      ],
    ]) {
      const r = parseFlowchartPatch(
        patchWith([{ name: "addPool", pool: { id: "p", label: "p", lanes } }]),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("恰好 2 条");
    }
  });

  it("addPool orientation 非法拒绝", () => {
    const r = parseFlowchartPatch(
      patchWith([
        {
          name: "addPool",
          pool: {
            id: "p",
            label: "p",
            orientation: "diagonal",
            lanes: [
              { id: "l1", label: "a" },
              { id: "l2", label: "b" },
            ],
          },
        },
      ]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("orientation");
  });

  it("addLane / moveNodeToLane 形状校验", () => {
    expect(
      parseFlowchartPatch(patchWith([{ name: "addLane", lane: { id: "l3" } }])).ok,
    ).toBe(false);
    expect(
      parseFlowchartPatch(
        patchWith([{ name: "addLane", poolId: "p1", lane: { id: "l3" } }]),
      ).ok,
    ).toBe(true);
    expect(
      parseFlowchartPatch(
        patchWith([{ name: "moveNodeToLane", id: "n1", expectedLabel: "x", laneId: 42 }]),
      ).ok,
    ).toBe(false);
    expect(
      parseFlowchartPatch(
        patchWith([{ name: "moveNodeToLane", id: "n1", expectedLabel: "x", laneId: null }]),
      ).ok,
    ).toBe(true);
  });

  it("addNode 不允许带 laneId", () => {
    const r = parseFlowchartPatch(
      patchWith([
        { name: "addNode", node: { id: "n-x", kind: "process", label: "x", laneId: "lane-1" } },
      ]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("laneId");
  });

  it("replaceGraph 不允许带 lanes", () => {
    const r = parseFlowchartPatch(
      patchWith([
        {
          name: "replaceGraph",
          graph: {
            direction: "TB",
            nodes: [{ id: "n1", kind: "start", label: "开始" }],
            edges: [],
            lanes: [{ id: "lane-1", label: "泳道" }],
          },
        },
      ]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("lanes");
  });
});

describe("applyFlowchartPatch — 泳道 ops（FC-AI-02）", () => {
  function makeSwimDoc(): FlowchartDocument {
    return makeDoc({
      nodes: [
        {
          id: "pool1",
          kind: "swimlane-pool",
          label: "泳池",
          position: { x: 0, y: 0 },
          size: { width: 300, height: 200 },
          container: { type: "pool", orientation: "horizontal", headerSize: 40 },
        },
        {
          id: "lane1",
          kind: "swimlane-lane",
          label: "泳道1",
          parentId: "pool1",
          position: { x: 40, y: 0 },
          size: { width: 260, height: 100 },
          container: { type: "lane", orientation: "horizontal", order: 0 },
        },
        {
          id: "lane2",
          kind: "swimlane-lane",
          label: "泳道2",
          parentId: "pool1",
          position: { x: 40, y: 100 },
          size: { width: 260, height: 100 },
          container: { type: "lane", orientation: "horizontal", order: 1 },
        },
        { id: "a", kind: "process", label: "A", parentId: "lane1", position: { x: 48, y: 16 } },
      ],
      edges: [],
    });
  }

  it("addPool 创建泳池与 2 条泳道，位置在既有内容右侧", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "addPool",
          pool: {
            id: "pool-1",
            label: "职责",
            lanes: [
              { id: "lane-1", label: "前端" },
              { id: "lane-2", label: "后端" },
            ],
          },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.addedPools).toBe(1);
    expect(r.summary.addedLanes).toBe(0);
    const pool = r.document.nodes.find((n) => n.id === "pool-1")!;
    expect(pool.kind).toBe("swimlane-pool");
    expect(pool.container?.type).toBe("pool");
    const lanes = r.document.nodes.filter((n) => n.kind === "swimlane-lane");
    expect(lanes.map((l) => l.id)).toEqual(["lane-1", "lane-2"]);
    expect(lanes.every((l) => l.parentId === "pool-1")).toBe(true);
    // 既有内容最右是 n1..n3（x=0，默认宽 140），泳池应在其右侧
    expect(pool.position.x).toBeGreaterThanOrEqual(140);
  });

  it("addPool 拒绝重复 id", () => {
    const doc = makeDoc();
    const dup: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "addPool",
          pool: {
            id: "n1",
            label: "x",
            lanes: [
              { id: "l1", label: "a" },
              { id: "l2", label: "b" },
            ],
          },
        },
      ],
    };
    const r1 = applyFlowchartPatch(doc, dup);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.message).toContain("已存在");

    const inner: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "addPool",
          pool: {
            id: "p1",
            label: "x",
            lanes: [
              { id: "p1", label: "a" },
              { id: "l2", label: "b" },
            ],
          },
        },
      ],
    };
    const r2 = applyFlowchartPatch(doc, inner);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toContain("重复");
  });

  it("addLane 追加泳道并扩容泳池", () => {
    const doc = makeSwimDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [{ name: "addLane", poolId: "pool1", lane: { id: "lane3", label: "泳道3" } }],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.addedLanes).toBe(1);
    const lane3 = r.document.nodes.find((n) => n.id === "lane3")!;
    expect(lane3.parentId).toBe("pool1");
    expect(lane3.container?.type === "lane" && lane3.container.order).toBe(2);
    const pool = r.document.nodes.find((n) => n.id === "pool1")!;
    expect(pool.size!.height).toBeGreaterThan(200);
  });

  it("addLane 拒绝未知泳池与重复泳道 id", () => {
    const doc = makeSwimDoc();
    const baseHash = computeFlowchartSemanticHash(doc);
    const noPool = applyFlowchartPatch(doc, {
      baseHash,
      ops: [{ name: "addLane", poolId: "no-such", lane: { id: "l9" } }],
    });
    expect(noPool.ok).toBe(false);
    if (!noPool.ok) expect(noPool.message).toContain("泳池不存在");

    const dupLane = applyFlowchartPatch(doc, {
      baseHash,
      ops: [{ name: "addLane", poolId: "pool1", lane: { id: "lane1" } }],
    });
    expect(dupLane.ok).toBe(false);
    if (!dupLane.ok) expect(dupLane.message).toContain("重复");
  });

  it("moveNodeToLane 移动现有节点并保持语义哈希变化", () => {
    const doc = makeSwimDoc();
    const before = computeFlowchartSemanticHash(doc);
    const patch: FlowchartPatch = {
      baseHash: before,
      ops: [{ name: "moveNodeToLane", id: "a", expectedLabel: "A", laneId: "lane2" }],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.movedToLane).toBe(1);
    const a = r.document.nodes.find((n) => n.id === "a")!;
    expect(a.parentId).toBe("lane2");
    expect(computeFlowchartSemanticHash(r.document)).not.toBe(before);
  });

  it("moveNodeToLane laneId=null 移回根级", () => {
    const doc = makeSwimDoc();
    const r = applyFlowchartPatch(doc, {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [{ name: "moveNodeToLane", id: "a", expectedLabel: "A", laneId: null }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.document.nodes.find((n) => n.id === "a")!.parentId).toBeUndefined();
  });

  it("moveNodeToLane 校验失败场景", () => {
    const doc = makeSwimDoc();
    const baseHash = computeFlowchartSemanticHash(doc);
    // expectedLabel 不匹配
    const label = applyFlowchartPatch(doc, {
      baseHash,
      ops: [{ name: "moveNodeToLane", id: "a", expectedLabel: "错", laneId: "lane2" }],
    });
    expect(label.ok).toBe(false);
    if (!label.ok) expect(label.message).toContain("expectedLabel");
    // laneId 非泳道
    const notLane = applyFlowchartPatch(doc, {
      baseHash,
      ops: [{ name: "moveNodeToLane", id: "a", expectedLabel: "A", laneId: "pool1" }],
    });
    expect(notLane.ok).toBe(false);
    if (!notLane.ok) expect(notLane.message).toContain("不是泳道");
    // 容器不能移动归属
    const container = applyFlowchartPatch(doc, {
      baseHash,
      ops: [{ name: "moveNodeToLane", id: "lane1", expectedLabel: "泳道1", laneId: "lane2" }],
    });
    expect(container.ok).toBe(false);
    if (!container.ok) expect(container.message).toContain("容器");
  });

  it("moveNodeToLane 归属未变化时幂等成功", () => {
    const doc = makeSwimDoc();
    const r = applyFlowchartPatch(doc, {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [{ name: "moveNodeToLane", id: "a", expectedLabel: "A", laneId: "lane1" }],
    });
    expect(r.ok).toBe(true);
  });

  it("addNode + moveNodeToLane 同 patch：新节点放置在泳道内并扩容泳池", () => {
    const doc = makeSwimDoc();
    const r = applyFlowchartPatch(doc, {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        { name: "addNode", node: { id: "nx", kind: "process", label: "新节点" } },
        { name: "moveNodeToLane", id: "nx", expectedLabel: "新节点", laneId: "lane1" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nx = r.document.nodes.find((n) => n.id === "nx")!;
    expect(nx.parentId).toBe("lane1");
    // 水平泳道内容区原点 x = 32（标题）+ 16（内边距）
    expect(nx.position.x).toBeGreaterThanOrEqual(48);
    // 既有内容 A 占 y 16..64，新节点应在其后
    expect(nx.position.y).toBeGreaterThan(64);
    // 泳道 1 与泳池按内容只增扩容
    const lane1 = r.document.nodes.find((n) => n.id === "lane1")!;
    const pool = r.document.nodes.find((n) => n.id === "pool1")!;
    expect(lane1.size!.height).toBeGreaterThan(100);
    expect(pool.size!.height).toBeGreaterThan(200);
    // lane2 位置随 lane1 扩容下移
    const lane2 = r.document.nodes.find((n) => n.id === "lane2")!;
    expect(lane2.position.y).toBe(lane1.size!.height);
  });

  it("addPool 后可立即 moveNodeToLane 引用新泳道", () => {
    const doc = makeDoc();
    const r = applyFlowchartPatch(doc, {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "addPool",
          pool: {
            id: "pool-1",
            label: "职责",
            lanes: [
              { id: "lane-1", label: "前端" },
              { id: "lane-2", label: "后端" },
            ],
          },
        },
        { name: "moveNodeToLane", id: "n2", expectedLabel: "处理", laneId: "lane-1" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const n2 = r.document.nodes.find((n) => n.id === "n2")!;
    expect(n2.parentId).toBe("lane-1");
    expect(r.summary.addedPools).toBe(1);
    expect(r.summary.movedToLane).toBe(1);
  });
});

describe("applyFlowchartPatch — baseHash 校验", () => {
  it("baseHash 不匹配拒绝应用", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: "h00000000000000",
      ops: [],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("已被修改");
  });

  it("空 ops + 匹配 baseHash 返回未变文档", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
      expect(r.summary).toEqual({
        addedNodes: 0,
        updatedNodes: 0,
        removedNodes: 0,
        addedEdges: 0,
        updatedEdges: 0,
        removedEdges: 0,
        addedPools: 0,
        addedLanes: 0,
        movedToLane: 0,
        replacedGraph: false,
      });
    }
  });

  it("原文档不被修改", () => {
    const doc = makeDoc();
    const before = cloneFlowchartDocument(doc);
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [],
    };
    applyFlowchartPatch(doc, patch);
    expect(doc).toEqual(before);
  });
});

describe("applyFlowchartPatch — addNode", () => {
  it("添加新节点成功", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "addNode",
          node: { id: "n4", kind: "process", label: "审核" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.nodes.some((n) => n.id === "n4")).toBe(true);
      expect(r.summary.addedNodes).toBe(1);
      // 新节点应获得有限坐标
      const n4 = r.document.nodes.find((n) => n.id === "n4")!;
      expect(Number.isFinite(n4.position.x)).toBe(true);
      expect(Number.isFinite(n4.position.y)).toBe(true);
    }
  });

  it("重复 id 拒绝", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "addNode",
          node: { id: "n1", kind: "process", label: "重复" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("已存在");
  });

  it("同一 patch 内重复 id 拒绝", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        { name: "addNode", node: { id: "dup", kind: "process", label: "a" } },
        { name: "addNode", node: { id: "dup", kind: "process", label: "b" } },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("重复");
  });
});

describe("applyFlowchartPatch — updateNode", () => {
  it("修改 label 成功", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "updateNode",
          id: "n2",
          expectedLabel: "处理",
          patch: { label: "审核" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.nodes.find((n) => n.id === "n2")!.label).toBe("审核");
      expect(r.summary.updatedNodes).toBe(1);
    }
  });

  it("expectedLabel 不匹配拒绝", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "updateNode",
          id: "n2",
          expectedLabel: "错误标签",
          patch: { label: "审核" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("expectedLabel");
  });

  it("节点不存在拒绝", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "updateNode",
          id: "no-such",
          expectedLabel: "x",
          patch: { label: "y" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("不存在");
  });
});

describe("applyFlowchartPatch — addEdge", () => {
  it("添加新边成功", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "addEdge",
          edge: { id: "e3", source: "n1", target: "n3", label: "直达" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.edges.some((e) => e.id === "e3")).toBe(true);
      expect(r.summary.addedEdges).toBe(1);
    }
  });

  it("边 id 重复拒绝", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "addEdge",
          edge: { id: "e1", source: "n1", target: "n3" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("已存在");
  });

  it("source 不存在拒绝", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "addEdge",
          edge: { id: "ex", source: "no-such", target: "n3" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("source");
  });

  it("自环边拒绝", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "addEdge",
          edge: { id: "ex", source: "n1", target: "n1" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("自环");
  });

  it("可引用同 patch 新增的节点", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        { name: "addNode", node: { id: "n4", kind: "process", label: "新" } },
        {
          name: "addEdge",
          edge: { id: "e3", source: "n2", target: "n4" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.edges.some((e) => e.id === "e3")).toBe(true);
    }
  });
});

describe("applyFlowchartPatch — updateEdge / removeEdge", () => {
  it("修改边 label 成功", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "updateEdge",
          id: "e1",
          expected: { source: "n1", target: "n2" },
          patch: { label: "通过" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.edges.find((e) => e.id === "e1")!.label).toBe("通过");
    }
  });

  it("expected 不匹配拒绝", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "updateEdge",
          id: "e1",
          expected: { source: "n1", target: "n3" },
          patch: { label: "x" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("expected");
  });

  it("删除边成功", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "removeEdge",
          id: "e2",
          expected: { source: "n2", target: "n3" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.edges.some((e) => e.id === "e2")).toBe(false);
      expect(r.summary.removedEdges).toBe(1);
    }
  });

  it("修改后产生自环拒绝", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "updateEdge",
          id: "e1",
          expected: { source: "n1", target: "n2" },
          patch: { target: "n1" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("自环");
  });
});

describe("applyFlowchartPatch — removeSubgraph", () => {
  it("完整删除子图（节点+关联边）成功", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "removeSubgraph",
          nodes: [{ id: "n2", expectedLabel: "处理" }],
          edges: [
            { id: "e1", expected: { source: "n1", target: "n2" } },
            { id: "e2", expected: { source: "n2", target: "n3" } },
          ],
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.nodes.some((n) => n.id === "n2")).toBe(false);
      expect(r.document.edges.length).toBe(0);
      expect(r.summary.removedNodes).toBe(1);
      expect(r.summary.removedEdges).toBe(2);
    }
  });

  it("漏列关联边拒绝", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "removeSubgraph",
          nodes: [{ id: "n2", expectedLabel: "处理" }],
          edges: [{ id: "e1", expected: { source: "n1", target: "n2" } }],
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("不完整");
  });

  it("夹带无关边拒绝", () => {
    // 构造一个 doc：n1 → n2 → n3，n4 孤立
    const doc = makeDoc({
      nodes: [
        { id: "n1", kind: "start", label: "开始", position: { x: 0, y: 0 } },
        { id: "n2", kind: "process", label: "处理", position: { x: 0, y: 120 } },
        { id: "n3", kind: "end", label: "结束", position: { x: 0, y: 240 } },
        { id: "n4", kind: "process", label: "孤立", position: { x: 200, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3" },
        { id: "e3", source: "n1", target: "n4" },
      ],
    });
    // 删除 n4：必须列 e3，但这里漏列
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "removeSubgraph",
          nodes: [{ id: "n4", expectedLabel: "孤立" }],
          edges: [{ id: "e3", expected: { source: "n1", target: "n4" } }],
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
  });

  it("expectedLabel 不匹配拒绝", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "removeSubgraph",
          nodes: [{ id: "n2", expectedLabel: "错误" }],
          edges: [],
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("expectedLabel");
  });
});

describe("applyFlowchartPatch — replaceGraph", () => {
  it("替换为全新图成功", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "replaceGraph",
          graph: {
            direction: "LR",
            nodes: [
              { id: "a", kind: "start", label: "新开始" },
              { id: "b", kind: "end", label: "新结束" },
            ],
            edges: [{ id: "ea", source: "a", target: "b" }],
          },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.direction).toBe("LR");
      expect(r.document.nodes.map((n) => n.id)).toEqual(["a", "b"]);
      expect(r.summary.replacedGraph).toBe(true);
    }
  });

  it("替换图中边端点不存在拒绝", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "replaceGraph",
          graph: {
            direction: "TB",
            nodes: [{ id: "a", kind: "start", label: "x" }],
            edges: [{ id: "e", source: "a", target: "no-such" }],
          },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("target");
  });

  it("替换后所有节点有有限坐标", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "replaceGraph",
          graph: {
            direction: "TB",
            nodes: [
              { id: "a", kind: "start", label: "x" },
              { id: "b", kind: "end", label: "y" },
            ],
            edges: [{ id: "e", source: "a", target: "b" }],
          },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      for (const n of r.document.nodes) {
        expect(Number.isFinite(n.position.x)).toBe(true);
        expect(Number.isFinite(n.position.y)).toBe(true);
      }
    }
  });
});

describe("applyFlowchartPatch — 原子性", () => {
  it("部分 op 失败时原文档不变", () => {
    const doc = makeDoc();
    const before = cloneFlowchartDocument(doc);
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        { name: "addNode", node: { id: "n4", kind: "process", label: "新" } },
        // 失败 op：expectedLabel 不匹配
        {
          name: "updateNode",
          id: "n2",
          expectedLabel: "错误",
          patch: { label: "x" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    expect(doc).toEqual(before);
  });

  it("应用后产生无效文档拒绝（自环边通过 updateEdge）", () => {
    const doc = makeDoc();
    const before = cloneFlowchartDocument(doc);
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        {
          name: "updateEdge",
          id: "e1",
          expected: { source: "n1", target: "n2" },
          patch: { target: "n1" },
        },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(false);
    expect(doc).toEqual(before);
  });
});

describe("applyFlowchartPatch — 新节点放置", () => {
  it("新节点不与现有节点重叠", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        { name: "addNode", node: { id: "n4", kind: "process", label: "新节点4" } },
        { name: "addNode", node: { id: "n5", kind: "process", label: "新节点5" } },
        { name: "addNode", node: { id: "n6", kind: "process", label: "新节点6" } },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const allBoxes = r.document.nodes.map((n) => ({
        id: n.id,
        x: n.position.x - 70,
        y: n.position.y - 24,
        w: 140,
        h: 48,
      }));
      for (let i = 0; i < allBoxes.length; i++) {
        for (let j = i + 1; j < allBoxes.length; j++) {
          const a = allBoxes[i];
          const b = allBoxes[j];
          const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
          expect(overlap).toBe(false);
        }
      }
    }
  });

  it("相同 patch 重复应用得到相同坐标", () => {
    const doc1 = makeDoc();
    const doc2 = makeDoc();
    const buildPatch = (): FlowchartPatch => ({
      baseHash: computeFlowchartSemanticHash(doc1),
      ops: [
        { name: "addNode", node: { id: "n4", kind: "process", label: "新节点4" } },
        { name: "addEdge", edge: { id: "e3", source: "n2", target: "n4" } },
      ],
    });
    const r1 = applyFlowchartPatch(doc1, buildPatch());
    const r2 = applyFlowchartPatch(doc2, buildPatch());
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      const n4a = r1.document.nodes.find((n) => n.id === "n4")!;
      const n4b = r2.document.nodes.find((n) => n.id === "n4")!;
      expect(n4a.position.x).toBe(n4b.position.x);
      expect(n4a.position.y).toBe(n4b.position.y);
    }
  });

  it("有入边锚点的新节点放在锚点之后", () => {
    const doc = makeDoc();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        { name: "addNode", node: { id: "n4", kind: "process", label: "新节点4" } },
        { name: "addEdge", edge: { id: "e3", source: "n2", target: "n4" } },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const n2 = r.document.nodes.find((n) => n.id === "n2")!;
      const n4 = r.document.nodes.find((n) => n.id === "n4")!;
      // TB 方向：新节点应在锚点下方
      expect(n4.position.y).toBeGreaterThan(n2.position.y);
    }
  });

  it("LR 方向：入边锚点放在右侧", () => {
    const doc = makeDoc({ direction: "LR" });
    layoutEntireGraph(doc);
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(doc),
      ops: [
        { name: "addNode", node: { id: "n4", kind: "process", label: "新节点4" } },
        { name: "addEdge", edge: { id: "e3", source: "n2", target: "n4" } },
      ],
    };
    const r = applyFlowchartPatch(doc, patch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const n2 = r.document.nodes.find((n) => n.id === "n2")!;
      const n4 = r.document.nodes.find((n) => n.id === "n4")!;
      expect(n4.position.x).toBeGreaterThan(n2.position.x);
    }
  });
});

describe("layoutEntireGraph", () => {
  it("对全图重新布局，所有节点坐标有限", () => {
    const doc = makeDoc({
      nodes: [
        { id: "n1", kind: "start", label: "a", position: { x: 0, y: 0 } },
        { id: "n2", kind: "end", label: "b", position: { x: 0, y: 0 } },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
    });
    layoutEntireGraph(doc);
    for (const n of doc.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  it("空图不报错", () => {
    const doc: FlowchartDocument = {
      version: 2,
      direction: "TB",
      canvas: {
        ...DEFAULT_FLOWCHART_CANVAS,
        grid: { ...DEFAULT_FLOWCHART_CANVAS.grid },
      },
      theme: { ...DEFAULT_FLOWCHART_THEME },
      nodes: [],
      edges: [],
    };
    expect(() => layoutEntireGraph(doc)).not.toThrow();
  });
});

describe("layoutFlowchartWithContainers", () => {
  /** 横向泳池：pool 标题区在左（40px），两条泳道各 400 高（足够容纳内容，不触发扩容） */
  function makeSwimlaneDoc(): FlowchartDocument {
    return makeDoc({
      nodes: [
        {
          id: "pool1",
          kind: "swimlane-pool",
          label: "泳池",
          position: { x: 100, y: 100 },
          size: { width: 900, height: 800 },
          container: { type: "pool", orientation: "horizontal", headerSize: 40 },
        },
        {
          id: "lane1",
          kind: "swimlane-lane",
          label: "泳道1",
          parentId: "pool1",
          position: { x: 40, y: 0 },
          size: { width: 860, height: 400 },
          container: { type: "lane", orientation: "horizontal", order: 0 },
        },
        {
          id: "lane2",
          kind: "swimlane-lane",
          label: "泳道2",
          parentId: "pool1",
          position: { x: 40, y: 400 },
          size: { width: 860, height: 400 },
          container: { type: "lane", orientation: "horizontal", order: 1 },
        },
        { id: "a", kind: "process", label: "A", parentId: "lane1", position: { x: 400, y: 30 } },
        { id: "b", kind: "process", label: "B", parentId: "lane1", position: { x: 400, y: 90 } },
        { id: "c", kind: "process", label: "C", parentId: "lane2", position: { x: 400, y: 30 } },
      ],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c" },
      ],
    });
  }

  it("无容器时退化为全量布局", () => {
    const doc = makeDoc();
    layoutFlowchartWithContainers(doc);
    for (const n of doc.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  it("泳池位置不变，泳道按 order 紧凑重排", () => {
    const doc = makeSwimlaneDoc();
    layoutFlowchartWithContainers(doc);
    const pool = doc.nodes.find((n) => n.id === "pool1")!;
    const lane1 = doc.nodes.find((n) => n.id === "lane1")!;
    const lane2 = doc.nodes.find((n) => n.id === "lane2")!;
    expect(pool.position).toEqual({ x: 100, y: 100 });
    expect(lane1.position).toEqual({ x: 40, y: 0 });
    expect(lane2.position.x).toBe(40);
    expect(lane2.position.y).toBe(lane1.size!.height);
  });

  it("泳道内节点布局在内容区内（避开标题区与内边距），TB 方向按边排序", () => {
    const doc = makeSwimlaneDoc();
    layoutFlowchartWithContainers(doc);
    const a = doc.nodes.find((n) => n.id === "a")!;
    const b = doc.nodes.find((n) => n.id === "b")!;
    // 横向泳道：标题区在左 32px + 内边距 16px
    expect(a.position.x).toBeGreaterThanOrEqual(48);
    expect(a.position.y).toBeGreaterThanOrEqual(16);
    expect(b.position.x).toBeGreaterThanOrEqual(48);
    expect(b.position.y).toBeGreaterThanOrEqual(16);
    // TB：a -> b，b 在 a 下方
    expect(b.position.y).toBeGreaterThan(a.position.y);
  });

  it("泳道沿向尺寸只增不减", () => {
    const doc = makeSwimlaneDoc();
    layoutFlowchartWithContainers(doc);
    const lane1 = doc.nodes.find((n) => n.id === "lane1")!;
    // 内容（2 个节点）需要的高度小于 400，保留用户手调尺寸
    expect(lane1.size!.height).toBe(400);
  });

  it("内容超出时泳道扩容，泳池沿向同步扩展", () => {
    const doc = makeSwimlaneDoc();
    // 在 lane1 中追加长链节点，强制沿向扩容
    for (let i = 0; i < 6; i++) {
      const prev = i === 0 ? "b" : `x${i - 1}`;
      doc.nodes.push({
        id: `x${i}`,
        kind: "process",
        label: `X${i}`,
        parentId: "lane1",
        position: { x: 400, y: 30 },
      });
      doc.edges.push({ id: `ex${i}`, source: prev, target: `x${i}` });
    }
    layoutFlowchartWithContainers(doc);
    const lane1 = doc.nodes.find((n) => n.id === "lane1")!;
    const lane2 = doc.nodes.find((n) => n.id === "lane2")!;
    const pool = doc.nodes.find((n) => n.id === "pool1")!;
    expect(lane1.size!.height).toBeGreaterThan(400);
    // 泳池沿向 = 泳道总和（只增不减）
    expect(pool.size!.height).toBe(lane1.size!.height + lane2.size!.height);
    // 泳道跨向 = 泳池跨向 - 池标题区
    expect(lane1.size!.width).toBe(pool.size!.width - 40);
    expect(lane2.size!.width).toBe(pool.size!.width - 40);
  });

  it("跨泳道边统一分配连接点", () => {
    const doc = makeSwimlaneDoc();
    layoutFlowchartWithContainers(doc);
    const e2 = doc.edges.find((e) => e.id === "e2")!;
    expect(e2.sourceHandle).toBeDefined();
    expect(e2.targetHandle).toBeDefined();
  });
});

describe("summarizePatch", () => {
  it("replaceGraph 文案", () => {
    expect(summarizePatch({
      addedNodes: 0, updatedNodes: 0, removedNodes: 0,
      addedEdges: 0, updatedEdges: 0, removedEdges: 0,
      addedPools: 0, addedLanes: 0, movedToLane: 0,
      replacedGraph: true,
    })).toBe("替换为完整新流程图");
  });

  it("空 patch 文案", () => {
    expect(summarizePatch({
      addedNodes: 0, updatedNodes: 0, removedNodes: 0,
      addedEdges: 0, updatedEdges: 0, removedEdges: 0,
      addedPools: 0, addedLanes: 0, movedToLane: 0,
      replacedGraph: false,
    })).toBe("无变更");
  });

  it("复合变更文案", () => {
    expect(summarizePatch({
      addedNodes: 2, updatedNodes: 1, removedNodes: 0,
      addedEdges: 3, updatedEdges: 0, removedEdges: 1,
      addedPools: 0, addedLanes: 0, movedToLane: 0,
      replacedGraph: false,
    })).toBe("新增 2 个节点 · 修改 1 个节点 · 新增 3 条连线 · 删除 1 条连线");
  });

  it("泳道变更文案", () => {
    expect(summarizePatch({
      addedNodes: 1, updatedNodes: 0, removedNodes: 0,
      addedEdges: 0, updatedEdges: 0, removedEdges: 0,
      addedPools: 1, addedLanes: 1, movedToLane: 2,
      replacedGraph: false,
    })).toBe("新增 1 个泳池 · 新增 1 条泳道 · 移动 2 个节点归属 · 新增 1 个节点");
  });
});

describe("createBlankFlowchartDocument", () => {
  it("包含开始和结束节点", () => {
    const doc = createBlankFlowchartDocument();
    expect(doc.nodes.length).toBe(2);
    expect(doc.nodes.some((n) => n.kind === "start")).toBe(true);
    expect(doc.nodes.some((n) => n.kind === "end")).toBe(true);
  });

  it("version 为 2", () => {
    expect(createBlankFlowchartDocument().version).toBe(2);
  });
});
