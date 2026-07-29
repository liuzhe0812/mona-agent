import { describe, it, expect } from "vitest";
import {
  readDecorations,
  writeDecorations,
  sanitizeDecorations,
  cleanupDanglingDecorations,
  validateSelection,
  summaryToNativeRange,
  storedArrowToNative,
  nativeArrowToStored,
  collectAllNodeIds,
  findNodeById,
  findParent,
  groupSelectionByBranch,
  generateDecorationId,
  EMPTY_DECORATIONS,
  MONA_MAP_KEY,
  MONA_MAP_VERSION,
  type MonaMapDecorations,
  type StoredArrow,
  type StoredSummary,
  type MindElixirArrow,
} from "./mindmap-decorations";
import { parseMindMap, serializeMindMap, type MindMapNode } from "./mindmap-outline";

/** 构造测试树：
 *   根
 *   ├── A
 *   │   ├── A1
 *   │   └── A2
 *   ├── B
 *   └── C
 *       └── C1
 */
const BASE_MARKDOWN = `# 根

- A
  - A1
  - A2
- B
- C
  - C1`;

function parseRoot(md: string = BASE_MARKDOWN): MindMapNode {
  const r = parseMindMap(md);
  if (!r.ok) throw new Error(`parse failed: ${r.message}`);
  return r.root;
}

// ============================================================
// 1. monaMap 解析、序列化和非法输入
// ============================================================

describe("readDecorations / writeDecorations 往返", () => {
  it("空装饰数据往返不变", () => {
    const root = parseRoot();
    const written = writeDecorations(root, EMPTY_DECORATIONS);
    const read = readDecorations(written);
    expect(read).toEqual(EMPTY_DECORATIONS);
  });

  it("包含 arrows / summaries / boundaries 的数据往返不变", () => {
    const decorations: MonaMapDecorations = {
      version: MONA_MAP_VERSION,
      arrows: [
        {
          id: "arrow-1",
          label: "联系",
          from: "node-a",
          to: "node-b",
          delta1: { x: 0, y: 0 },
          delta2: { x: 10, y: 10 },
        },
      ],
      summaries: [
        {
          id: "summary-1",
          label: "概要",
          nodeIds: ["node-a1", "node-a2"],
        },
      ],
      boundaries: [
        {
          id: "boundary-1",
          nodeIds: ["node-a1", "node-a2"],
        },
      ],
      boundaryLinks: [
        {
          id: "boundary-link-1",
          label: "联系",
          from: { kind: "boundary", id: "boundary-1" },
          to: { kind: "node", id: "node-b" },
          delta1: { x: 40, y: -60 },
          delta2: { x: -40, y: -60 },
        },
      ],
    };
    const root = parseRoot();
    // 把根节点 ID 改为测试用的 ID
    root.children[0].id = "node-a";
    root.children[0].children[0].id = "node-a1";
    root.children[0].children[1].id = "node-a2";
    root.children[1].id = "node-b";

    const written = writeDecorations(root, decorations);
    const read = readDecorations(written);
    expect(read).toEqual(decorations);
  });

  it("根节点无 metadata 时返回空装饰", () => {
    const root = parseRoot();
    const read = readDecorations(root);
    expect(read).toEqual(EMPTY_DECORATIONS);
  });

  it("monaMap 为非对象时降级为空装饰", () => {
    const root = parseRoot();
    root.metadata = { [MONA_MAP_KEY]: "not-an-object" };
    expect(readDecorations(root)).toEqual(EMPTY_DECORATIONS);
  });

  it("monaMap 为数组时降级为空装饰", () => {
    const root = parseRoot();
    root.metadata = { [MONA_MAP_KEY]: [] };
    expect(readDecorations(root)).toEqual(EMPTY_DECORATIONS);
  });

  it("version 不为 1 时降级为空装饰", () => {
    const root = parseRoot();
    root.metadata = { [MONA_MAP_KEY]: { version: 999, arrows: [], summaries: [], boundaries: [] } };
    expect(readDecorations(root)).toEqual(EMPTY_DECORATIONS);
  });

  it("非数组字段按空数组处理", () => {
    const root = parseRoot();
    root.metadata = {
      [MONA_MAP_KEY]: {
        version: MONA_MAP_VERSION,
        arrows: "not-array",
        summaries: null,
        boundaries: 123,
      },
    };
    expect(readDecorations(root)).toEqual(EMPTY_DECORATIONS);
  });
});

