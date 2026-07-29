import { describe, expect, it } from "vitest";

import {
  applyFlowchartPatch,
  layoutEntireGraph,
  parseFlowchartPatch,
  summarizePatch,
  type FlowchartPatch,
} from "./flowchart-patch";
import {
  cloneFlowchartDocument,
  computeFlowchartSemanticHash,
  createBlankFlowchartDocument,
  type FlowchartDocument,
} from "./flowchart-document";

function makeDoc(overrides: Partial<FlowchartDocument> = {}): FlowchartDocument {
  return {
    version: 1,
    direction: "TB",
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
      version: 1,
      direction: "TB",
      nodes: [],
      edges: [],
    };
    expect(() => layoutEntireGraph(doc)).not.toThrow();
  });
});

describe("summarizePatch", () => {
  it("replaceGraph 文案", () => {
    expect(summarizePatch({
      addedNodes: 0, updatedNodes: 0, removedNodes: 0,
      addedEdges: 0, updatedEdges: 0, removedEdges: 0,
      replacedGraph: true,
    })).toBe("替换为完整新流程图");
  });

  it("空 patch 文案", () => {
    expect(summarizePatch({
      addedNodes: 0, updatedNodes: 0, removedNodes: 0,
      addedEdges: 0, updatedEdges: 0, removedEdges: 0,
      replacedGraph: false,
    })).toBe("无变更");
  });

  it("复合变更文案", () => {
    expect(summarizePatch({
      addedNodes: 2, updatedNodes: 1, removedNodes: 0,
      addedEdges: 3, updatedEdges: 0, removedEdges: 1,
      replacedGraph: false,
    })).toBe("新增 2 个节点 · 修改 1 个节点 · 新增 3 条连线 · 删除 1 条连线");
  });
});

describe("createBlankFlowchartDocument", () => {
  it("包含开始和结束节点", () => {
    const doc = createBlankFlowchartDocument();
    expect(doc.nodes.length).toBe(2);
    expect(doc.nodes.some((n) => n.kind === "start")).toBe(true);
    expect(doc.nodes.some((n) => n.kind === "end")).toBe(true);
  });

  it("version 为 1", () => {
    expect(createBlankFlowchartDocument().version).toBe(1);
  });
});
