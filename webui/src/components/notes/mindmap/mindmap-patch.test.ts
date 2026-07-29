import { describe, it, expect } from "vitest";
import {
  applyPatch,
  parsePatch,
  type MindMapPatch,
} from "./mindmap-patch";
import {
  parseMindMap,
  computeBaseHash,
  type MindMapNode,
} from "./mindmap-outline";

/** 构造一棵固定的测试树：
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

function makePatch(ops: MindMapPatch["ops"], baseMarkdown: string = BASE_MARKDOWN): MindMapPatch {
  return { baseHash: computeBaseHash(baseMarkdown), ops };
}

function parseRoot(md: string): MindMapNode {
  const r = parseMindMap(md);
  if (!r.ok) throw new Error(`parse failed: ${r.message}`);
  return r.root;
}

describe("parsePatch", () => {
  it("解析合法 patch", () => {
    const json = JSON.stringify({
      baseHash: "habc",
      ops: [
        { name: "addChild", path: [0], topic: "新子", expectedTopic: "A" },
      ],
    });
    const r = parsePatch(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch.baseHash).toBe("habc");
      expect(r.patch.ops).toHaveLength(1);
      expect(r.patch.ops[0].name).toBe("addChild");
    }
  });

  it("JSON 格式错误时失败", () => {
    const r = parsePatch("not json {");
    expect(r.ok).toBe(false);
  });

  it("缺少 baseHash 时失败", () => {
    const r = parsePatch(JSON.stringify({ ops: [] }));
    expect(r.ok).toBe(false);
  });

  it("缺少 ops 数组时失败", () => {
    const r = parsePatch(JSON.stringify({ baseHash: "h" }));
    expect(r.ok).toBe(false);
  });

  it("未知 op name 时失败", () => {
    const r = parsePatch(JSON.stringify({
      baseHash: "h",
      ops: [{ name: "unknown", path: [0] }],
    }));
    expect(r.ok).toBe(false);
  });

  it("addChild 缺少 topic 时失败", () => {
    const r = parsePatch(JSON.stringify({
      baseHash: "h",
      ops: [{ name: "addChild", path: [0] }],
    }));
    expect(r.ok).toBe(false);
  });

  it("moveNode 缺少 from/to 时失败", () => {
    const r = parsePatch(JSON.stringify({
      baseHash: "h",
      ops: [{ name: "moveNode", path: [0] }],
    }));
    expect(r.ok).toBe(false);
  });

  it("path 包含负数或非整数时失败", () => {
    const r = parsePatch(JSON.stringify({
      baseHash: "h",
      ops: [{ name: "addChild", path: [-1], topic: "x" }],
    }));
    expect(r.ok).toBe(false);
  });
});

describe("applyPatch - addChild", () => {
  it("在指定节点下追加子节点", () => {
    const patch = makePatch([
      { name: "addChild", path: [0], topic: "A3", expectedTopic: "A" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    const a = root.children[0];
    expect(a.children).toHaveLength(3);
    expect(a.children[2].topic).toBe("A3");
  });

  it("在根节点下追加子节点", () => {
    const patch = makePatch([
      { name: "addChild", path: [], topic: "D" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.children).toHaveLength(4);
    expect(root.children[3].topic).toBe("D");
  });

  it("expectedTopic 不匹配时拒绝应用", () => {
    const patch = makePatch([
      { name: "addChild", path: [0], topic: "X", expectedTopic: "B" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });

  it("path 不存在时拒绝应用", () => {
    const patch = makePatch([
      { name: "addChild", path: [99], topic: "X" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });
});

describe("applyPatch - insertSibling", () => {
  it("在指定节点后插入同级", () => {
    const patch = makePatch([
      { name: "insertSibling", path: [1], topic: "B+", expectedTopic: "B" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.children).toHaveLength(4);
    expect(root.children[1].topic).toBe("B+");
    expect(root.children[2].topic).toBe("B");
  });

  it("在末尾位置插入（index === length）", () => {
    const patch = makePatch([
      { name: "insertSibling", path: [3], topic: "C+" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.children).toHaveLength(4);
    expect(root.children[3].topic).toBe("C+");
  });

  it("在二级节点前插入同级", () => {
    const patch = makePatch([
      { name: "insertSibling", path: [0, 0], topic: "A0", expectedTopic: "A1" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.children[0].children).toHaveLength(3);
    expect(root.children[0].children[0].topic).toBe("A0");
    expect(root.children[0].children[1].topic).toBe("A1");
  });

  it("拒绝在根节点插入同级", () => {
    const patch = makePatch([
      { name: "insertSibling", path: [], topic: "X" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });

  it("索引越界时拒绝", () => {
    const patch = makePatch([
      { name: "insertSibling", path: [99], topic: "X" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });
});

describe("applyPatch - updateTopic", () => {
  it("修改节点文本", () => {
    const patch = makePatch([
      { name: "updateTopic", path: [0, 0], topic: "A1 改", expectedTopic: "A1" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.children[0].children[0].topic).toBe("A1 改");
  });

  it("修改根节点文本", () => {
    const patch = makePatch([
      { name: "updateTopic", path: [], topic: "新根" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.topic).toBe("新根");
  });

  it("expectedTopic 不匹配时拒绝", () => {
    const patch = makePatch([
      { name: "updateTopic", path: [0], topic: "X", expectedTopic: "B" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });
});

describe("applyPatch - removeNode", () => {
  it("删除叶子节点", () => {
    const patch = makePatch([
      { name: "removeNode", path: [0, 0], expectedTopic: "A1" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.children[0].children).toHaveLength(1);
    expect(root.children[0].children[0].topic).toBe("A2");
  });

  it("删除带子节点的分支", () => {
    const patch = makePatch([
      { name: "removeNode", path: [2], expectedTopic: "C" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.children).toHaveLength(2);
    expect(root.children.map((c) => c.topic)).toEqual(["A", "B"]);
  });

  it("拒绝删除根节点", () => {
    const patch = makePatch([
      { name: "removeNode", path: [] },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });

  it("expectedTopic 不匹配时拒绝", () => {
    const patch = makePatch([
      { name: "removeNode", path: [0], expectedTopic: "B" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });
});

describe("applyPatch - moveNode", () => {
  it("移动叶子节点到另一父下", () => {
    const patch = makePatch([
      { name: "moveNode", from: [0, 0], to: [1], expectedTopic: "A1" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    // A 只剩 A2
    expect(root.children[0].children).toHaveLength(1);
    expect(root.children[0].children[0].topic).toBe("A2");
    // B 下增加 A1
    expect(root.children[1].children).toHaveLength(1);
    expect(root.children[1].children[0].topic).toBe("A1");
  });

  it("移动带子节点的分支", () => {
    const patch = makePatch([
      { name: "moveNode", from: [2], to: [0], expectedTopic: "C" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    // 根下只剩 A、B
    expect(root.children).toHaveLength(2);
    expect(root.children.map((c) => c.topic)).toEqual(["A", "B"]);
    // A 下增加 C 及其子树
    const a = root.children[0];
    expect(a.children.map((c) => c.topic)).toEqual(["A1", "A2", "C"]);
    expect(a.children[2].children[0].topic).toBe("C1");
  });

  it("拒绝移动到自身下", () => {
    const patch = makePatch([
      { name: "moveNode", from: [0], to: [0], expectedTopic: "A" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });

  it("拒绝移动到自身子孙下", () => {
    const patch = makePatch([
      { name: "moveNode", from: [0], to: [0, 0], expectedTopic: "A" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });

  it("拒绝移动根节点", () => {
    const patch = makePatch([
      { name: "moveNode", from: [], to: [0] },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });

  it("源路径不存在时拒绝", () => {
    const patch = makePatch([
      { name: "moveNode", from: [99], to: [0] },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });

  it("目标路径不存在时拒绝", () => {
    const patch = makePatch([
      { name: "moveNode", from: [0], to: [99] },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });
});

describe("applyPatch - 原子性与多 op 顺序", () => {
  it("多个 op 顺序应用，路径在新树上正确计算", () => {
    // op1: 给 A 加子节点 A3 → A 下变成 [A1, A2, A3]
    // op2: 在 [0, 2] 之前插入同级 → 应在 A3 之前插入
    const patch = makePatch([
      { name: "addChild", path: [0], topic: "A3", expectedTopic: "A" },
      { name: "insertSibling", path: [0, 2], topic: "A2.5", expectedTopic: "A3" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    const a = root.children[0];
    expect(a.children.map((c) => c.topic)).toEqual(["A1", "A2", "A2.5", "A3"]);
  });

  it("单个 op 失败时整批不应用（原子性）", () => {
    // op1 合法（addChild），op2 非法（path 不存在）
    const patch = makePatch([
      { name: "addChild", path: [0], topic: "A3", expectedTopic: "A" },
      { name: "updateTopic", path: [99], topic: "X" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failedOpIndex).toBe(1);
    // 原 markdown 必须保持不变
    const root = parseRoot(BASE_MARKDOWN);
    expect(root.children[0].children).toHaveLength(2);
  });

  it("baseHash 不匹配时拒绝应用整批", () => {
    const patch: MindMapPatch = {
      baseHash: "hwrong",
      ops: [{ name: "addChild", path: [0], topic: "X" }],
    };
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(false);
  });

  it("应用后 markdown 可重新解析为相同结构", () => {
    const patch = makePatch([
      { name: "addChild", path: [0], topic: "A3", expectedTopic: "A" },
      { name: "updateTopic", path: [1], topic: "B 改", expectedTopic: "B" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.children[0].children[2].topic).toBe("A3");
    expect(root.children[1].topic).toBe("B 改");
    // baseHash 应该不同于原 markdown
    expect(computeBaseHash(r.markdown)).not.toBe(computeBaseHash(BASE_MARKDOWN));
  });

  it("空 ops 数组等价于无操作", () => {
    const patch = makePatch([]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 序列化结果应该与原 markdown 结构等价（serializeMindMap 不保留空行，属设计行为）
    const root = parseRoot(r.markdown);
    const expectedRoot = parseRoot(BASE_MARKDOWN);
    expect(root.children.map((c) => c.topic)).toEqual(
      expectedRoot.children.map((c) => c.topic),
    );
    expect(r.appliedCount).toBe(0);
  });
});

describe("applyPatch - 路径漂移场景", () => {
  it("先删除前一个节点，后续 op 路径自动调整", () => {
    // 原始: A(0), B(1), C(2)
    // op1: 删除 A → B 变成 [0], C 变成 [1]
    // op2: 在新的 [0] (B) 下加子节点
    const patch = makePatch([
      { name: "removeNode", path: [0], expectedTopic: "A" },
      { name: "addChild", path: [0], topic: "B1", expectedTopic: "B" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.children).toHaveLength(2);
    expect(root.children[0].topic).toBe("B");
    expect(root.children[0].children[0].topic).toBe("B1");
    expect(root.children[1].topic).toBe("C");
  });

  it("先 insertSibling 在前，后续 op 路径自动后移", () => {
    // 原始: A(0), B(1), C(2)
    // op1: 在 [0] 前插入 A' → A'(0), A(1), B(2), C(3)
    // op2: 修改原 B（现在路径为 [2]）的文本
    const patch = makePatch([
      { name: "insertSibling", path: [0], topic: "A'", expectedTopic: "A" },
      { name: "updateTopic", path: [2], topic: "B 改", expectedTopic: "B" },
    ]);
    const r = applyPatch(BASE_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.children.map((c) => c.topic)).toEqual(["A'", "A", "B 改", "C"]);
  });
});

// ============================================================================
// patch v2 测试（基于稳定节点 ID 定位，见 docs/plans/mindmap-dev-plan.md §7.4）
// ============================================================================

describe("patch v2 - 基于 ID 定位", () => {
  // 构造带稳定 ID 的 markdown
  const V2_MARKDOWN = `# 根 <!-- mona:mindmap-v1 {"id":"root-id"} -->
- A <!-- mona:mindmap-v1 {"id":"a-id","note":"A 的备注","icons":["star"]} -->
  - A1 <!-- mona:mindmap-v1 {"id":"a1-id","hyperLink":"https://x.com"} -->
- B <!-- mona:mindmap-v1 {"id":"b-id"} -->`;

  const v2BaseHash = computeBaseHash(V2_MARKDOWN);

  const makeV2Patch = (ops: MindMapPatch["ops"]): MindMapPatch => ({
    version: 2,
    baseHash: v2BaseHash,
    ops,
  });

  const parseRoot = (md: string) => {
    const r = parseMindMap(md);
    if (!r.ok) throw new Error(`parse failed: ${r.message}`);
    return r.root;
  };

  it("v2 addChild 通过 parentId 添加子节点", () => {
    const patch = makeV2Patch([
      { name: "addChild", parentId: "b-id", topic: "B 的新子" },
    ]);
    const r = applyPatch(V2_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    const b = root.children.find((c) => c.id === "b-id")!;
    expect(b.children.map((c) => c.topic)).toContain("B 的新子");
  });

  it("v2 insertSibling 在指定节点后插入同级", () => {
    const patch = makeV2Patch([
      { name: "insertSibling", nodeId: "a-id", topic: "A 的兄弟" },
    ]);
    const r = applyPatch(V2_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    const topics = root.children.map((c) => c.topic);
    expect(topics).toEqual(["A", "A 的兄弟", "B"]);
  });

  it("v2 updateTopic 通过 nodeId 修改文本", () => {
    const patch = makeV2Patch([
      { name: "updateTopic", nodeId: "a1-id", topic: "A1 改名" },
    ]);
    const r = applyPatch(V2_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    const a1 = root.children[0].children[0];
    expect(a1.topic).toBe("A1 改名");
    // ID 不变
    expect(a1.id).toBe("a1-id");
  });

  it("v2 removeNode 通过 nodeId 删除", () => {
    const patch = makeV2Patch([
      { name: "removeNode", nodeId: "b-id" },
    ]);
    const r = applyPatch(V2_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.children.map((c) => c.id)).not.toContain("b-id");
  });

  it("v2 moveNode 通过 fromId/toParentId 移动", () => {
    const patch = makeV2Patch([
      { name: "moveNode", fromId: "a1-id", toParentId: "b-id" },
    ]);
    const r = applyPatch(V2_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    const a = root.children.find((c) => c.id === "a-id")!;
    const b = root.children.find((c) => c.id === "b-id")!;
    expect(a.children.map((c) => c.id)).not.toContain("a1-id");
    expect(b.children.map((c) => c.id)).toContain("a1-id");
  });

  it("v2 patch 保留未修改节点的扩展字段（note/icons/hyperLink）", () => {
    // 只修改 B 的文本，不应影响 A 和 A1 的扩展字段
    const patch = makeV2Patch([
      { name: "updateTopic", nodeId: "b-id", topic: "B 改名" },
    ]);
    const r = applyPatch(V2_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    const a = root.children.find((c) => c.id === "a-id")!;
    const a1 = a.children[0];
    expect(a.note).toBe("A 的备注");
    expect(a.icons).toEqual(["star"]);
    expect(a1.hyperLink).toBe("https://x.com");
  });

  it("v2 不根据 topic 猜测目标节点，ID 不存在时拒绝", () => {
    const patch = makeV2Patch([
      { name: "updateTopic", nodeId: "不存在的-id", topic: "x" },
    ]);
    const r = applyPatch(V2_MARKDOWN, patch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("不存在");
  });

  it("v2 baseHash 不匹配时直接拒绝", () => {
    const patch: MindMapPatch = {
      version: 2,
      baseHash: "h-wrong-hash",
      ops: [{ name: "addChild", parentId: "root-id", topic: "x" }],
    };
    const r = applyPatch(V2_MARKDOWN, patch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("baseHash 不匹配");
  });

  it("v2 不能删除根节点", () => {
    const patch = makeV2Patch([
      { name: "removeNode", nodeId: "root-id" },
    ]);
    const r = applyPatch(V2_MARKDOWN, patch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("根节点");
  });

  it("v2 不能移动到自身子孙下（防环）", () => {
    const patch = makeV2Patch([
      { name: "moveNode", fromId: "a-id", toParentId: "a1-id" },
    ]);
    const r = applyPatch(V2_MARKDOWN, patch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("自身或其子孙");
  });

  it("v1 和 v2 字段不能混用", () => {
    const json = JSON.stringify({
      version: 2,
      baseHash: v2BaseHash,
      ops: [{ name: "addChild", path: [0], topic: "x" }],
    });
    const r = parsePatch(json);
    // version=2 但 op 只有 path，按 v2 解析会因缺 parentId 失败
    expect(r.ok).toBe(false);
  });

  it("parsePatch 自动推断 v2 版本（无 version 字段，有 nodeId）", () => {
    const json = JSON.stringify({
      baseHash: v2BaseHash,
      ops: [{ name: "addChild", parentId: "root-id", topic: "x" }],
    });
    const r = parsePatch(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.version).toBe(2);
  });

  it("parsePatch 自动推断 v1 版本（无 version 字段，有 path）", () => {
    const json = JSON.stringify({
      baseHash: v2BaseHash,
      ops: [{ name: "addChild", path: [], topic: "x" }],
    });
    const r = parsePatch(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.version).toBe(1);
  });

  it("v1 patch 在 v2 格式 markdown 上仍可应用（向后兼容）", () => {
    // v1 patch 用 path 定位，markdown 含 v2 注释但 path 仍有效
    const patch: MindMapPatch = {
      version: 1,
      baseHash: v2BaseHash,
      ops: [{ name: "addChild", path: [], topic: "根的新子" }],
    };
    const r = applyPatch(V2_MARKDOWN, patch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = parseRoot(r.markdown);
    expect(root.children.map((c) => c.topic)).toContain("根的新子");
    // 原有节点 ID 不变
    expect(root.children.find((c) => c.id === "a-id")?.topic).toBe("A");
  });
});
