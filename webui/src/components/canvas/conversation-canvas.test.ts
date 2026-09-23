import { describe, expect, it } from "vitest";

import type { OperationNote } from "@/components/notes/notes-data";
import {
  computeFlowchartDocumentHash,
  parseFlowchartMarkdown,
} from "@/components/notes/flowchart/flowchart-document";

import {
  applyConversationCanvasResponse,
  conversationCanvasBaseHash,
  createConversationCanvasNote,
  deriveConversationCanvasTitle,
  detectConversationCanvasIntent,
  stripConversationCanvasBlocks,
} from "./conversation-canvas";

function fencedBlock(language: string, value: unknown): string {
  return `\`\`\`${language}\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

describe("detectConversationCanvasIntent", () => {
  it("识别明确的流程图和思维导图创建意图", () => {
    expect(detectConversationCanvasIntent("帮我画一个退款审批流程图")).toEqual({
      kind: "flowchart",
      title: "退款审批流程图",
    });
    expect(detectConversationCanvasIntent("请创建一个产品规划思维导图")).toEqual({
      kind: "mindmap",
      title: "产品规划思维导图",
    });
    expect(detectConversationCanvasIntent("画一个微服务架构图")?.kind).toBe("flowchart");
    expect(detectConversationCanvasIntent("把下面的处理过程整理成一张图")?.kind).toBe("flowchart");
    expect(detectConversationCanvasIntent("制作一张部门泳道图")?.kind).toBe("flowchart");
  });

  it("普通讨论不误创建画布", () => {
    expect(detectConversationCanvasIntent("我们讨论一下退款审批流程图的优缺点")).toBeNull();
    expect(detectConversationCanvasIntent("帮我分析一下思维导图应该包含哪些内容")).toBeNull();
    expect(detectConversationCanvasIntent("退款审批流程图应该包含哪些节点？")).toBeNull();
    expect(detectConversationCanvasIntent("我们讨论一下架构图应该怎么画")).toBeNull();
  });

  it("PPT 和配图请求不被改道成流程图", () => {
    expect(detectConversationCanvasIntent(
      "制作一个PPT介绍最近爆火的模型，页面信息密度高，图表展示相关数据，合理配图",
    )).toBeNull();
    expect(detectConversationCanvasIntent("做一个商业汇报 PPT，可视化展示经营数据")).toBeNull();
    expect(detectConversationCanvasIntent("在 PowerPoint 里制作一页产品流程图")).toBeNull();
    expect(detectConversationCanvasIntent("制作一个产品介绍，合理配图")).toBeNull();
  });
});

describe("deriveConversationCanvasTitle", () => {
  it("从流程图创建请求提取标题", () => {
    expect(deriveConversationCanvasTitle("帮我画一个退款审批流程图", "flowchart")).toBe(
      "退款审批流程图",
    );
  });
});

describe("stripConversationCanvasBlocks", () => {
  it("隐藏三类内部 fenced block，同时保留自然语言说明", () => {
    const content = [
      "开始说明",
      "",
      fencedBlock("mona-flowchart-patch", { baseHash: "h1", ops: [] }),
      "",
      "中间说明",
      "",
      fencedBlock("mindmap-patch", { baseHash: "h2", ops: [] }),
      "",
      "继续说明",
      "",
      "```mindmap\n# 退款审批\n- 提交申请\n```",
      "",
      "结尾说明",
    ].join("\n");

    expect(stripConversationCanvasBlocks(content)).toBe(
      "开始说明\n\n中间说明\n\n继续说明\n\n结尾说明",
    );
  });
});

describe("createConversationCanvasNote", () => {
  it("创建流程图 note 时写入 originChatId、type 和 title", () => {
    const note = createConversationCanvasNote("flowchart", "退款审批流程图", "chat-123");

    expect(note.originChatId).toBe("chat-123");
    expect(note.type).toBe("flowchart");
    expect(note.title).toBe("退款审批流程图");
  });
});