describe("sanitizeDecorations 非法输入", () => {
  it("丢弃缺字段的 arrow", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    root.children[1].id = "b";
    const raw = {
      version: MONA_MAP_VERSION,
      arrows: [
        // 缺 id
        { label: "x", from: "a", to: "b", delta1: { x: 0, y: 0 }, delta2: { x: 0, y: 0 } },
        // 缺 from
        { id: "ar-2", label: "x", to: "b", delta1: { x: 0, y: 0 }, delta2: { x: 0, y: 0 } },
        // from 引用不存在的节点
        { id: "ar-3", label: "x", from: "nope", to: "b", delta1: { x: 0, y: 0 }, delta2: { x: 0, y: 0 } },
        // from === to
        { id: "ar-4", label: "x", from: "a", to: "a", delta1: { x: 0, y: 0 }, delta2: { x: 0, y: 0 } },
        // 合法
        { id: "ar-5", label: "ok", from: "a", to: "b", delta1: { x: 0, y: 0 }, delta2: { x: 0, y: 0 } },
      ],
      summaries: [],
      boundaries: [],
      boundaryLinks: [],
    };
    const result = sanitizeDecorations(root, raw);
    expect(result.arrows).toHaveLength(1);
    expect(result.arrows[0].id).toBe("ar-5");
  });

  it("丢弃缺字段的 summary", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    root.children[1].id = "b";
    const raw = {
      version: MONA_MAP_VERSION,
      arrows: [],
      summaries: [
        // 缺 id
        { label: "x", nodeIds: ["a"] },
        // nodeIds 为空
        { id: "s-2", label: "x", nodeIds: [] },
        // nodeIds 引用不存在的节点
        { id: "s-3", label: "x", nodeIds: ["nope"] },
        // 合法
        { id: "s-4", label: "ok", nodeIds: ["a", "b"] },
      ],
      boundaries: [],
    };
    const result = sanitizeDecorations(root, raw);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].id).toBe("s-4");
  });

  it("丢弃缺字段的 boundary", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    root.children[1].id = "b";
    const raw = {
      version: MONA_MAP_VERSION,
      arrows: [],
      summaries: [],
      boundaries: [
        // 缺 id
        { nodeIds: ["a"] },
        // nodeIds 为空
        { id: "b-2", nodeIds: [] },
        // nodeIds 引用不存在的节点
        { id: "b-3", nodeIds: ["nope"] },
        // 合法
        { id: "b-4", nodeIds: ["a", "b"] },
      ],
    };
    const result = sanitizeDecorations(root, raw);
    expect(result.boundaries).toHaveLength(1);
    expect(result.boundaries[0].id).toBe("b-4");
  });

  it("仅保留有效的外框—节点联系", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    const raw = {
      version: MONA_MAP_VERSION,
      arrows: [],
      summaries: [],
      boundaries: [{ id: "boundary-1", nodeIds: ["a"] }],
      boundaryLinks: [
        {
          id: "link-1",
          label: "联系",
          from: { kind: "boundary", id: "boundary-1" },
          to: { kind: "node", id: "a" },
        },
        {
          id: "link-2",
          label: "非法",
          from: { kind: "node", id: "a" },
          to: { kind: "node", id: "a" },
        },
      ],
    };
    expect(sanitizeDecorations(root, raw).boundaryLinks).toEqual([
      raw.boundaryLinks[0],
    ]);
  });

  it("arrow delta 非法时丢弃", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    root.children[1].id = "b";
    const raw = {
      version: MONA_MAP_VERSION,
      arrows: [
        // delta1 缺 y
        { id: "ar-1", label: "x", from: "a", to: "b", delta1: { x: 0 }, delta2: { x: 0, y: 0 } },
        // delta2 为 null
        { id: "ar-2", label: "x", from: "a", to: "b", delta1: { x: 0, y: 0 }, delta2: null },
        // 合法
        { id: "ar-3", label: "ok", from: "a", to: "b", delta1: { x: 0, y: 0 }, delta2: { x: 0, y: 0 } },
      ],
      summaries: [],
      boundaries: [],
      boundaryLinks: [],
    };
    const result = sanitizeDecorations(root, raw);
    expect(result.arrows).toHaveLength(1);
    expect(result.arrows[0].id).toBe("ar-3");
  });
});

