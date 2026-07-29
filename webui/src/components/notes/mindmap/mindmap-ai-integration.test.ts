/**
 * Phase 2.12 AI 集成端到端测试。
 *
 * 验证 4 个 AI 动作的完整流程：
 *   1. mindmap-generate（全量替换）：AI 返回 ```mindmap fenced block
 *   2. mindmap-reorganize（全量替换）：AI 返回 ```mindmap fenced block
 *   3. mindmap-expand（局部 patch）：AI 返回 ```mindmap-patch fenced block，包含 addChild 操作
 *   4. mindmap-simplify（局部 patch）：AI 返回 ```mindmap-patch fenced block，包含 removeNode + addChild 操作
 *
 * 同时验证：
 *   - buildMindMapActionPrompt 输出包含正确的契约关键词；
 *   - applyMindMapAiResult 能从模拟 AI 回答中提取并应用结构化结果；
 *   - baseHash 不匹配时 patch 被拒绝；
 *   - patch 单 op 失败时整个 patch 不应用（原子性）。
 *
 * 运行方式：
 *   npx vitest run src/components/notes/mindmap/mindmap-ai-integration.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  buildMindMapActionPrompt,
  type MindMapSelectionContext,
} from "../notes-ai";
import type { OperationNote } from "../notes-data";
import { applyMindMapAiResult } from "./mindmap-apply";
import {
  parseMindMap,
  computeBaseHash,
} from "./mindmap-outline";

/** 构造一个 mindmap 类型的 OperationNote */
function makeNote(markdown: string, title = "测试导图"): OperationNote {
  return {
    id: "note-test",
    notebookId: "nb-test",
    title,
    contentMarkdown: markdown,
    plainText: markdown,
    preview: markdown.slice(0, 46),
    source: { kind: "manual", label: "手动" },
    tags: [],
    contextLevel: "standard",
    createdAt: "2026-07-28T00:00:00Z",
    updatedAt: "2026-07-28T00:00:00Z",
    type: "mindmap",
  } as unknown as OperationNote;
}

/** 构造一个选中节点上下文 */
function makeSelection(
  path: number[],
  pathLabels: string[],
  subtreeMarkdown: string,
): MindMapSelectionContext {
  return { path, pathLabels, subtreeMarkdown };
}

/** 模拟 AI 对 generate 动作的回答（包含 ```mindmap fenced block） */
function simulateAiGenerateResponse(): string {
  return `我为你生成了一份围绕"Mona 产品规划"的思维导图，包含 4 个主要分支。

\`\`\`mindmap
# Mona 产品规划

- 核心功能
  - 笔记管理
  - AI 对话
  - 邮件协作
- 技术架构
  - Tauri 桌面端
  - React 前端
  - Python 网关
- 用户体验
  - 主题切换
  - 快捷键
- 路线图
  - Phase 1
  - Phase 2
\`\`\`

希望这份导图对你有帮助。`;
}

/** 模拟 AI 对 reorganize 动作的回答（包含 ```mindmap fenced block） */
function simulateAiReorganizeResponse(): string {
  return `我对导图做了重组：将"技术架构"提前到第一位，合并相近分支。

\`\`\`mindmap
# Mona 产品规划

- 技术架构
  - Tauri 桌面端
  - React 前端
  - Python 网关
- 核心功能
  - 笔记管理
  - AI 对话
  - 邮件协作
- 用户体验
  - 主题切换
  - 快捷键
\`\`\``;
}

/** 模拟 AI 对 expand 动作的回答（包含 ```mindmap-patch fenced block，仅 addChild） */
function simulateAiExpandResponse(baseHash: string): string {
  return `我为"核心功能"分支追加了 3 个子节点。

\`\`\`mindmap-patch
{
  "baseHash": "${baseHash}",
  "ops": [
    { "name": "addChild", "path": [0], "topic": "任务管理", "expectedTopic": "核心功能" },
    { "name": "addChild", "path": [0], "topic": "日历视图", "expectedTopic": "核心功能" },
    { "name": "addChild", "path": [0], "topic": "搜索", "expectedTopic": "核心功能" }
  ]
}
\`\`\``;
}

