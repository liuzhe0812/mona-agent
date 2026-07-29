import { describe, it, expect } from "vitest";
import {
  searchInTree,
  replaceFirstInTopic,
  replaceAllInTopic,
  computeReplaceAllChanges,
  collectAllNodes,
  type SearchOptions,
} from "./mindmap-search";
import type { MindMapNode } from "./mindmap-outline";

/** 构造测试用树：
 *   根
 *   ├── Apple
 *   │   ├── Banana
 *   │   └── apple pie
 *   └── Cherry
 *       └── Date
 */
function makeTree(): MindMapNode {
  return {
    id: "root",
    topic: "根",
    children: [
      {
        id: "a",
        topic: "Apple",
        children: [
          { id: "a1", topic: "Banana", children: [] },
          { id: "a2", topic: "apple pie", children: [] },
        ],
      },
      {
        id: "b",
        topic: "Cherry",
        children: [{ id: "b1", topic: "Date", children: [] }],
      },
    ],
  };
}

describe("collectAllNodes", () => {
  it("按深度优先顺序收集所有节点", () => {
    const tree = makeTree();
    const nodes = collectAllNodes(tree);
    expect(nodes.map(n => n.id)).toEqual(["root", "a", "a1", "a2", "b", "b1"]);
  });
});

describe("searchInTree", () => {
  it("大小写不敏感查找 'apple' 匹配 Apple 和 apple pie", () => {
    const tree = makeTree();
    const matches = searchInTree(tree, "apple");
    expect(matches).toHaveLength(2);
    expect(matches[0].nodeId).toBe("a");
    expect(matches[0].start).toBe(0);
    expect(matches[0].end).toBe(5);
    expect(matches[1].nodeId).toBe("a2");
    expect(matches[1].start).toBe(0);
    expect(matches[1].end).toBe(5);
  });

  it("大小写敏感查找 'apple' 只匹配 apple pie", () => {
    const tree = makeTree();
    const matches = searchInTree(tree, "apple", { caseSensitive: true } as SearchOptions);
    expect(matches).toHaveLength(1);
    expect(matches[0].nodeId).toBe("a2");
  });

  it("空查询返回空数组", () => {
    const tree = makeTree();
    const matches = searchInTree(tree, "");
    expect(matches).toHaveLength(0);
  });

  it("无匹配返回空数组", () => {
    const tree = makeTree();
    const matches = searchInTree(tree, "xyz");
    expect(matches).toHaveLength(0);
  });

  it("同一节点多次匹配", () => {
    const tree: MindMapNode = {
      id: "r",
      topic: "aba aba",
      children: [],
    };
    const matches = searchInTree(tree, "a");
    // "aba aba" 中有 4 个 'a'
    expect(matches).toHaveLength(4);
    expect(matches.every(m => m.nodeId === "r")).toBe(true);
  });

  it("匹配中文", () => {
    const tree: MindMapNode = {
      id: "r",
      topic: "产品规划",
      children: [{ id: "c", topic: "产品研究", children: [] }],
    };
    const matches = searchInTree(tree, "产品");
    expect(matches).toHaveLength(2);
  });
});

describe("replaceFirstInTopic", () => {
  it("替换第一个匹配", () => {
    expect(replaceFirstInTopic("apple pie apple", "apple", "橙子")).toBe("橙子 pie apple");
  });

  it("大小写不敏感替换第一个", () => {
    expect(replaceFirstInTopic("Apple apple", "apple", "X")).toBe("X apple");
  });

  it("大小写敏感时不替换不同大小写", () => {
    expect(replaceFirstInTopic("Apple apple", "apple", "X", { caseSensitive: true } as SearchOptions)).toBe("Apple X");
  });

  it("无匹配时原样返回", () => {
    expect(replaceFirstInTopic("hello", "world", "X")).toBe("hello");
  });

  it("空查询原样返回", () => {
    expect(replaceFirstInTopic("hello", "", "X")).toBe("hello");
  });
});

describe("replaceAllInTopic", () => {
  it("替换所有匹配", () => {
    expect(replaceAllInTopic("apple pie apple", "apple", "橙子")).toBe("橙子 pie 橙子");
  });

  it("大小写不敏感替换所有", () => {
    expect(replaceAllInTopic("Apple apple APPLE", "apple", "X")).toBe("X X X");
  });

  it("无匹配时原样返回", () => {
    expect(replaceAllInTopic("hello", "world", "X")).toBe("hello");
  });
});

describe("computeReplaceAllChanges", () => {
  it("生成全部替换变更集", () => {
    const tree = makeTree();
    const changes = computeReplaceAllChanges(tree, "apple", "橙子");
    expect(changes).toHaveLength(2);
    // Apple → 橙子
    expect(changes[0].nodeId).toBe("a");
    expect(changes[0].oldTopic).toBe("Apple");
    expect(changes[0].newTopic).toBe("橙子");
    expect(changes[0].matchCount).toBe(1);
    // apple pie → 橙子 pie
    expect(changes[1].nodeId).toBe("a2");
    expect(changes[1].oldTopic).toBe("apple pie");
    expect(changes[1].newTopic).toBe("橙子 pie");
    expect(changes[1].matchCount).toBe(1);
  });

  it("无匹配时返回空数组", () => {
    const tree = makeTree();
    const changes = computeReplaceAllChanges(tree, "xyz", "Y");
    expect(changes).toHaveLength(0);
  });

  it("空查询返回空数组", () => {
    const tree = makeTree();
    const changes = computeReplaceAllChanges(tree, "", "Y");
    expect(changes).toHaveLength(0);
  });

  it("同一节点多次匹配时 matchCount 正确", () => {
    const tree: MindMapNode = {
      id: "r",
      topic: "aa aa",
      children: [],
    };
    const changes = computeReplaceAllChanges(tree, "a", "b");
    expect(changes).toHaveLength(1);
    expect(changes[0].matchCount).toBe(4);
    expect(changes[0].newTopic).toBe("bb bb");
  });
});
