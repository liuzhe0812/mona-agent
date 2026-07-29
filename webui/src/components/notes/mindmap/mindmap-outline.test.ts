import { describe, it, expect } from "vitest";
import {
  parseMindMap,
  serializeMindMap,
  extractFencedBlock,
  stripMarkdownFence,
  findNodeByPath,
  findPathToNode,
  findNodeById,
  computeBaseHash,
  generateNodeId,
  cloneMindMapNode,
  type MindMapNode,
} from "./mindmap-outline";

describe("parseMindMap", () => {
  it("解析单根节点", () => {
    const result = parseMindMap("# 根节点");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.root.topic).toBe("根节点");
      expect(result.root.children).toHaveLength(0);
    }
  });

  it("解析多层子节点", () => {
    const md = `# 根

- 一级 A
  - 二级 A1
  - 二级 A2
- 一级 B`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.root.topic).toBe("根");
      expect(result.root.children).toHaveLength(2);
      expect(result.root.children[0].topic).toBe("一级 A");
      expect(result.root.children[0].children).toHaveLength(2);
      expect(result.root.children[0].children[0].topic).toBe("二级 A1");
      expect(result.root.children[1].topic).toBe("一级 B");
    }
  });

  it("忽略空行", () => {
    const md = `# 根

- A


- B
`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.root.children).toHaveLength(2);
    }
  });

  it("同级允许重名", () => {
    const md = `# 根

- 同名
- 同名`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.root.children).toHaveLength(2);
      expect(result.root.children[0].topic).toBe("同名");
      expect(result.root.children[1].topic).toBe("同名");
    }
  });

  it("缺少根标题时失败", () => {
    const result = parseMindMap("- 列表项");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBe(1);
    }
  });

  it("多个根标题时失败", () => {
    const md = `# 根1

# 根2`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBe(3);
    }
  });

  it("缩进跳级时失败", () => {
    const md = `# 根

- 一级
      - 跳级`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBe(4);
    }
  });

  it("非列表段落时失败", () => {
    const md = `# 根

普通段落`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBe(3);
    }
  });

  it("奇数缩进时失败", () => {
    const md = `# 根

- 一级
   - 奇数缩进`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toBe(4);
    }
  });

  it("保留 [[wiki link]] 文本", () => {
    const md = `# 根

- [[某笔记]]`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.root.children[0].topic).toBe("[[某笔记]]");
    }
  });

  it("支持 * 和 + 作为列表标记", () => {
    const md = `# 根

* A
+ B`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.root.children).toHaveLength(2);
    }
  });
});

describe("serializeMindMap", () => {
  it("序列化单根节点（含稳定 ID 注释）", () => {
    const node: MindMapNode = { id: "r", topic: "根", children: [] };
    expect(serializeMindMap(node)).toBe(`# 根 <!-- mona:mindmap-v1 {"id":"r"} -->`);
  });

  it("序列化多层树（每个节点含 ID 注释）", () => {
    const node: MindMapNode = {
      id: "r",
      topic: "根",
      children: [
        { id: "a", topic: "A", children: [
          { id: "a1", topic: "A1", children: [] },
        ]},
        { id: "b", topic: "B", children: [] },
      ],
    };
    const md = serializeMindMap(node);
    expect(md).toBe(`# 根 <!-- mona:mindmap-v1 {"id":"r"} -->
- A <!-- mona:mindmap-v1 {"id":"a"} -->
  - A1 <!-- mona:mindmap-v1 {"id":"a1"} -->
- B <!-- mona:mindmap-v1 {"id":"b"} -->`);
  });

  it("parse → serialize → parse 结构一致", () => {
    const original = `# 根

- 一级 A
  - 二级 A1
  - 二级 A2
- 一级 B`;

    const p1 = parseMindMap(original);
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;

    const serialized = serializeMindMap(p1.root);
    const p2 = parseMindMap(serialized);
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;

    // 比较结构（忽略 id）
    const stripIds = (n: MindMapNode): unknown => ({
      topic: n.topic,
      children: n.children.map(stripIds),
    });
    expect(stripIds(p1.root)).toEqual(stripIds(p2.root));
  });
});