// ============================================================
// 2. 联系引用失效清理
// ============================================================

describe("cleanupDanglingDecorations - 联系引用清理", () => {
  it("删除节点后清理引用失效的 arrow", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    root.children[1].id = "b"; // B 将被删除
    root.children[2].id = "c"; // C 保留
    const decorations: MonaMapDecorations = {
      version: MONA_MAP_VERSION,
      arrows: [
        // a→c：两个节点都存在，保留
        { id: "ar-1", label: "ok", from: "a", to: "c", delta1: { x: 0, y: 0 }, delta2: { x: 0, y: 0 } },
        // a→b：b 被删除，清理
        { id: "ar-2", label: "dangling", from: "a", to: "b", delta1: { x: 0, y: 0 }, delta2: { x: 0, y: 0 } },
      ],
      summaries: [],
      boundaries: [],
      boundaryLinks: [],
    };
    // 模拟删除 B 节点
    const newRoot: MindMapNode = { ...root, children: [root.children[0], root.children[2]] };
    const cleaned = cleanupDanglingDecorations(decorations, newRoot);
    expect(cleaned.arrows).toHaveLength(1);
    expect(cleaned.arrows[0].id).toBe("ar-1");
  });

  it("from === to 的 arrow 被清理", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    const decorations: MonaMapDecorations = {
      version: MONA_MAP_VERSION,
      arrows: [
        { id: "ar-1", label: "self", from: "a", to: "a", delta1: { x: 0, y: 0 }, delta2: { x: 0, y: 0 } },
      ],
      summaries: [],
      boundaries: [],
      boundaryLinks: [],
    };
    const cleaned = cleanupDanglingDecorations(decorations, root);
    expect(cleaned.arrows).toHaveLength(0);
  });

  it("无清理时返回原对象", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    root.children[1].id = "b";
    const decorations: MonaMapDecorations = {
      version: MONA_MAP_VERSION,
      arrows: [
        { id: "ar-1", label: "ok", from: "a", to: "b", delta1: { x: 0, y: 0 }, delta2: { x: 0, y: 0 } },
      ],
      summaries: [],
      boundaries: [],
      boundaryLinks: [],
    };
    const cleaned = cleanupDanglingDecorations(decorations, root);
    expect(cleaned).toBe(decorations);
  });
});

// ============================================================
// 3. 概要稳定 ID 到原生索引范围转换
// ============================================================

describe("summaryToNativeRange", () => {
  it("连续选区正确转换为 parent/start/end", () => {
    const root = parseRoot();
    // A 的子节点 A1, A2
    const a = root.children[0];
    const a1 = a.children[0];
    const a2 = a.children[1];
    const summary: StoredSummary = {
      id: "s-1",
      label: "概要",
      nodeIds: [a1.id, a2.id],
    };
    const range = summaryToNativeRange(summary, root);
    expect(range).toEqual({ parent: a.id, start: 0, end: 1 });
  });

  it("节点移动后按 nodeIds 重新计算索引", () => {
    const root = parseRoot();
    const a = root.children[0];
    const a1 = a.children[0];
    const a2 = a.children[1];
    const summary: StoredSummary = {
      id: "s-1",
      label: "概要",
      nodeIds: [a2.id, a1.id], // 故意反序
    };
    const range = summaryToNativeRange(summary, root);
    // 应按索引排序，start=0, end=1
    expect(range).toEqual({ parent: a.id, start: 0, end: 1 });
  });

  it("选区已失效（节点不存在）返回 null", () => {
    const root = parseRoot();
    const summary: StoredSummary = {
      id: "s-1",
      label: "概要",
      nodeIds: ["nonexistent"],
    };
    expect(summaryToNativeRange(summary, root)).toBeNull();
  });

  it("跨父级选区返回 null", () => {
    const root = parseRoot();
    const a1 = root.children[0].children[0]; // A 的子节点
    const b = root.children[1]; // B 是根的子节点
    const summary: StoredSummary = {
      id: "s-1",
      label: "概要",
      nodeIds: [a1.id, b.id],
    };
    expect(summaryToNativeRange(summary, root)).toBeNull();
  });

  it("非连续选区返回 null", () => {
    // 在同一父级下制造非连续：需要 3+ 个子节点
    const md = `# 根

- A
  - A1
  - A2
  - A3
  - A4`;
    const r = parseMindMap(md);
    if (!r.ok) throw new Error("parse failed");
    const newRoot = r.root;
    const parent = newRoot.children[0];
    const a1Node = parent.children[0]; // index 0
    const a3Node = parent.children[2]; // index 2（跳过 A2）
    const summary: StoredSummary = {
      id: "s-1",
      label: "概要",
      nodeIds: [a1Node.id, a3Node.id],
    };
    expect(summaryToNativeRange(summary, newRoot)).toBeNull();
  });
});

