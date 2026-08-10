import { describe, expect, it } from "vitest";

import type { FlowchartDocument, FlowchartEdge, FlowchartNode } from "./flowchart-document";
import {
  DEFAULT_FLOWCHART_CANVAS,
  DEFAULT_FLOWCHART_THEME,
  validateFlowchartDocument,
} from "./flowchart-document";
import {
  addLaneToPool,
  createPoolNodes,
  FLOWCHART_GROUP_PADDING,
  flowchartNodeAbsolutePosition,
  groupNodes,
  matchNodesHeight,
  matchNodesSize,
  matchNodesWidth,
  nudgeNodes,
  removeLane,
  removePool,
  reorderLane,
  reorderNodes,
  reparentNodes,
  ungroupNodes,
} from "./flowchart-operations";

function node(id: string, overrides: Partial<FlowchartNode> = {}): FlowchartNode {
  return {
    id,
    kind: "rectangle",
    label: id,
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

/** 用操作结果组装整档并跑 v2 校验，确保操作产物结构合法。 */
function expectValidDoc(nodes: FlowchartNode[], edges: FlowchartEdge[]): void {
  const doc: FlowchartDocument = {
    version: 2,
    direction: "TB",
    canvas: { ...DEFAULT_FLOWCHART_CANVAS, grid: { ...DEFAULT_FLOWCHART_CANVAS.grid } },
    theme: { ...DEFAULT_FLOWCHART_THEME },
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const v = validateFlowchartDocument(doc);
  expect(v.ok ? [] : v.errors.map((e) => e.code)).toEqual([]);
}

/** 标准泳池夹具：pool(100,100) 600x300，lane1/lane2 各 560x150。 */
function poolFixture(): FlowchartNode[] {
  return createPoolNodes({
    poolId: "pool",
    laneIds: ["lane1", "lane2"],
    orientation: "horizontal",
    position: { x: 100, y: 100 },
  });
}

describe("matchNodesWidth / matchNodesHeight / matchNodesSize", () => {
  const nodes: FlowchartNode[] = [
    node("ref", { size: { width: 200, height: 100 } }),
    node("a", { size: { width: 120, height: 60 } }),
    node("b", { size: { width: 80, height: 40 } }),
  ];

  it("少于 2 个目标返回 null", () => {
    expect(matchNodesWidth(nodes, ["ref"])).toBeNull();
    expect(matchNodesWidth(nodes, [])).toBeNull();
  });

  it("匹配宽度：以第一个目标为参考", () => {
    const next = matchNodesWidth(nodes, ["ref", "a", "b"]);
    expect(next).not.toBeNull();
    expect(next!.find((n) => n.id === "a")!.size).toEqual({ width: 200, height: 60 });
    expect(next!.find((n) => n.id === "b")!.size).toEqual({ width: 200, height: 40 });
  });

  it("匹配高度：以第一个目标为参考", () => {
    const next = matchNodesHeight(nodes, ["ref", "a"]);
    expect(next!.find((n) => n.id === "a")!.size).toEqual({ width: 120, height: 100 });
  });

  it("匹配大小：宽高同时匹配参考节点", () => {
    const next = matchNodesSize(nodes, ["ref", "a"]);
    expect(next!.find((n) => n.id === "a")!.size).toEqual({ width: 200, height: 100 });
  });

  it("锁定节点不修改", () => {
    const withLocked: FlowchartNode[] = [
      node("ref", { size: { width: 200, height: 100 } }),
      node("locked", { size: { width: 50, height: 50 }, locked: true }),
      node("free", { size: { width: 60, height: 60 } }),
    ];
    const next = matchNodesSize(withLocked, ["ref", "locked", "free"]);
    expect(next!.find((n) => n.id === "locked")!.size).toEqual({ width: 50, height: 50 });
    expect(next!.find((n) => n.id === "free")!.size).toEqual({ width: 200, height: 100 });
  });

  it("全部目标已是参考尺寸时返回 null（不产生空提交）", () => {
    const same: FlowchartNode[] = [
      node("x", { size: { width: 100, height: 50 } }),
      node("y", { size: { width: 100, height: 50 } }),
    ];
    expect(matchNodesSize(same, ["x", "y"])).toBeNull();
  });

  it("等比形状（circle）匹配宽度后仍保持宽高比", () => {
    const withCircle: FlowchartNode[] = [
      node("ref", { size: { width: 200, height: 100 } }),
      node("c", { kind: "circle", size: { width: 80, height: 80 } }),
    ];
    const next = matchNodesWidth(withCircle, ["ref", "c"]);
    const c = next!.find((n) => n.id === "c")!;
    expect(c.size!.width).toBe(200);
    expect(c.size!.height).toBe(200); // 保持 1:1
  });

  it("等比形状（circle）匹配高度后宽度按比例推导", () => {
    const withCircle: FlowchartNode[] = [
      node("ref", { size: { width: 200, height: 120 } }),
      node("c", { kind: "circle", size: { width: 80, height: 80 } }),
    ];
    const next = matchNodesHeight(withCircle, ["ref", "c"]);
    const c = next!.find((n) => n.id === "c")!;
    expect(c.size).toEqual({ width: 120, height: 120 });
  });

  it("等比形状匹配大小时以宽度为驱动保持约束", () => {
    const withCircle: FlowchartNode[] = [
      node("ref", { size: { width: 200, height: 100 } }),
      node("c", { kind: "circle", size: { width: 80, height: 80 } }),
    ];
    const next = matchNodesSize(withCircle, ["ref", "c"]);
    const c = next!.find((n) => n.id === "c")!;
    expect(c.size!.width).toBe(200);
    expect(c.size!.height).toBe(200); // 圆不能被拉成椭圆
  });

  it("无默认 size 的节点按 200x100 处理", () => {
    const noSize: FlowchartNode[] = [node("ref", { size: { width: 300, height: 150 } }), node("a")];
    const next = matchNodesSize(noSize, ["ref", "a"]);
    expect(next!.find((n) => n.id === "a")!.size).toEqual({ width: 300, height: 150 });
  });

  it("不修改输入数组（纯函数）", () => {
    const frozen = Object.freeze(nodes.map((n) => Object.freeze(n)));
    expect(() => matchNodesSize(frozen, ["ref", "a", "b"])).not.toThrow();
    expect(nodes.find((n) => n.id === "a")!.size).toEqual({ width: 120, height: 60 });
  });
});

describe("nudgeNodes", () => {
  const nodes: FlowchartNode[] = [
    node("a", { position: { x: 10, y: 20 } }),
    node("b", { position: { x: 100, y: 200 } }),
  ];

  it("空目标返回 null", () => {
    expect(nudgeNodes(nodes, [], 10, 10)).toBeNull();
  });

  it("非有限步长返回 null", () => {
    expect(nudgeNodes(nodes, ["a"], Number.NaN, 0)).toBeNull();
    expect(nudgeNodes(nodes, ["a"], 0, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("平移目标节点", () => {
    const next = nudgeNodes(nodes, ["a", "b"], 5, -5);
    expect(next!.find((n) => n.id === "a")!.position).toEqual({ x: 15, y: 15 });
    expect(next!.find((n) => n.id === "b")!.position).toEqual({ x: 105, y: 195 });
  });

  it("锁定节点不移动；全部锁定时返回 null", () => {
    const withLocked: FlowchartNode[] = [
      node("locked", { position: { x: 0, y: 0 }, locked: true }),
      node("free", { position: { x: 0, y: 0 } }),
    ];
    const next = nudgeNodes(withLocked, ["locked", "free"], 10, 10);
    expect(next!.find((n) => n.id === "locked")!.position).toEqual({ x: 0, y: 0 });
    expect(next!.find((n) => n.id === "free")!.position).toEqual({ x: 10, y: 10 });
    expect(nudgeNodes(withLocked, ["locked"], 10, 10)).toBeNull();
  });

  it("不修改输入数组（纯函数）", () => {
    const before = nodes.map((n) => ({ ...n }));
    nudgeNodes(nodes, ["a"], 30, 30);
    expect(nodes).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// FC-GROUP-01：group / ungroup / reparent
// ---------------------------------------------------------------------------

describe("groupNodes", () => {
  const nodes: FlowchartNode[] = [
    node("a", { position: { x: 100, y: 100 }, size: { width: 200, height: 100 } }),
    node("b", { position: { x: 400, y: 300 }, size: { width: 100, height: 50 } }),
    node("c", { position: { x: 800, y: 800 } }),
  ];

  it("少于 2 个目标 / 重复 id / 不存在节点返回 null", () => {
    expect(groupNodes(nodes, ["a"], "g1")).toBeNull();
    expect(groupNodes(nodes, ["a", "a"], "g1")).toBeNull();
    expect(groupNodes(nodes, ["a", "missing"], "g1")).toBeNull();
  });

  it("groupId 已存在返回 null", () => {
    expect(groupNodes(nodes, ["a", "b"], "c")).toBeNull();
  });

  it("锁定节点 / 容器节点 / 有 parentId 的节点不可组合", () => {
    const withLocked = [node("a"), node("b", { locked: true })];
    expect(groupNodes(withLocked, ["a", "b"], "g1")).toBeNull();
    const withContainer = [node("a"), node("g", { kind: "group", container: { type: "group" } })];
    expect(groupNodes(withContainer, ["a", "g"], "g1")).toBeNull();
    const withParent = [node("a"), node("b", { parentId: "lane1" })];
    expect(groupNodes(withParent, ["a", "b"], "g1")).toBeNull();
  });

  it("组合：包围盒 + padding，子节点转为相对坐标，父先子后", () => {
    const r = groupNodes(nodes, ["a", "b"], "g1", "分组");
    expect(r).not.toBeNull();
    const g = r!.nodes.find((n) => n.id === "g1")!;
    expect(g.kind).toBe("group");
    expect(g.label).toBe("分组");
    expect(g.container).toEqual({ type: "group" });
    // 包围盒：min(100,100) max(500,350) → +16 padding
    expect(g.position).toEqual({ x: 100 - FLOWCHART_GROUP_PADDING, y: 100 - FLOWCHART_GROUP_PADDING });
    expect(g.size).toEqual({
      width: 400 + FLOWCHART_GROUP_PADDING * 2,
      height: 250 + FLOWCHART_GROUP_PADDING * 2,
    });
    const a = r!.nodes.find((n) => n.id === "a")!;
    const b = r!.nodes.find((n) => n.id === "b")!;
    expect(a.parentId).toBe("g1");
    expect(a.position).toEqual({ x: FLOWCHART_GROUP_PADDING, y: FLOWCHART_GROUP_PADDING });
    expect(b.position).toEqual({ x: 300 + FLOWCHART_GROUP_PADDING, y: 200 + FLOWCHART_GROUP_PADDING });
    // 未选中的 c 不受影响
    expect(r!.nodes.find((n) => n.id === "c")!.parentId).toBeUndefined();
    // 父先子后：g1 在 a/b 之前
    const ids = r!.nodes.map((n) => n.id);
    expect(ids.indexOf("g1")).toBeLessThan(ids.indexOf("a"));
    expect(ids.indexOf("g1")).toBeLessThan(ids.indexOf("b"));
    expectValidDoc(r!.nodes, []);
  });

  it("group zIndex 取子节点最小值", () => {
    const withZ: FlowchartNode[] = [
      node("a", { zIndex: 5 }),
      node("b", { zIndex: 2 }),
    ];
    const r = groupNodes(withZ, ["a", "b"], "g1");
    expect(r!.nodes.find((n) => n.id === "g1")!.zIndex).toBe(2);
  });
});

describe("ungroupNodes", () => {
  it("空目标 / 非 group 目标返回 null", () => {
    expect(ungroupNodes([], [], [])).toBeNull();
    const nodes = [node("a")];
    expect(ungroupNodes(nodes, [], ["a"])).toBeNull();
  });

  it("取消组合：子节点恢复绝对坐标，group 删除，相关边级联删除", () => {
    const grouped = groupNodes(
      [
        node("a", { position: { x: 100, y: 100 }, size: { width: 200, height: 100 } }),
        node("b", { position: { x: 400, y: 300 }, size: { width: 100, height: 50 } }),
      ],
      ["a", "b"],
      "g1",
    )!;
    const edges: FlowchartEdge[] = [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "g1", target: "a" }, // 非法但防御性删除
    ];
    const r = ungroupNodes(grouped.nodes, edges, ["g1"])!;
    expect(r.nodes.find((n) => n.id === "g1")).toBeUndefined();
    const a = r.nodes.find((n) => n.id === "a")!;
    const b = r.nodes.find((n) => n.id === "b")!;
    expect(a.parentId).toBeUndefined();
    expect(a.position).toEqual({ x: 100, y: 100 });
    expect(b.position).toEqual({ x: 400, y: 300 });
    // e1 保留（两端都在），e2 级联删除
    expect(r.edges.map((e) => e.id)).toEqual(["e1"]);
    expectValidDoc(r.nodes, r.edges);
  });
});

describe("reparentNodes", () => {
  it("空目标 / 父不存在 / 父为 pool 返回 null", () => {
    const nodes = poolFixture();
    expect(reparentNodes(nodes, [], "lane1")).toBeNull();
    expect(reparentNodes(nodes, ["a"], "missing")).toBeNull();
    // 普通节点不能直挂 pool
    const withNode = [...nodes, node("a", { position: { x: 500, y: 500 } })];
    expect(reparentNodes(withNode, ["a"], "pool")).toBeNull();
  });

  it("节点移入 lane：位置转为 lane 相对坐标", () => {
    const nodes = [...poolFixture(), node("a", { position: { x: 300, y: 250 } })];
    // lane1 绝对位置 = pool(100,100) + (40,0) = (140,100)
    const r = reparentNodes(nodes, ["a"], "lane1")!;
    const a = r.find((n) => n.id === "a")!;
    expect(a.parentId).toBe("lane1");
    expect(a.position).toEqual({ x: 160, y: 150 });
    expectValidDoc(r, []);
  });

  it("节点拖出 pool：解除 parentId 并保持屏幕位置", () => {
    const nodes = [
      ...poolFixture(),
      node("a", { parentId: "lane2", position: { x: 60, y: 40 } }),
    ];
    // lane2 绝对 = (100,100)+(40,150) = (140,250)；a 绝对 = (200,290)
    const r = reparentNodes(nodes, ["a"], undefined)!;
    const a = r.find((n) => n.id === "a")!;
    expect(a.parentId).toBeUndefined();
    expect(a.position).toEqual({ x: 200, y: 290 });
    expectValidDoc(r, []);
  });

  it("锁定节点与容器节点跳过；归属未变化返回 null", () => {
    const nodes = [
      ...poolFixture(),
      node("locked", { position: { x: 300, y: 250 }, locked: true }),
    ];
    expect(reparentNodes(nodes, ["locked"], "lane1")).toBeNull();
    expect(reparentNodes(nodes, ["lane1"], "lane2")).toBeNull();
    const inLane = [...poolFixture(), node("a", { parentId: "lane1", position: { x: 10, y: 10 } })];
    expect(reparentNodes(inLane, ["a"], "lane1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FC-LAYER-01：reorder
// ---------------------------------------------------------------------------

describe("reorderNodes", () => {
  it("空目标返回 null", () => {
    expect(reorderNodes([node("a")], [], "front")).toBeNull();
  });

  it("置顶：目标移到序列末尾，兄弟重写密集 zIndex", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d")];
    const r = reorderNodes(nodes, ["b"], "front")!;
    const z = new Map(r.map((n) => [n.id, n.zIndex]));
    // 视觉顺序 a c d b
    expect(z.get("a")).toBe(0);
    expect(z.get("c")).toBe(1);
    expect(z.get("d")).toBe(2);
    expect(z.get("b")).toBe(3);
  });

  it("置底：目标移到序列开头", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const r = reorderNodes(nodes, ["c"], "back")!;
    const z = new Map(r.map((n) => [n.id, n.zIndex]));
    expect(z.get("c")).toBe(0);
    expect(z.get("a")).toBe(1);
    expect(z.get("b")).toBe(2);
  });

  it("上移一层：与上方兄弟交换", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const r = reorderNodes(nodes, ["a"], "forward")!;
    const z = new Map(r.map((n) => [n.id, n.zIndex]));
    expect(z.get("b")).toBe(0);
    expect(z.get("a")).toBe(1);
    expect(z.get("c")).toBe(2);
  });

  it("下移一层：与下方兄弟交换", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const r = reorderNodes(nodes, ["c"], "backward")!;
    const z = new Map(r.map((n) => [n.id, n.zIndex]));
    expect(z.get("a")).toBe(0);
    expect(z.get("c")).toBe(1);
    expect(z.get("b")).toBe(2);
  });

  it("多选保持相对顺序；已在顶端时返回 null", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d")];
    const r = reorderNodes(nodes, ["a", "c"], "front")!;
    const z = new Map(r.map((n) => [n.id, n.zIndex]));
    // b d a c
    expect(z.get("b")).toBe(0);
    expect(z.get("d")).toBe(1);
    expect(z.get("a")).toBe(2);
    expect(z.get("c")).toBe(3);
    // 已置顶再置顶 → null
    expect(reorderNodes(r, ["c"], "front")).toBeNull();
    // 顶层节点再上移 → null
    expect(reorderNodes(nodes, ["d"], "forward")).toBeNull();
  });

  it("尊重既有 zIndex 与容器默认下层", () => {
    const nodes: FlowchartNode[] = [
      node("g", { kind: "group", container: { type: "group" } }), // 默认 -1
      node("a", { zIndex: 10 }),
      node("b", { zIndex: 5 }),
    ];
    // 当前视觉顺序：g(-1) b(5) a(10)；b 置顶后：g a b
    const r = reorderNodes(nodes, ["b"], "front")!;
    const z = new Map(r.map((n) => [n.id, n.zIndex]));
    expect(z.get("g")).toBe(0);
    expect(z.get("a")).toBe(1);
    expect(z.get("b")).toBe(2);
  });

  it("跨父级多选按父级分组独立调整", () => {
    const nodes: FlowchartNode[] = [
      node("g", { kind: "group", container: { type: "group" } }),
      node("in", { parentId: "g" }),
      node("in2", { parentId: "g" }),
      node("out1"),
      node("out2"),
    ];
    const r = reorderNodes(nodes, ["in", "out1"], "front")!;
    const z = new Map(r.map((n) => [n.id, n.zIndex]));
    // g 组内：in2(0) in(1)；根级：g(0) out2(1) out1(2)
    expect(z.get("in2")).toBe(0);
    expect(z.get("in")).toBe(1);
    expect(z.get("g")).toBe(0);
    expect(z.get("out2")).toBe(1);
    expect(z.get("out1")).toBe(2);
    expectValidDoc(r, []);
  });
});

// ---------------------------------------------------------------------------
// FC-SWIM-01：createPoolNodes / addLaneToPool
// ---------------------------------------------------------------------------

describe("createPoolNodes", () => {
  it("横向泳池：1 pool + 2 lane，尺寸与位置正确", () => {
    const nodes = createPoolNodes({
      poolId: "pool",
      laneIds: ["l1", "l2"],
      orientation: "horizontal",
      position: { x: 100, y: 100 },
    });
    expect(nodes).toHaveLength(3);
    const pool = nodes[0];
    expect(pool.kind).toBe("swimlane-pool");
    expect(pool.label).toBe("泳池");
    expect(pool.size).toEqual({ width: 600, height: 300 });
    expect(pool.container).toEqual({ type: "pool", orientation: "horizontal", headerSize: 40 });
    const [l1, l2] = nodes.slice(1);
    expect(l1.parentId).toBe("pool");
    expect(l1.position).toEqual({ x: 40, y: 0 });
    expect(l1.size).toEqual({ width: 560, height: 150 });
    expect(l1.container).toEqual({ type: "lane", orientation: "horizontal", order: 0 });
    expect(l2.position).toEqual({ x: 40, y: 150 });
    expect(l2.container).toEqual({ type: "lane", orientation: "horizontal", order: 1 });
    expectValidDoc(nodes, []);
  });

  it("纵向泳池：尺寸转置，lane 并排", () => {
    const nodes = createPoolNodes({
      poolId: "pool",
      laneIds: ["l1", "l2"],
      orientation: "vertical",
      position: { x: 0, y: 0 },
      poolTitle: "纵向泳池",
      laneTitles: ["左", "右"],
    });
    const pool = nodes[0];
    expect(pool.size).toEqual({ width: 300, height: 600 });
    expect(pool.label).toBe("纵向泳池");
    const [l1, l2] = nodes.slice(1);
    expect(l1.label).toBe("左");
    expect(l1.position).toEqual({ x: 0, y: 40 });
    expect(l1.size).toEqual({ width: 150, height: 560 });
    expect(l2.position).toEqual({ x: 150, y: 40 });
    expectValidDoc(nodes, []);
  });
});

describe("addLaneToPool", () => {
  it("pool 不存在 / 非 pool / laneId 已存在返回 null", () => {
    const nodes = poolFixture();
    expect(addLaneToPool(nodes, "missing", "l3")).toBeNull();
    expect(addLaneToPool(nodes, "lane1", "l3")).toBeNull();
    expect(addLaneToPool(nodes, "pool", "lane1")).toBeNull();
  });

  it("追加泳道：取末泳道尺寸，泳池扩容，order 递增", () => {
    const nodes = poolFixture();
    const r = addLaneToPool(nodes, "pool", "lane3", "新泳道")!;
    const pool = r.find((n) => n.id === "pool")!;
    expect(pool.size).toEqual({ width: 600, height: 450 });
    const l3 = r.find((n) => n.id === "lane3")!;
    expect(l3.label).toBe("新泳道");
    expect(l3.parentId).toBe("pool");
    expect(l3.position).toEqual({ x: 40, y: 300 });
    expect(l3.size).toEqual({ width: 560, height: 150 });
    expect(l3.container).toEqual({ type: "lane", orientation: "horizontal", order: 2 });
    // 既有泳道不变
    expect(r.find((n) => n.id === "lane1")!.size).toEqual({ width: 560, height: 150 });
    // 插入在泳池子树末尾
    expect(r[r.length - 1].id).toBe("lane3");
    expectValidDoc(r, []);
  });

  it("泳池内有内容节点时新泳道仍插入子树末尾", () => {
    const nodes = [
      ...poolFixture(),
      node("task", { parentId: "lane1", position: { x: 50, y: 50 } }),
    ];
    const r = addLaneToPool(nodes, "pool", "lane3")!;
    expect(r[r.length - 1].id).toBe("lane3");
    expectValidDoc(r, []);
  });
});

// ---------------------------------------------------------------------------
// FC-SWIM-03：reorderLane
// ---------------------------------------------------------------------------

describe("reorderLane", () => {
  it("交换相邻泳道：位置累积重排，order 更新，归属不变", () => {
    const nodes = [
      ...poolFixture(),
      node("task", { parentId: "lane1", position: { x: 50, y: 50 } }),
    ];
    const r = reorderLane(nodes, "pool", "lane2", "forward")!;
    const l1 = r.find((n) => n.id === "lane1")!;
    const l2 = r.find((n) => n.id === "lane2")!;
    // lane2 上移到第一位
    expect(l2.position).toEqual({ x: 40, y: 0 });
    expect(l2.container).toEqual({ type: "lane", orientation: "horizontal", order: 0 });
    expect(l1.position).toEqual({ x: 40, y: 150 });
    expect(l1.container).toEqual({ type: "lane", orientation: "horizontal", order: 1 });
    // 节点归属不变
    expect(r.find((n) => n.id === "task")!.parentId).toBe("lane1");
    expectValidDoc(r, []);
  });

  it("尺寸不同的泳道交换后按累积偏移重排", () => {
    const nodes = poolFixture().map((n) =>
      n.id === "lane1" ? { ...n, size: { width: 560, height: 100 } } : n,
    );
    const r = reorderLane(nodes, "pool", "lane2", "forward")!;
    expect(r.find((n) => n.id === "lane2")!.position).toEqual({ x: 40, y: 0 });
    expect(r.find((n) => n.id === "lane1")!.position).toEqual({ x: 40, y: 150 });
  });

  it("边界：首泳道前移 / 末泳道后移返回 null", () => {
    const nodes = poolFixture();
    expect(reorderLane(nodes, "pool", "lane1", "forward")).toBeNull();
    expect(reorderLane(nodes, "pool", "lane2", "backward")).toBeNull();
    expect(reorderLane(nodes, "missing", "lane1", "forward")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FC-SWIM-04：removeLane / removePool
// ---------------------------------------------------------------------------

describe("removeLane", () => {
  function laneWithContent(): { nodes: FlowchartNode[]; edges: FlowchartEdge[] } {
    return {
      nodes: [
        ...poolFixture(),
        node("a", { parentId: "lane1", position: { x: 60, y: 40 } }),
        node("b", { parentId: "lane1", position: { x: 300, y: 80 } }),
        node("c", { parentId: "lane2", position: { x: 10, y: 10 } }),
      ],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "a", target: "c" },
      ],
    };
  }

  it("lane 不存在 / 非 lane / move-to-lane 目标非法返回 null", () => {
    const { nodes, edges } = laneWithContent();
    expect(removeLane(nodes, edges, "missing", { type: "move-to-root" })).toBeNull();
    expect(removeLane(nodes, edges, "pool", { type: "move-to-root" })).toBeNull();
    expect(removeLane(nodes, edges, "lane1", { type: "move-to-lane", targetLaneId: "lane1" })).toBeNull();
    expect(removeLane(nodes, edges, "lane1", { type: "move-to-lane", targetLaneId: "missing" })).toBeNull();
  });

  it("move-to-lane：内容移到相邻泳道并保持屏幕位置，泳池收缩", () => {
    const { nodes, edges } = laneWithContent();
    const r = removeLane(nodes, edges, "lane1", { type: "move-to-lane", targetLaneId: "lane2" })!;
    // lane1 删除，lane2 上移到 (40,0)
    expect(r.nodes.find((n) => n.id === "lane1")).toBeUndefined();
    const l2 = r.nodes.find((n) => n.id === "lane2")!;
    expect(l2.position).toEqual({ x: 40, y: 0 });
    expect(l2.container).toEqual({ type: "lane", orientation: "horizontal", order: 0 });
    // 泳池 300 → 150
    expect(r.nodes.find((n) => n.id === "pool")!.size).toEqual({ width: 600, height: 150 });
    // a 原绝对位置 = pool(100,100)+lane1(40,0)+(60,40) = (200,140)
    // lane2 新绝对 = (100,100)+(40,0) = (140,100) → a 相对 = (60,40)
    const a = r.nodes.find((n) => n.id === "a")!;
    expect(a.parentId).toBe("lane2");
    expect(a.position).toEqual({ x: 60, y: 40 });
    // b 原绝对 (100+40+300, 100+0+80) = (440,180) → 相对 lane2 (300,80)
    const b = r.nodes.find((n) => n.id === "b")!;
    expect(b.position).toEqual({ x: 300, y: 80 });
    // 边全部保留
    expect(r.edges).toHaveLength(2);
    expectValidDoc(r.nodes, r.edges);
  });

  it("move-to-root：内容移到根画布并保持绝对位置", () => {
    const { nodes, edges } = laneWithContent();
    const r = removeLane(nodes, edges, "lane2", { type: "move-to-root" })!;
    expect(r.nodes.find((n) => n.id === "lane2")).toBeUndefined();
    // c 原绝对 = (100,100)+(40,150)+(10,10) = (150,260)
    const c = r.nodes.find((n) => n.id === "c")!;
    expect(c.parentId).toBeUndefined();
    expect(c.position).toEqual({ x: 150, y: 260 });
    expect(r.nodes.find((n) => n.id === "pool")!.size).toEqual({ width: 600, height: 150 });
    expectValidDoc(r.nodes, r.edges);
  });

  it("delete-content：内容与关联边级联删除", () => {
    const { nodes, edges } = laneWithContent();
    const r = removeLane(nodes, edges, "lane1", { type: "delete-content" })!;
    expect(r.nodes.find((n) => n.id === "a")).toBeUndefined();
    expect(r.nodes.find((n) => n.id === "b")).toBeUndefined();
    // e1 两端被删，e2 一端被删 → 全部级联删除
    expect(r.edges).toHaveLength(0);
    expectValidDoc(r.nodes, r.edges);
  });

  it("删除最后一条泳道时泳池一并删除", () => {
    // 先删 lane2 再删 lane1（唯一剩余）
    const step1 = removeLane(poolFixture(), [], "lane2", { type: "move-to-root" })!;
    const step2 = removeLane(step1.nodes, step1.edges, "lane1", { type: "move-to-root" })!;
    expect(step2.nodes.find((n) => n.id === "pool")).toBeUndefined();
    expect(step2.nodes).toHaveLength(0);
  });
});

describe("removePool", () => {
  it("pool 不存在返回 null", () => {
    expect(removePool([], [], "missing", { type: "move-to-root" })).toBeNull();
  });

  it("move-to-root：内部节点移到根画布保持位置，泳池泳道删除", () => {
    const nodes = [
      ...poolFixture(),
      node("a", { parentId: "lane1", position: { x: 60, y: 40 } }),
      node("b", { parentId: "lane2", position: { x: 10, y: 10 } }),
      node("outside", { position: { x: 900, y: 900 } }),
    ];
    const edges: FlowchartEdge[] = [{ id: "e1", source: "a", target: "b" }];
    const r = removePool(nodes, edges, "pool", { type: "move-to-root" })!;
    expect(r.nodes.find((n) => n.id === "pool")).toBeUndefined();
    expect(r.nodes.find((n) => n.id === "lane1")).toBeUndefined();
    const a = r.nodes.find((n) => n.id === "a")!;
    expect(a.parentId).toBeUndefined();
    expect(a.position).toEqual({ x: 200, y: 140 });
    const b = r.nodes.find((n) => n.id === "b")!;
    expect(b.position).toEqual({ x: 150, y: 260 });
    expect(r.nodes.find((n) => n.id === "outside")!.position).toEqual({ x: 900, y: 900 });
    expect(r.edges).toHaveLength(1);
    expectValidDoc(r.nodes, r.edges);
  });

  it("delete-content：全部级联删除", () => {
    const nodes = [
      ...poolFixture(),
      node("a", { parentId: "lane1", position: { x: 60, y: 40 } }),
      node("outside", { position: { x: 900, y: 900 } }),
      node("outside2", { position: { x: 1100, y: 900 } }),
    ];
    const edges: FlowchartEdge[] = [
      { id: "e1", source: "a", target: "outside" },
      { id: "e2", source: "outside", target: "outside2" },
    ];
    const r = removePool(nodes, edges, "pool", { type: "delete-content" })!;
    expect(r.nodes.map((n) => n.id)).toEqual(["outside", "outside2"]);
    expect(r.edges.map((e) => e.id)).toEqual(["e2"]);
    expectValidDoc(r.nodes, r.edges);
  });
});

// ---------------------------------------------------------------------------
// flowchartNodeAbsolutePosition
// ---------------------------------------------------------------------------

describe("flowchartNodeAbsolutePosition", () => {
  it("沿 parentId 链累加坐标", () => {
    const nodes = [
      ...poolFixture(),
      node("a", { parentId: "lane2", position: { x: 10, y: 20 } }),
    ];
    // lane2 绝对 = (100,100)+(40,150) = (140,250)；a = (150,270)
    expect(flowchartNodeAbsolutePosition(nodes, "a")).toEqual({ x: 150, y: 270 });
    expect(flowchartNodeAbsolutePosition(nodes, "pool")).toEqual({ x: 100, y: 100 });
    expect(flowchartNodeAbsolutePosition(nodes, "missing")).toBeNull();
  });
});