describe("extractFencedBlock", () => {
  it("提取 mindmap fenced block", () => {
    const text = `这是一些解释。

\`\`\`mindmap
# 根

- A
- B
\`\`\`

更多文字。`;
    expect(extractFencedBlock(text, "mindmap")).toBe(`# 根

- A
- B`);
  });

  it("提取 mindmap-patch fenced block", () => {
    const text = `解释。

\`\`\`mindmap-patch
{"baseHash":"h1","ops":[]}
\`\`\``;
    expect(extractFencedBlock(text, "mindmap-patch")).toBe(`{"baseHash":"h1","ops":[]}`);
  });

  it("多个同名 block 取最后一个", () => {
    const text = `\`\`\`mindmap
# 旧
\`\`\`

\`\`\`mindmap
# 新
\`\`\``;
    expect(extractFencedBlock(text, "mindmap")).toBe("# 新");
  });

  it("无匹配时返回 null", () => {
    expect(extractFencedBlock("普通文本", "mindmap")).toBeNull();
  });
});

describe("stripMarkdownFence", () => {
  it("剥离 ```markdown 围栏", () => {
    const text = "```markdown\n# 根\n- A\n```";
    expect(stripMarkdownFence(text)).toBe("# 根\n- A");
  });

  it("剥离 ``` 围栏", () => {
    const text = "```\n# 根\n```";
    expect(stripMarkdownFence(text)).toBe("# 根");
  });

  it("无围栏时原样返回", () => {
    expect(stripMarkdownFence("# 根")).toBe("# 根");
  });
});

describe("findNodeByPath", () => {
  const tree: MindMapNode = {
    id: "root",
    topic: "根",
    children: [
      { id: "a", topic: "A", children: [
        { id: "a1", topic: "A1", children: [] },
      ]},
      { id: "b", topic: "B", children: [] },
    ],
  };

  it("空路径返回根", () => {
    expect(findNodeByPath(tree, [])?.id).toBe("root");
  });

  it("路径 [1] 返回第二个子节点", () => {
    expect(findNodeByPath(tree, [1])?.id).toBe("b");
  });

  it("路径 [0, 0] 返回嵌套节点", () => {
    expect(findNodeByPath(tree, [0, 0])?.id).toBe("a1");
  });

  it("路径越界返回 null", () => {
    expect(findNodeByPath(tree, [5])).toBeNull();
  });
});

describe("findPathToNode", () => {
  const tree: MindMapNode = {
    id: "root",
    topic: "根",
    children: [
      { id: "a", topic: "A", children: [
        { id: "a1", topic: "A1", children: [] },
      ]},
    ],
  };

  it("根节点返回空路径", () => {
    expect(findPathToNode(tree, "root")).toEqual([]);
  });

  it("嵌套节点返回完整路径", () => {
    expect(findPathToNode(tree, "a1")).toEqual([0, 0]);
  });

  it("不存在的 ID 返回 null", () => {
    expect(findPathToNode(tree, "missing")).toBeNull();
  });
});

describe("computeBaseHash", () => {
  it("相同内容返回相同哈希", () => {
    expect(computeBaseHash("# 根")).toBe(computeBaseHash("# 根"));
  });

  it("不同内容返回不同哈希", () => {
    expect(computeBaseHash("# A")).not.toBe(computeBaseHash("# B"));
  });
});

