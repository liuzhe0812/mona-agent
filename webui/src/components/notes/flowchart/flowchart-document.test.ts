import { describe, expect, it } from "vitest";

import {
  buildFlowchartIndexMarkdown,
  buildFlowchartPlainText,
  cloneFlowchartDocument,
  collectFlowchartSemanticWarnings,
  computeFlowchartSemanticHash,
  countFlowchartFences,
  createBlankFlowchartDocument,
  extractFlowchartFence,
  parseFlowchartMarkdown,
  serializeFlowchartMarkdown,
  validateFlowchartDocument,
  type FlowchartDocument,
} from "./flowchart-document";

function makeDoc(overrides: Partial<FlowchartDocument> = {}): FlowchartDocument {
  return {
    version: 1,
    direction: "TB",
    nodes: [
      { id: "n1", kind: "start", label: "开始", position: { x: 0, y: 0 } },
      { id: "n2", kind: "process", label: "处理", position: { x: 0, y: 100 } },
      { id: "n3", kind: "end", label: "结束", position: { x: 0, y: 200 } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...overrides,
  };
}

describe("validateFlowchartDocument", () => {
  it("接受合法文档", () => {
    expect(validateFlowchartDocument(makeDoc())).toEqual({ ok: true });
  });

  it("拒绝非对象", () => {
    const r = validateFlowchartDocument(null);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors[0].code).toBe("not-object");
  });

  it("拒绝数组", () => {
    const r = validateFlowchartDocument([]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors[0].code).toBe("not-object");
  });

  it("拒绝不支持的版本", () => {
    const r = validateFlowchartDocument({ ...makeDoc(), version: 2 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.some((e) => e.code === "version-unsupported")).toBe(true);
  });

  it("拒绝无效 direction", () => {
    const r = validateFlowchartDocument({ ...makeDoc(), direction: "BT" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.some((e) => e.code === "direction-invalid")).toBe(true);
  });

  it("拒绝节点 id 重复", () => {
    const r = validateFlowchartDocument({
      ...makeDoc(),
      nodes: [
        { id: "dup", kind: "start", label: "a", position: { x: 0, y: 0 } },
        { id: "dup", kind: "end", label: "b", position: { x: 0, y: 0 } },
      ],
      edges: [],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.some((e) => e.code === "node-id-duplicate")).toBe(true);
  });

  it("拒绝边 id 重复", () => {
    const r = validateFlowchartDocument({
      ...makeDoc(),
      nodes: [
        { id: "a", kind: "start", label: "a", position: { x: 0, y: 0 } },
        { id: "b", kind: "end", label: "b", position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: "dup", source: "a", target: "b" },
        { id: "dup", source: "a", target: "b" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.some((e) => e.code === "edge-id-duplicate")).toBe(true);
  });

  it("拒绝边端点不存在", () => {
    const r = validateFlowchartDocument({
      ...makeDoc(),
      edges: [{ id: "e1", source: "n1", target: "no-such" }],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.some((e) => e.code === "edge-target-missing")).toBe(true);
  });

  it("拒绝自环边", () => {
    const r = validateFlowchartDocument({
      ...makeDoc(),
      nodes: [
        { id: "a", kind: "process", label: "a", position: { x: 0, y: 0 } },
      ],
      edges: [{ id: "e1", source: "a", target: "a" }],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.some((e) => e.code === "edge-self-loop")).toBe(true);
  });

  it("拒绝非有限坐标", () => {
    const r = validateFlowchartDocument({
      ...makeDoc(),
      nodes: [
        { id: "n1", kind: "start", label: "a", position: { x: Number.POSITIVE_INFINITY, y: 0 } },
      ],
      edges: [],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.some((e) => e.code === "node-position-invalid")).toBe(true);
  });

  it("拒绝未知节点 kind", () => {
    const r = validateFlowchartDocument({
      ...makeDoc(),
      nodes: [
        { id: "n1", kind: "gateway" as never, label: "a", position: { x: 0, y: 0 } },
      ],
      edges: [],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.some((e) => e.code === "node-kind-invalid")).toBe(true);
  });

  it("拒绝 label 非字符串", () => {
    const r = validateFlowchartDocument({
      ...makeDoc(),
      nodes: [
        { id: "n1", kind: "start", label: 123 as unknown as string, position: { x: 0, y: 0 } },
      ],
      edges: [],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.some((e) => e.code === "node-label-not-string")).toBe(true);
  });
});

describe("parseFlowchartMarkdown / serializeFlowchartMarkdown", () => {
  it("合法文档 serialize → parse 等价", () => {
    const doc = makeDoc();
    const md = serializeFlowchartMarkdown("测试流程", doc);
    const r = parseFlowchartMarkdown(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.title).toBe("测试流程");
    expect(r.document).toEqual(doc);
  });

  it("文本投影包含标题、节点和边标签", () => {
    const doc = makeDoc();
    const md = serializeFlowchartMarkdown("订单审批", doc);
    expect(md).toContain("# 订单审批");
    expect(md).toContain("## 节点");
    expect(md).toContain("- 开始");
    expect(md).toContain("- 处理");
    expect(md).toContain("## 连线");
  });

  it("文本投影保留 [[wiki link]]", () => {
    const doc = makeDoc({
      nodes: [
        { id: "n1", kind: "start", label: "读取 [[订单]]", position: { x: 0, y: 0 } },
      ],
      edges: [],
    });
    const md = serializeFlowchartMarkdown("x", doc);
    expect(md).toContain("- 读取 [[订单]]");
  });

  it("缺少围栏报错", () => {
    const r = parseFlowchartMarkdown("# 标题\n\n纯文本无围栏");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("缺少");
  });

  it("多个围栏报错", () => {
    const md = serializeFlowchartMarkdown("t", makeDoc());
    const r = parseFlowchartMarkdown(`${md}\n\n${md}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("只能有一个");
  });

  it("损坏 JSON 报错", () => {
    const md = `# t\n\n\`\`\`mona-flowchart\n{not json}\n\`\`\`\n`;
    const r = parseFlowchartMarkdown(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("JSON 解析失败");
  });

  it("schema 不合法报错", () => {
    const md = `# t\n\n\`\`\`mona-flowchart\n{"version": 99}\n\`\`\`\n`;
    const r = parseFlowchartMarkdown(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("文档校验失败");
  });

  it("提取标题", () => {
    const md = serializeFlowchartMarkdown("我的标题", makeDoc());
    const r = parseFlowchartMarkdown(md);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBe("我的标题");
  });

  it("围栏数量统计", () => {
    expect(countFlowchartFences("no fence")).toBe(0);
    expect(countFlowchartFences(serializeFlowchartMarkdown("t", makeDoc()))).toBe(1);
  });

  it("extractFlowchartFence 返回偏移", () => {
    const md = serializeFlowchartMarkdown("t", makeDoc());
    const f = extractFlowchartFence(md);
    expect(f).not.toBeNull();
    if (!f) return;
    expect(md.slice(f.startOffset, f.startOffset + 18)).toBe("```mona-flowchart\n");
    expect(md.slice(f.endOffset - 3, f.endOffset)).toBe("```");
  });
});

describe("buildFlowchartPlainText", () => {
  it("包含标题、节点和边标签，不含 ID/坐标/字段名", () => {
    const doc = makeDoc();
    const text = buildFlowchartPlainText("订单审批", doc);
    expect(text).toContain("订单审批");
    expect(text).toContain("开始");
    expect(text).toContain("处理");
    expect(text).toContain("结束");
    expect(text).not.toContain("n1");
    expect(text).not.toContain("position");
    expect(text).not.toContain("kind");
    expect(text).not.toContain("version");
  });
});

describe("buildFlowchartIndexMarkdown", () => {
  it("空节点列表渲染占位", () => {
    const md = buildFlowchartIndexMarkdown("空", {
      version: 1,
      direction: "TB",
      nodes: [],
      edges: [],
    });
    expect(md).toContain("- （无节点）");
    expect(md).toContain("- （无连线）");
  });

  it("边带 label 投影保留 label", () => {
    const md = buildFlowchartIndexMarkdown("t", {
      version: 1,
      direction: "TB",
      nodes: [
        { id: "n1", kind: "start", label: "a", position: { x: 0, y: 0 } },
        { id: "n2", kind: "end", label: "b", position: { x: 0, y: 0 } },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2", label: "通过" }],
    });
    expect(md).toContain("- 通过");
  });
});

describe("computeFlowchartSemanticHash", () => {
  it("忽略 position", () => {
    const d1 = makeDoc();
    const d2 = makeDoc({
      nodes: [
        { id: "n1", kind: "start", label: "开始", position: { x: 999, y: 999 } },
        { id: "n2", kind: "process", label: "处理", position: { x: 888, y: 888 } },
        { id: "n3", kind: "end", label: "结束", position: { x: 777, y: 777 } },
      ],
    });
    expect(computeFlowchartSemanticHash(d1)).toBe(computeFlowchartSemanticHash(d2));
  });

  it("忽略 viewport", () => {
    const d1 = makeDoc();
    const d2 = { ...makeDoc(), viewport: { x: 50, y: 50, zoom: 2 } };
    expect(computeFlowchartSemanticHash(d1)).toBe(computeFlowchartSemanticHash(d2));
  });

  it("忽略节点数组顺序", () => {
    const d1 = makeDoc();
    const d2 = makeDoc({ nodes: [...d1.nodes].reverse() });
    expect(computeFlowchartSemanticHash(d1)).toBe(computeFlowchartSemanticHash(d2));
  });

  it("label 变化时 hash 改变", () => {
    const d1 = makeDoc();
    const d2 = makeDoc({
      nodes: [
        { id: "n1", kind: "start", label: "新开始", position: { x: 0, y: 0 } },
        { id: "n2", kind: "process", label: "处理", position: { x: 0, y: 100 } },
        { id: "n3", kind: "end", label: "结束", position: { x: 0, y: 200 } },
      ],
    });
    expect(computeFlowchartSemanticHash(d1)).not.toBe(computeFlowchartSemanticHash(d2));
  });

  it("kind 变化时 hash 改变", () => {
    const d1 = makeDoc();
    const d2 = makeDoc({
      nodes: [
        { id: "n1", kind: "process", label: "开始", position: { x: 0, y: 0 } },
        { id: "n2", kind: "process", label: "处理", position: { x: 0, y: 100 } },
        { id: "n3", kind: "end", label: "结束", position: { x: 0, y: 200 } },
      ],
    });
    expect(computeFlowchartSemanticHash(d1)).not.toBe(computeFlowchartSemanticHash(d2));
  });

  it("edge source/target 变化时 hash 改变", () => {
    const d1 = makeDoc();
    const d2 = makeDoc({
      edges: [
        { id: "e1", source: "n1", target: "n3" },
        { id: "e2", source: "n2", target: "n3" },
      ],
    });
    expect(computeFlowchartSemanticHash(d1)).not.toBe(computeFlowchartSemanticHash(d2));
  });

  it("edge label 变化时 hash 改变", () => {
    const d1 = makeDoc({
      edges: [
        { id: "e1", source: "n1", target: "n2", label: "通过" },
        { id: "e2", source: "n2", target: "n3" },
      ],
    });
    const d2 = makeDoc({
      edges: [
        { id: "e1", source: "n1", target: "n2", label: "拒绝" },
        { id: "e2", source: "n2", target: "n3" },
      ],
    });
    expect(computeFlowchartSemanticHash(d1)).not.toBe(computeFlowchartSemanticHash(d2));
  });

  it("direction 变化时 hash 改变", () => {
    const d1 = makeDoc();
    const d2 = makeDoc({ direction: "LR" });
    expect(computeFlowchartSemanticHash(d1)).not.toBe(computeFlowchartSemanticHash(d2));
  });

  it("输出格式 h 前缀 + 14 hex", () => {
    const h = computeFlowchartSemanticHash(makeDoc());
    expect(h).toMatch(/^h[0-9a-f]{14}$/);
  });
});

describe("collectFlowchartSemanticWarnings", () => {
  it("完整流程无警告", () => {
    expect(collectFlowchartSemanticWarnings(makeDoc())).toEqual([]);
  });

  it("缺少开始节点警告", () => {
    const doc = makeDoc({
      nodes: [
        { id: "n2", kind: "process", label: "处理", position: { x: 0, y: 100 } },
        { id: "n3", kind: "end", label: "结束", position: { x: 0, y: 200 } },
      ],
      edges: [{ id: "e2", source: "n2", target: "n3" }],
    });
    const w = collectFlowchartSemanticWarnings(doc);
    expect(w.some((x) => x.code === "no-start")).toBe(true);
  });

  it("开始节点有入边警告", () => {
    const doc: FlowchartDocument = {
      version: 1,
      direction: "TB",
      nodes: [
        { id: "s", kind: "start", label: "s", position: { x: 0, y: 0 } },
        { id: "p", kind: "process", label: "p", position: { x: 0, y: 100 } },
      ],
      edges: [
        { id: "e1", source: "s", target: "p" },
        { id: "e2", source: "p", target: "s" },
      ],
    };
    const w = collectFlowchartSemanticWarnings(doc);
    expect(w.some((x) => x.code === "start-has-incoming")).toBe(true);
    expect(w.some((x) => x.code === "has-cycle")).toBe(true);
  });

  it("判断节点多出边无标签警告", () => {
    const doc: FlowchartDocument = {
      version: 1,
      direction: "TB",
      nodes: [
        { id: "d", kind: "decision", label: "d", position: { x: 0, y: 0 } },
        { id: "a", kind: "end", label: "a", position: { x: 0, y: 100 } },
        { id: "b", kind: "end", label: "b", position: { x: 100, y: 100 } },
      ],
      edges: [
        { id: "e1", source: "d", target: "a" },
        { id: "e2", source: "d", target: "b" },
      ],
    };
    const w = collectFlowchartSemanticWarnings(doc);
    expect(w.some((x) => x.code === "decision-unlabeled-branch")).toBe(true);
  });

  it("循环作为警告而非硬错误", () => {
    const doc: FlowchartDocument = {
      version: 1,
      direction: "TB",
      nodes: [
        { id: "s", kind: "start", label: "s", position: { x: 0, y: 0 } },
        { id: "p", kind: "process", label: "p", position: { x: 0, y: 100 } },
        { id: "e", kind: "end", label: "e", position: { x: 0, y: 200 } },
      ],
      edges: [
        { id: "e1", source: "s", target: "p" },
        { id: "e2", source: "p", target: "e" },
        { id: "e3", source: "p", target: "p" },
      ],
    };
    const w = collectFlowchartSemanticWarnings(doc);
    expect(w.some((x) => x.code === "has-cycle")).toBe(true);
  });

  it("孤立节点警告", () => {
    const doc: FlowchartDocument = {
      version: 1,
      direction: "TB",
      nodes: [
        { id: "s", kind: "start", label: "s", position: { x: 0, y: 0 } },
        { id: "e", kind: "end", label: "e", position: { x: 0, y: 100 } },
        { id: "x", kind: "process", label: "x", position: { x: 200, y: 200 } },
      ],
      edges: [{ id: "e1", source: "s", target: "e" }],
    };
    const w = collectFlowchartSemanticWarnings(doc);
    expect(w.some((x) => x.code === "isolated-node")).toBe(true);
  });
});

describe("cloneFlowchartDocument", () => {
  it("深拷贝不影响原文档", () => {
    const original = makeDoc();
    const copy = cloneFlowchartDocument(original);
    copy.nodes[0].label = "改了";
    copy.nodes[0].position.x = 999;
    expect(original.nodes[0].label).toBe("开始");
    expect(original.nodes[0].position.x).toBe(0);
  });

  it("viewport 也深拷贝", () => {
    const original = makeDoc();
    const copy = cloneFlowchartDocument(original);
    if (copy.viewport && original.viewport) {
      copy.viewport.zoom = 5;
      expect(original.viewport.zoom).toBe(1);
    }
  });
});

describe("createBlankFlowchartDocument", () => {
  it("包含一个开始和一个结束节点，无连线", () => {
    const doc = createBlankFlowchartDocument();
    expect(doc.nodes).toHaveLength(2);
    expect(doc.nodes.find((n) => n.kind === "start")).toBeDefined();
    expect(doc.nodes.find((n) => n.kind === "end")).toBeDefined();
    expect(doc.edges).toEqual([]);
    expect(validateFlowchartDocument(doc).ok).toBe(true);
  });
});