// ============================================================
// 4. 非连续和跨父级选区拒绝
// ============================================================

describe("validateSelection", () => {
  it("空选区无效", () => {
    const root = parseRoot();
    const v = validateSelection([], root);
    expect(v.valid).toBe(false);
  });

  it("包含根节点无效", () => {
    const root = parseRoot();
    const v = validateSelection([root.id], root);
    expect(v.valid).toBe(false);
    expect(v.includesRoot).toBe(true);
  });

  it("单选非根节点有效", () => {
    const root = parseRoot();
    const a = root.children[0];
    const v = validateSelection([a.id], root);
    expect(v.valid).toBe(true);
    expect(v.parentId).toBe(root.id);
    expect(v.indices).toEqual([0]);
    expect(v.continuous).toBe(true);
  });

  it("同一父级下连续多选有效", () => {
    const root = parseRoot();
    const a1 = root.children[0].children[0];
    const a2 = root.children[0].children[1];
    const v = validateSelection([a1.id, a2.id], root);
    expect(v.valid).toBe(true);
    expect(v.parentId).toBe(root.children[0].id);
    expect(v.indices).toEqual([0, 1]);
    expect(v.continuous).toBe(true);
  });

  it("同一父级下非连续多选无效", () => {
    const md = `# 根

- A
  - A1
  - A2
  - A3`;
    const r = parseMindMap(md);
    if (!r.ok) throw new Error("parse failed");
    const root = r.root;
    const a1 = root.children[0].children[0];
    const a3 = root.children[0].children[2];
    const v = validateSelection([a1.id, a3.id], root);
    expect(v.valid).toBe(false);
    expect(v.continuous).toBe(false);
  });

  it("跨父级多选无效", () => {
    const root = parseRoot();
    const a = root.children[0];
    const b = root.children[1];
    const v = validateSelection([a.id, b.id], root);
    // A 和 B 是根的子节点，同一父级且连续，应该有效
    expect(v.valid).toBe(true);
  });

  it("跨父级多选无效（真正跨层）", () => {
    const root = parseRoot();
    const a1 = root.children[0].children[0]; // A 的子节点
    const b = root.children[1]; // 根的子节点
    const v = validateSelection([a1.id, b.id], root);
    expect(v.valid).toBe(false);
  });

  it("不存在的节点无效", () => {
    const root = parseRoot();
    const v = validateSelection(["nonexistent"], root);
    expect(v.valid).toBe(false);
  });
});

describe("groupSelectionByBranch", () => {
  it("同一分支的非连续选区扩展为首尾之间的完整范围", () => {
    const md = `# 根

- A
  - A1
  - A2
  - A3`;
    const r = parseMindMap(md);
    if (!r.ok) throw new Error("parse failed");
    const [a1, a2, a3] = r.root.children[0].children;

    expect(groupSelectionByBranch([a1.id, a3.id], r.root)).toEqual([
      {
        parentId: r.root.children[0].id,
        start: 0,
        end: 2,
        nodeIds: [a1.id, a2.id, a3.id],
      },
    ]);
  });

  it("不同分支分别生成分组", () => {
    const root = parseRoot();
    const a1 = root.children[0].children[0];
    const c1 = root.children[2].children[0];

    expect(groupSelectionByBranch([a1.id, c1.id], root)).toEqual([
      {
        parentId: root.children[0].id,
        start: 0,
        end: 0,
        nodeIds: [a1.id],
      },
      {
        parentId: root.children[2].id,
        start: 0,
        end: 0,
        nodeIds: [c1.id],
      },
    ]);
  });

  it("忽略根节点、重复节点和不存在的节点", () => {
    const root = parseRoot();
    const a = root.children[0];

    expect(
      groupSelectionByBranch([root.id, a.id, a.id, "missing"], root),
    ).toEqual([
      {
        parentId: root.id,
        start: 0,
        end: 0,
        nodeIds: [a.id],
      },
    ]);
  });
});