describe("generateNodeId", () => {
  it("生成唯一 ID", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateNodeId());
    }
    expect(ids.size).toBe(100);
  });

  it("返回非空字符串（v2 优先使用 UUID）", () => {
    const id = generateNodeId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    // 优先 UUID 格式；环境不支持时回退到 node- 前缀
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const isFallback = id.startsWith("node-");
    expect(isUuid || isFallback).toBe(true);
  });

  it("多次调用返回不同值", () => {
    const a = generateNodeId();
    const b = generateNodeId();
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// 存储格式 v2 测试（见 docs/plans/mindmap-dev-plan.md §7）
// ============================================================================

describe("存储格式 v2", () => {
  it("解析含 v2 注释的节点，保留稳定 ID", () => {
    const md = `# 根 <!-- mona:mindmap-v1 {"id":"root-id"} -->
- A <!-- mona:mindmap-v1 {"id":"a-id"} -->`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root.id).toBe("root-id");
    expect(result.root.children[0].id).toBe("a-id");
  });

  it("解析含 note/icons/hyperLink/image/style 扩展字段", () => {
    const md = `# 根 <!-- mona:mindmap-v1 {"id":"r","note":"备注","icons":["priority-1","star"],"hyperLink":"https://example.com","style":{"color":"#f00","fontSize":"16px"}} -->
- 子 <!-- mona:mindmap-v1 {"id":"c","image":{"url":"x.png","width":100,"height":50,"fit":"contain"}} -->`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root.note).toBe("备注");
    expect(result.root.icons).toEqual(["priority-1", "star"]);
    expect(result.root.hyperLink).toBe("https://example.com");
    expect(result.root.style).toEqual({ color: "#f00", fontSize: "16px" });
    expect(result.root.children[0].image).toEqual({ url: "x.png", width: 100, height: 50, fit: "contain" });
  });

  it("未识别的 metadata 字段原样保留", () => {
    const md = `# 根 <!-- mona:mindmap-v1 {"id":"r","customField":"abc","another":{"x":1}} -->`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root.metadata).toEqual({ customField: "abc", another: { x: 1 } });
  });

  it("parse → serialize → parse 无损往返（含扩展字段）", () => {
    const md = `# 根 <!-- mona:mindmap-v1 {"id":"r","note":"备注","icons":["star"]} -->
- A <!-- mona:mindmap-v1 {"id":"a","hyperLink":"https://x.com"} -->`;
    const p1 = parseMindMap(md);
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const ser = serializeMindMap(p1.root);
    const p2 = parseMindMap(ser);
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    // ID 稳定
    expect(p2.root.id).toBe("r");
    expect(p2.root.children[0].id).toBe("a");
    // 扩展字段保留
    expect(p2.root.note).toBe("备注");
    expect(p2.root.icons).toEqual(["star"]);
    expect(p2.root.children[0].hyperLink).toBe("https://x.com");
  });

  it("旧格式无注释时仍能解析，ID 运行时生成", () => {
    const md = `# 根\n- A\n  - A1`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root.id).toBeTruthy();
    expect(result.root.children[0].id).toBeTruthy();
    // 无扩展字段
    expect(result.root.note).toBeUndefined();
    expect(result.root.icons).toBeUndefined();
  });

  it("JSON 解析失败的注释被忽略，保留纯 topic", () => {
    const md = `# 根 <!-- mona:mindmap-v1 {invalid json} -->`;
    const result = parseMindMap(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root.topic).toBe("根");
    expect(result.root.id).toBeTruthy();
    // 失败的注释不带扩展字段
    expect(result.root.note).toBeUndefined();
  });

  it("序列化后再解析，ID 保持稳定", () => {
    const node: MindMapNode = {
      id: "stable-uuid-1",
      topic: "根",
      children: [{ id: "stable-uuid-2", topic: "A", children: [] }],
    };
    const ser1 = serializeMindMap(node);
    const p1 = parseMindMap(ser1);
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.root.id).toBe("stable-uuid-1");
    expect(p1.root.children[0].id).toBe("stable-uuid-2");
    // 二次往返
    const ser2 = serializeMindMap(p1.root);
    const p2 = parseMindMap(ser2);
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    expect(p2.root.id).toBe("stable-uuid-1");
    expect(p2.root.children[0].id).toBe("stable-uuid-2");
  });

  it("cloneMindMapNode 保留所有扩展字段", () => {
    const node: MindMapNode = {
      id: "r",
      topic: "根",
      children: [],
      note: "备注",
      icons: ["star"],
      hyperLink: "https://x.com",
      image: { url: "a.png", width: 10, height: 20 },
      style: { color: "#f00" },
      metadata: { custom: "value" },
    };
    const clone = cloneMindMapNode(node);
    expect(clone.id).toBe("r");
    expect(clone.topic).toBe("根");
    expect(clone.note).toBe("备注");
    expect(clone.icons).toEqual(["star"]);
    expect(clone.hyperLink).toBe("https://x.com");
    expect(clone.image).toEqual({ url: "a.png", width: 10, height: 20 });
    expect(clone.style).toEqual({ color: "#f00" });
    expect(clone.metadata).toEqual({ custom: "value" });
    // 修改 clone 不影响原对象
    clone.note = "改了";
    clone.icons?.push("flag");
    expect(node.note).toBe("备注");
    expect(node.icons).toEqual(["star"]);
  });

  it("findNodeById 按 ID 查找节点", () => {
    const node: MindMapNode = {
      id: "r",
      topic: "根",
      children: [
        { id: "a", topic: "A", children: [{ id: "a1", topic: "A1", children: [] }] },
      ],
    };
    expect(findNodeById(node, "r")?.topic).toBe("根");
    expect(findNodeById(node, "a")?.topic).toBe("A");
    expect(findNodeById(node, "a1")?.topic).toBe("A1");
    expect(findNodeById(node, "不存在")).toBeNull();
  });
});