/** 模拟 AI 对 simplify 动作的回答（包含 removeNode + addChild 组合） */
function simulateAiSimplifyResponse(baseHash: string): string {
  return `我用更精简的子节点替换了"核心功能"下原有 3 个节点，合并为 2 个。

\`\`\`mindmap-patch
{
  "baseHash": "${baseHash}",
  "ops": [
    { "name": "removeNode", "path": [0, 0], "expectedTopic": "笔记管理" },
    { "name": "removeNode", "path": [0, 0], "expectedTopic": "AI 对话" },
    { "name": "removeNode", "path": [0, 0], "expectedTopic": "邮件协作" },
    { "name": "addChild", "path": [0], "topic": "内容创作", "expectedTopic": "核心功能" },
    { "name": "addChild", "path": [0], "topic": "协作通信", "expectedTopic": "核心功能" }
  ]
}
\`\`\``;
}

const INITIAL_MARKDOWN = `# Mona 产品规划

- 核心功能
  - 笔记管理
  - AI 对话
  - 邮件协作
- 技术架构
  - Tauri 桌面端
  - React 前端
  - Python 网关
- 用户体验
  - 主题切换
  - 快捷键`;

describe("Phase 2.12 AI 集成端到端", () => {
  describe("buildMindMapActionPrompt: 输出契约关键词", () => {
    const note = makeNote(INITIAL_MARKDOWN);
    const selection = makeSelection(
      [0],
      ["Mona 产品规划", "核心功能"],
      `# 核心功能\n\n- 笔记管理\n- AI 对话\n- 邮件协作`,
    );

    it("mindmap-generate 包含 \\`\\`\\`mindmap fenced block 契约", () => {
      const prompt = buildMindMapActionPrompt("mindmap-generate", note, null, "");
      expect(prompt).toContain("```mindmap");
      expect(prompt).not.toContain("```mindmap-patch");
      expect(prompt).toContain("大纲格式规范");
    });

    it("mindmap-reorganize 包含 \\`\\`\\`mindmap fenced block 契约", () => {
      const prompt = buildMindMapActionPrompt("mindmap-reorganize", note, null, "");
      expect(prompt).toContain("```mindmap");
      expect(prompt).not.toContain("```mindmap-patch");
      // 重组需要附上当前完整大纲
      expect(prompt).toContain(INITIAL_MARKDOWN);
    });

    it("mindmap-expand 包含 \\`\\`\\`mindmap-patch fenced block 契约和 baseHash", () => {
      const baseHash = computeBaseHash(INITIAL_MARKDOWN);
      const prompt = buildMindMapActionPrompt("mindmap-expand", note, selection, baseHash);
      expect(prompt).toContain("```mindmap-patch");
      expect(prompt).toContain(baseHash);
      // 局部 patch 需要附上选中子树
      expect(prompt).toContain("核心功能");
      expect(prompt).toContain(JSON.stringify(selection.path));
    });

    it("mindmap-simplify 包含 \\`\\`\\`mindmap-patch fenced block 契约", () => {
      const baseHash = computeBaseHash(INITIAL_MARKDOWN);
      const prompt = buildMindMapActionPrompt("mindmap-simplify", note, selection, baseHash);
      expect(prompt).toContain("```mindmap-patch");
      expect(prompt).toContain(baseHash);
    });

    it("mindmap-expand 无 selection 时返回提示", () => {
      const prompt = buildMindMapActionPrompt("mindmap-expand", note, null, "");
      expect(prompt).toContain("未选中");
    });
  });

  describe("mindmap-generate: 全量替换端到端", () => {
    const note = makeNote("# 空白导图");

    it("从 AI 回答中提取 \\`\\`\\`mindmap block 并应用为新大纲", () => {
      const aiResponse = simulateAiGenerateResponse();
      const result = applyMindMapAiResult(aiResponse, note.contentMarkdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.mode).toBe("replace");
      if (result.mode !== "replace") return;

      // 应用后的 markdown 应以 "# Mona 产品规划" 开头
      expect(result.markdown).toMatch(/^# Mona 产品规划/);
      expect(result.markdown).toContain("- 核心功能");
      expect(result.markdown).toContain("Tauri 桌面端");

      // 应用结果应该是可被 parseMindMap 解析的合法大纲
      const parsed = parseMindMap(result.markdown);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.root.topic).toBe("Mona 产品规划");
      expect(parsed.root.children.length).toBeGreaterThanOrEqual(3);

      // 通知文本
      expect(result.notice).toContain("替换");
    });
  });

  describe("mindmap-reorganize: 全量替换端到端", () => {
    const note = makeNote(INITIAL_MARKDOWN);

    it("从 AI 回答中提取重组后的大纲并应用", () => {
      const aiResponse = simulateAiReorganizeResponse();
      const result = applyMindMapAiResult(aiResponse, note.contentMarkdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.mode).toBe("replace");
      if (result.mode !== "replace") return;

      // 重组后"技术架构"应该在第一位
      const parsed = parseMindMap(result.markdown);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.root.children[0].topic).toBe("技术架构");
      expect(parsed.root.children[1].topic).toBe("核心功能");
    });
  });

  describe("mindmap-expand: 局部 patch 端到端", () => {
    const note = makeNote(INITIAL_MARKDOWN);

    it("从 AI 回答中提取 \\`\\`\\`mindmap-patch block 并应用 addChild 操作", () => {
      const baseHash = computeBaseHash(INITIAL_MARKDOWN);
      const aiResponse = simulateAiExpandResponse(baseHash);
      const result = applyMindMapAiResult(aiResponse, note.contentMarkdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.mode).toBe("patch");
      if (result.mode !== "patch") return;

      // 应用了 3 个 addChild 操作
      expect(result.appliedCount).toBe(3);
      expect(result.markdown).toContain("任务管理");
      expect(result.markdown).toContain("日历视图");
      expect(result.markdown).toContain("搜索");

      // 应保留原有节点
      expect(result.markdown).toContain("笔记管理");
      expect(result.markdown).toContain("AI 对话");

      // 应用后的 markdown 仍可被解析为合法大纲
      const parsed = parseMindMap(result.markdown);
      expect(parsed.ok).toBe(true);

      expect(result.notice).toContain("3");
    });

    it("baseHash 不匹配时拒绝 patch", () => {
      // 故意使用错误的 baseHash
      const aiResponse = simulateAiExpandResponse("h-wrong-hash");
      const result = applyMindMapAiResult(aiResponse, note.contentMarkdown);

      expect(result.ok).toBe(false);
      if (!result.ok) return;
      expect(result.notice).toContain("失败");
    });

    it("expectedTopic 不匹配时拒绝整个 patch（原子性）", () => {
      const baseHash = computeBaseHash(INITIAL_MARKDOWN);
      // 构造一个 expectedTopic 不匹配的 patch
      const aiResponse = `\`\`\`mindmap-patch
{
  "baseHash": "${baseHash}",
  "ops": [
    { "name": "addChild", "path": [0], "topic": "新节点", "expectedTopic": "错误的文本" }
  ]
}
\`\`\``;
      const result = applyMindMapAiResult(aiResponse, note.contentMarkdown);

      expect(result.ok).toBe(false);
      if (!result.ok) return;
      expect(result.notice).toContain("失败");
    });
  });

  describe("mindmap-simplify: 局部 patch 组合操作端到端", () => {
    const note = makeNote(INITIAL_MARKDOWN);

    it("从 AI 回答中提取 removeNode + addChild 组合并应用", () => {
      const baseHash = computeBaseHash(INITIAL_MARKDOWN);
      const aiResponse = simulateAiSimplifyResponse(baseHash);
      const result = applyMindMapAiResult(aiResponse, note.contentMarkdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.mode).toBe("patch");
      if (result.mode !== "patch") return;

      // 应用了 5 个 ops（3 个 removeNode + 2 个 addChild）
      expect(result.appliedCount).toBe(5);

      // 原有的 3 个子节点应被删除
      expect(result.markdown).not.toContain("笔记管理");
      expect(result.markdown).not.toContain("AI 对话");
      expect(result.markdown).not.toContain("邮件协作");

      // 新增的 2 个节点应存在
      expect(result.markdown).toContain("内容创作");
      expect(result.markdown).toContain("协作通信");

      // "核心功能" 节点本身保留
      expect(result.markdown).toContain("核心功能");

      // 应用后的 markdown 仍可被解析为合法大纲
      const parsed = parseMindMap(result.markdown);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const coreFunc = parsed.root.children.find((c) => c.topic === "核心功能");
      expect(coreFunc).toBeDefined();
      expect(coreFunc?.children).toHaveLength(2);
    });

    it("中间 op 失败时整个 patch 不应用（原子性）", () => {
      const baseHash = computeBaseHash(INITIAL_MARKDOWN);
      // 第一个 removeNode 路径不存在（[99,99]），应失败
      const aiResponse = `\`\`\`mindmap-patch
{
  "baseHash": "${baseHash}",
  "ops": [
    { "name": "removeNode", "path": [99, 99], "expectedTopic": "不存在" },
    { "name": "addChild", "path": [0], "topic": "新节点", "expectedTopic": "核心功能" }
  ]
}
\`\`\``;
      const result = applyMindMapAiResult(aiResponse, note.contentMarkdown);

      expect(result.ok).toBe(false);
      if (!result.ok) return;
      // 原内容不变（原子性）
      expect(result.notice).toContain("失败");
    });
  });

  describe("契约优先级: patch 优先于 replace", () => {
    it("同时包含两种 block 时以 patch 为准", () => {
      const baseHash = computeBaseHash(INITIAL_MARKDOWN);
      const note = makeNote(INITIAL_MARKDOWN);
      // 同时包含 mindmap-patch 和 mindmap 两种 block
      const aiResponse = `我先做了局部修改，又给了完整大纲。

\`\`\`mindmap-patch
{
  "baseHash": "${baseHash}",
  "ops": [
    { "name": "addChild", "path": [0], "topic": "局部新增", "expectedTopic": "核心功能" }
  ]
}
\`\`\`

完整大纲如下：

\`\`\`mindmap
# 完全不同的大纲

- A
- B
\`\`\``;

      const result = applyMindMapAiResult(aiResponse, note.contentMarkdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.mode).toBe("patch");
      if (result.mode !== "patch") return;
      expect(result.markdown).toContain("局部新增");
      expect(result.markdown).not.toContain("完全不同的大纲");
    });
  });

  describe("无结构化 block 时降级", () => {
    it("AI 回答不含 fenced block 时返回 ok:false", () => {
      const note = makeNote(INITIAL_MARKDOWN);
      const aiResponse = "我只是和用户讨论了一下思维导图的设计，没有返回结构化结果。";
      const result = applyMindMapAiResult(aiResponse, note.contentMarkdown);

      expect(result.ok).toBe(false);
      if (!result.ok) return;
      expect(result.mode).toBe("none");
      expect(result.notice).toContain("未返回");
    });
  });

  describe("全流程: prompt 构造 → 模拟 AI 回答 → 应用结果", () => {
    it("完整 mindmap-generate 流程闭环", () => {
      const note = makeNote("# 空白导图");
      const prompt = buildMindMapActionPrompt("mindmap-generate", note, null, "");
      expect(prompt).toContain("```mindmap");

      const aiResponse = simulateAiGenerateResponse();
      const result = applyMindMapAiResult(aiResponse, note.contentMarkdown);
      expect(result.ok).toBe(true);

      // 最终 markdown 可被 parseMindMap 解析且根节点正确
      if (!result.ok || result.mode !== "replace") return;
      const parsed = parseMindMap(result.markdown);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.root.topic).toBe("Mona 产品规划");
    });

    it("完整 mindmap-expand 流程闭环（含 baseHash 同步）", () => {
      const note = makeNote(INITIAL_MARKDOWN);
      const baseHash = computeBaseHash(note.contentMarkdown);

      // 模拟用户选中"核心功能"节点
      const selection = makeSelection(
        [0],
        ["Mona 产品规划", "核心功能"],
        `# 核心功能\n\n- 笔记管理\n- AI 对话\n- 邮件协作`,
      );

      // Step 1: 构造 prompt
      const prompt = buildMindMapActionPrompt("mindmap-expand", note, selection, baseHash);
      expect(prompt).toContain("```mindmap-patch");
      expect(prompt).toContain(baseHash);

      // Step 2: 模拟 AI 回答
      const aiResponse = simulateAiExpandResponse(baseHash);

      // Step 3: 应用结果
      const result = applyMindMapAiResult(aiResponse, note.contentMarkdown);
      expect(result.ok).toBe(true);
      if (!result.ok || result.mode !== "patch") return;

      // Step 4: 应用后的 markdown 可被解析，且 baseHash 已变化（说明内容确实变了）
      const parsed = parseMindMap(result.markdown);
      expect(parsed.ok).toBe(true);
      const newBaseHash = computeBaseHash(result.markdown);
      expect(newBaseHash).not.toBe(baseHash);
    });
  });
});