// ============================================================
// 5. 外框数据清理
// ============================================================

describe("cleanupDanglingDecorations - 外框引用清理", () => {
  it("删除节点后清理引用失效的 boundary", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    root.children[0].children[0].id = "a1";
    root.children[1].id = "b"; // 将被删除
    const decorations: MonaMapDecorations = {
      version: MONA_MAP_VERSION,
      arrows: [],
      summaries: [],
      boundaries: [
        // b-1 只引用 b，b 被删除后全部失效，应删除
        { id: "b-1", nodeIds: ["b"] },
        // b-2 只引用 a1，应保留
        { id: "b-2", nodeIds: ["a1"] },
      ],
      boundaryLinks: [],
    };
    // 模拟删除 B 节点
    const newRoot: MindMapNode = { ...root, children: [root.children[0], root.children[2]] };
    const cleaned = cleanupDanglingDecorations(decorations, newRoot);
    // b-1 全部失效，删除；b-2 保留
    expect(cleaned.boundaries).toHaveLength(1);
    expect(cleaned.boundaries[0].id).toBe("b-2");
  });

  it("部分引用失效的 boundary 保留剩余有效节点", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    root.children[0].children[0].id = "a1";
    root.children[1].id = "b"; // 将被删除
    const decorations: MonaMapDecorations = {
      version: MONA_MAP_VERSION,
      arrows: [],
      summaries: [],
      boundaries: [
        { id: "b-1", nodeIds: ["a", "b", "a1"] },
      ],
      boundaryLinks: [],
    };
    // 模拟删除 B 节点
    const newRoot: MindMapNode = { ...root, children: [root.children[0], root.children[2]] };
    const cleaned = cleanupDanglingDecorations(decorations, newRoot);
    expect(cleaned.boundaries).toHaveLength(1);
    expect(cleaned.boundaries[0].nodeIds).toEqual(["a", "a1"]);
  });

  it("节点或外框失效时清理对应联系", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    root.children[1].id = "b";
    root.children[2].id = "c";
    const decorations: MonaMapDecorations = {
      version: MONA_MAP_VERSION,
      arrows: [],
      summaries: [],
      boundaries: [{ id: "boundary-1", nodeIds: ["a"] }],
      boundaryLinks: [
        {
          id: "keep",
          label: "联系",
          from: { kind: "boundary", id: "boundary-1" },
          to: { kind: "node", id: "c" },
        },
        {
          id: "missing-node",
          label: "联系",
          from: { kind: "boundary", id: "boundary-1" },
          to: { kind: "node", id: "b" },
        },
        {
          id: "missing-boundary",
          label: "联系",
          from: { kind: "boundary", id: "boundary-missing" },
          to: { kind: "node", id: "a" },
        },
      ],
    };
    const newRoot: MindMapNode = {
      ...root,
      children: [root.children[0], root.children[2]],
    };
    expect(cleanupDanglingDecorations(decorations, newRoot).boundaryLinks).toEqual([
      decorations.boundaryLinks[0],
    ]);
  });
});

// ============================================================
// 6. 概要数据清理
// ============================================================

describe("cleanupDanglingDecorations - 概要引用清理", () => {
  it("删除节点后清理引用失效的 summary", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    root.children[0].children[0].id = "a1";
    root.children[0].children[1].id = "a2";
    root.children[1].id = "b"; // 将被删除
    const decorations: MonaMapDecorations = {
      version: MONA_MAP_VERSION,
      arrows: [],
      summaries: [
        { id: "s-1", label: "ok", nodeIds: ["a1", "a2"] },
        { id: "s-2", label: "dangling", nodeIds: ["b"] },
        { id: "s-3", label: "partial", nodeIds: ["a1", "b"] },
      ],
      boundaries: [],
      boundaryLinks: [],
    };
    // 模拟删除 B 节点
    const newRoot: MindMapNode = { ...root, children: [root.children[0], root.children[2]] };
    const cleaned = cleanupDanglingDecorations(decorations, newRoot);
    // s-1 完整保留
    // s-2 全部失效，删除
    // s-3 部分失效，保留剩余
    expect(cleaned.summaries).toHaveLength(2);
    const s1 = cleaned.summaries.find((s) => s.id === "s-1");
    const s3 = cleaned.summaries.find((s) => s.id === "s-3");
    expect(s1?.nodeIds).toEqual(["a1", "a2"]);
    expect(s3?.nodeIds).toEqual(["a1"]);
  });
});