describe("applyConversationCanvasResponse", () => {
  it("应用合法 replaceGraph patch，并更新画布 note", () => {
    const note = createConversationCanvasNote("flowchart", "退款审批流程图", "chat-123");
    const requestBaseHash = conversationCanvasBaseHash(note);
    const patch = {
      baseHash: requestBaseHash,
      ops: [
        {
          name: "replaceGraph",
          graph: {
            direction: "TB",
            nodes: [
              { id: "start", kind: "start", label: "提交申请" },
              { id: "review", kind: "process", label: "审核" },
              { id: "end", kind: "end", label: "结束" },
            ],
            edges: [
              { id: "edge-1", source: "start", target: "review" },
              { id: "edge-2", source: "review", target: "end" },
            ],
          },
        },
      ],
    };

    const result = applyConversationCanvasResponse(
      note,
      `我会先整理退款审批步骤。\n\n${fencedBlock("mona-flowchart-patch", patch)}`,
      "message-1",
      requestBaseHash,
    );

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.note.type).toBe("flowchart");
    expect(result.note.title).toBe("退款审批流程图");
    expect(result.note.contentMarkdown).toContain("提交申请");
    expect(result.note.appliedAgentMessageIds).toContain("message-1");
  });

  it("主会话应用主题、图标和边样式", () => {
    const note = createConversationCanvasNote("flowchart", "服务流程图", "chat-visual");
    const requestBaseHash = conversationCanvasBaseHash(note);
    const parsed = parseFlowchartMarkdown(note.contentMarkdown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const response = fencedBlock("mona-flowchart-patch", {
      baseHash: requestBaseHash,
      baseDocumentHash: computeFlowchartDocumentHash(parsed.document),
      ops: [{
        name: "replaceGraph",
        graph: {
          direction: "LR",
          layout: "auto",
          theme: { stylePreset: "soft", paletteId: "deep-blue", preserveManualStyles: true },
          nodes: [
            { id: "client", kind: "start", label: "客户端", icon: "browser" },
            { id: "service", kind: "process", label: "业务服务", icon: "server", style: { fill: "#DBEAFE" } },
          ],
          edges: [{ id: "call", source: "client", target: "service", style: { route: "smoothstep", markerEnd: "arrowclosed" } }],
        },
      }],
    });
    const result = applyConversationCanvasResponse(note, response, "message-visual", requestBaseHash);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.note.contentMarkdown).toContain('"icon": "server"');
    expect(result.note.contentMarkdown).toContain('"paletteId": "deep-blue"');
  });

  it("用户只移动节点也会拒绝旧视觉 patch", () => {
    const note = createConversationCanvasNote("flowchart", "流程图", "chat-stale-visual");
    const requestBaseHash = conversationCanvasBaseHash(note);
    const parsed = parseFlowchartMarkdown(note.contentMarkdown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const documentHash = computeFlowchartDocumentHash(parsed.document);
    const moved = structuredClone(parsed.document);
    moved.nodes[0].position.x = 50;
    const changedNote = { ...note, contentMarkdown: note.contentMarkdown.replace('"x": 0', '"x": 50') };
    expect(conversationCanvasBaseHash(changedNote)).toBe(requestBaseHash);
    expect(computeFlowchartDocumentHash(moved)).not.toBe(documentHash);
    const response = fencedBlock("mona-flowchart-patch", {
      baseHash: requestBaseHash,
      baseDocumentHash: documentHash,
      ops: [{ name: "setTheme", theme: { stylePreset: "soft", paletteId: "green", preserveManualStyles: true } }],
    });
    const result = applyConversationCanvasResponse(changedNote, response, "message-stale-visual", requestBaseHash);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.message).toContain("布局或样式");
  });

  it("应用主会话返回的完整思维导图", () => {
    const note = createConversationCanvasNote("mindmap", "产品规划思维导图", "chat-456");
    const requestBaseHash = conversationCanvasBaseHash(note);
    const response = [
      "已整理产品规划结构。",
      "",
      "```mindmap",
      "# 产品规划思维导图",
      "- 用户需求",
      "  - 访谈",
      "- 版本路线",
      "```",
    ].join("\n");

    const result = applyConversationCanvasResponse(
      note,
      response,
      "message-mindmap-1",
      requestBaseHash,
    );

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.note.contentMarkdown).toContain("用户需求");
    expect(result.note.contentMarkdown).toContain("版本路线");
  });

  it("请求 baseHash 与当前画布变化后返回 stale", () => {
    const note = createConversationCanvasNote("flowchart", "退款审批流程图", "chat-123");
    const requestBaseHash = conversationCanvasBaseHash(note);
    const changedNote: OperationNote = {
      ...note,
      contentMarkdown: note.contentMarkdown.replace('"label": "开始"', '"label": "已提交"'),
    };

    expect(conversationCanvasBaseHash(changedNote)).not.toBe(requestBaseHash);

    const result = applyConversationCanvasResponse(changedNote, "", "message-2", requestBaseHash);

    expect(result).toEqual({
      status: "stale",
      message: "生成期间画布已被修改，请重新发送修改要求",
    });
  });
});