// ============================================================
// 7. Arrow 转换
// ============================================================

describe("storedArrowToNative / nativeArrowToStored 转换", () => {
  it("StoredArrow 转 native 再转回往返不变", () => {
    const stored: StoredArrow = {
      id: "ar-1",
      label: "联系",
      from: "node-a",
      to: "node-b",
      delta1: { x: 10, y: 20 },
      delta2: { x: 30, y: 40 },
      bidirectional: true,
      style: { stroke: "#f00", strokeWidth: 2, labelColor: "#0f0" },
    };
    const native = storedArrowToNative(stored);
    const back = nativeArrowToStored(native);
    expect(back).toEqual(stored);
  });

  it("native arrow 缺 delta 时补 {x:0,y:0}", () => {
    const native: MindElixirArrow = {
      id: "ar-1",
      label: "x",
      from: "a",
      to: "b",
    };
    const stored = nativeArrowToStored(native);
    expect(stored.delta1).toEqual({ x: 0, y: 0 });
    expect(stored.delta2).toEqual({ x: 0, y: 0 });
  });

  it("label 为 undefined 时转为空字符串", () => {
    const native: MindElixirArrow = {
      id: "ar-1",
      label: undefined as unknown as string,
      from: "a",
      to: "b",
      delta1: { x: 0, y: 0 },
      delta2: { x: 0, y: 0 },
    };
    const stored = nativeArrowToStored(native);
    expect(stored.label).toBe("");
  });
});

// ============================================================
// 8. 旧格式导图兼容
// ============================================================

describe("旧格式导图兼容", () => {
  it("无 metadata 的根节点读取装饰数据返回空", () => {
    const md = `# 根

- A
- B`;
    const root = parseRoot(md);
    const decorations = readDecorations(root);
    expect(decorations).toEqual(EMPTY_DECORATIONS);
  });

  it("有其他 metadata 但无 monaMap 时返回空", () => {
    const root = parseRoot();
    root.metadata = { otherKey: "value" };
    const decorations = readDecorations(root);
    expect(decorations).toEqual(EMPTY_DECORATIONS);
  });

  it("序列化后 monaMap 保留在根节点 metadata 中", () => {
    const root = parseRoot();
    root.children[0].id = "a";
    root.children[1].id = "b";
    const decorations: MonaMapDecorations = {
      version: MONA_MAP_VERSION,
      arrows: [
        { id: "ar-1", label: "联系", from: "a", to: "b", delta1: { x: 0, y: 0 }, delta2: { x: 0, y: 0 } },
      ],
      summaries: [],
      boundaries: [],
      boundaryLinks: [],
    };
    const written = writeDecorations(root, decorations);
    const md = serializeMindMap(written);
    // 重新解析
    const reparsed = parseMindMap(md);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      const read = readDecorations(reparsed.root);
      expect(read.arrows).toHaveLength(1);
      expect(read.arrows[0].id).toBe("ar-1");
    }
  });
});

// ============================================================
// 9. 辅助函数
// ============================================================

describe("辅助函数", () => {
  it("collectAllNodeIds 收集所有节点 ID", () => {
    const root = parseRoot();
    const ids = collectAllNodeIds(root);
    // 根 + A + A1 + A2 + B + C + C1 = 7
    expect(ids.size).toBe(7);
  });

  it("findNodeById 找到节点", () => {
    const root = parseRoot();
    const a = root.children[0];
    expect(findNodeById(root, a.id)).toBe(a);
    expect(findNodeById(root, "nonexistent")).toBeNull();
  });

  it("findParent 找到父节点", () => {
    const root = parseRoot();
    const a = root.children[0];
    const a1 = a.children[0];
    expect(findParent(root, a1.id)?.id).toBe(a.id);
    expect(findParent(root, root.id)).toBeNull();
  });

  it("generateDecorationId 生成带前缀的 ID", () => {
    const id = generateDecorationId("arrow");
    expect(id.startsWith("arrow-")).toBe(true);
    const id2 = generateDecorationId("boundary");
    expect(id2.startsWith("boundary-")).toBe(true);
    // 两次调用生成不同 ID
    expect(id).not.toBe(generateDecorationId("arrow"));
  });
});
