import { describe, expect, it } from "vitest";

import {
  serializeFlowchartMarkdown,
  type FlowchartDocument,
} from "../flowchart/flowchart-document";
import {
  createBlankDiagramDocument,
  createShapeElement,
  type DiagramDocument,
} from "./diagram-document";
import {
  buildDiagramIndexMarkdown,
  buildDiagramPlainText,
  countDiagramFences,
  extractDiagramFence,
  isDiagramMarkdown,
  parseDiagramMarkdown,
  parseDiagramOrFlowchartMarkdown,
  serializeDiagramMarkdown,
} from "./diagram-serializer";

function sampleDoc(): DiagramDocument {
  const doc = createBlankDiagramDocument("flowchart");
  doc.elements = [
    createShapeElement("n-start", "pill", "开始", { x: 0, y: 0 }, { role: "start" }),
    createShapeElement("n-end", "pill", "结束", { x: 0, y: 120 }, { role: "end" }),
  ];
  doc.connectors = [
    {
      id: "c1",
      source: { elementId: "n-start" },
      target: { elementId: "n-end" },
      route: "orthogonal",
      markerStart: "none",
      markerEnd: "arrow-closed",
      stroke: { color: "#333", width: 1.5, style: "solid" },
      zIndex: 0,
      label: [{ id: "c1-t0", kind: "paragraph", text: "提交" }],
    },
  ];
  return doc;
}

describe("extractDiagramFence / countDiagramFences", () => {
  it("提取围栏内容与偏移", () => {
    const md = '前言\n```mona-diagram\n{"a":1}\n```\n后记';
    const extracted = extractDiagramFence(md);
    expect(extracted).not.toBeNull();
    expect(extracted!.content).toBe('{"a":1}\n');
    expect(md.slice(extracted!.startOffset, extracted!.endOffset)).toBe(
      '```mona-diagram\n{"a":1}\n```',
    );
  });

  it("找不到围栏返回 null，计数为 0", () => {
    expect(extractDiagramFence("# 普通笔记")).toBeNull();
    expect(countDiagramFences("# 普通笔记")).toBe(0);
  });

  it("统计多个围栏", () => {
    const md = "```mona-diagram\n{}\n```\n\n```mona-diagram\n{}\n```";
    expect(countDiagramFences(md)).toBe(2);
  });

  it("未闭合围栏返回 null", () => {
    expect(extractDiagramFence("```mona-diagram\n{}")).toBeNull();
  });
});

describe("serializeDiagramMarkdown / parseDiagramMarkdown 往返", () => {
  it("序列化 → 解析往返无损", () => {
    const doc = sampleDoc();
    const md = serializeDiagramMarkdown("测试图", doc);
    const parsed = parseDiagramMarkdown(md);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.title).toBe("测试图");
    expect(parsed.document).toEqual(doc);
  });

  it("序列化输出恰好一个 mona-diagram 围栏", () => {
    const md = serializeDiagramMarkdown("t", sampleDoc());
    expect(countDiagramFences(md)).toBe(1);
  });

  it("序列化使用 2 空格 JSON 格式化（便于 diff）", () => {
    const md = serializeDiagramMarkdown("t", sampleDoc());
    const fence = extractDiagramFence(md)!;
    expect(fence.content).toContain('\n  "version": 2,');
  });

  it("空标题序列化为占位标题，解析后得到占位标题", () => {
    const doc = createBlankDiagramDocument("freeform");
    const md = serializeDiagramMarkdown("", doc);
    const parsed = parseDiagramMarkdown(md);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.title).toBe("未命名图表");
    expect(parsed.document).toEqual(doc);
  });

  it("往返保持各元素类型字段", () => {
    const doc = createBlankDiagramDocument("sequence");
    doc.elements = [
      {
        id: "l1",
        type: "lifeline",
        position: { x: 0, y: 0 },
        size: { width: 140, height: 320 },
        rotation: 0,
        zIndex: 0,
        title: "用户",
        participantRole: "actor",
      },
      {
        id: "a1",
        type: "activation",
        position: { x: 60, y: 50 },
        size: { width: 12, height: 80 },
        rotation: 0,
        zIndex: 1,
        lifelineId: "l1",
      },
    ];
    const parsed = parseDiagramMarkdown(serializeDiagramMarkdown("时序", doc));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document).toEqual(doc);
  });
});

describe("parseDiagramMarkdown — 错误处理", () => {
  it("缺少围栏返回错误而不抛异常", () => {
    const result = parseDiagramMarkdown("# 只有标题");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("mona-diagram");
  });

  it("多个围栏返回错误", () => {
    const doc = sampleDoc();
    const md = serializeDiagramMarkdown("t", doc) + "\n" + serializeDiagramMarkdown("t", doc);
    const result = parseDiagramMarkdown(md);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("只能有一个");
  });

  it("JSON 解析失败返回错误", () => {
    const result = parseDiagramMarkdown("```mona-diagram\n{invalid json\n```");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("JSON 解析失败");
  });

  it("校验失败返回带 code 的错误，不创建空文档", () => {
    const result = parseDiagramMarkdown('```mona-diagram\n{"version":1}\n```');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("version-unsupported");
  });

  it("解析时剥离未声明字段（规范化）", () => {
    const doc = sampleDoc();
    const raw = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    raw.hackerField = true;
    const md = `# t\n\n\`\`\`mona-diagram\n${JSON.stringify(raw)}\n\`\`\``;
    const parsed = parseDiagramMarkdown(md);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect("hackerField" in parsed.document).toBe(false);
  });
});

describe("parseDiagramOrFlowchartMarkdown — 双格式读取", () => {
  function v1Markdown(): string {
    const v1: FlowchartDocument = {
      version: 1,
      direction: "LR",
      nodes: [
        { id: "n1", kind: "start", label: "开始", position: { x: 0, y: 0 } },
        { id: "n2", kind: "process", label: "处理", position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
    };
    return serializeFlowchartMarkdown("旧流程图", v1);
  }

  it("v2 优先解析，format 为 v2", () => {
    const result = parseDiagramOrFlowchartMarkdown(serializeDiagramMarkdown("新图", sampleDoc()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("v2");
    expect(result.warnings).toEqual([]);
  });

  it("v1 围栏迁移为 v2 内存模型，format 为 v1-migrated", () => {
    const result = parseDiagramOrFlowchartMarkdown(v1Markdown());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("v1-migrated");
    expect(result.title).toBe("旧流程图");
    expect(result.document.version).toBe(2);
    expect(result.document.diagramKind).toBe("flowchart");
    expect(result.document.layout).toEqual({ direction: "LR" });
    expect(result.document.elements).toHaveLength(2);
    expect(result.document.connectors).toHaveLength(1);
  });

  it("两种围栏同时存在视为硬错误", () => {
    const md = v1Markdown() + "\n" + serializeDiagramMarkdown("v2", sampleDoc());
    const result = parseDiagramOrFlowchartMarkdown(md);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("权威数据源");
  });

  it("两种围栏都缺失返回错误", () => {
    const result = parseDiagramOrFlowchartMarkdown("# 普通笔记");
    expect(result.ok).toBe(false);
  });

  it("isDiagramMarkdown 识别 v1 与 v2", () => {
    expect(isDiagramMarkdown(serializeDiagramMarkdown("t", sampleDoc()))).toBe(true);
    expect(isDiagramMarkdown(v1Markdown())).toBe(true);
    expect(isDiagramMarkdown("# 普通笔记")).toBe(false);
  });
});

describe("buildDiagramIndexMarkdown — 文本投影", () => {
  it("包含标题、图型、元素与连接", () => {
    const projection = buildDiagramIndexMarkdown("我的流程", sampleDoc());
    expect(projection).toContain("# 我的流程");
    expect(projection).toContain("类型：流程图");
    expect(projection).toContain("[start] 开始");
    expect(projection).toContain("[end] 结束");
    expect(projection).toContain("开始 → 结束：提交");
  });

  it("空标题使用占位", () => {
    const projection = buildDiagramIndexMarkdown("", createBlankDiagramDocument("freeform"));
    expect(projection).toContain("# 未命名图表");
  });

  it("空画布显示占位行", () => {
    const projection = buildDiagramIndexMarkdown("t", createBlankDiagramDocument("freeform"));
    expect(projection).toContain("（无元素）");
    expect(projection).toContain("（无连接）");
  });

  it("文本投影是只读派生产物：序列化输出中文本投影在围栏之前", () => {
    const md = serializeDiagramMarkdown("顺序检查", sampleDoc());
    const projectionEnd = md.indexOf("```mona-diagram");
    const projection = md.slice(0, projectionEnd);
    expect(projection).toContain("# 顺序检查");
    expect(projection).toContain("## 元素");
    expect(projection).toContain("## 连接");
  });
});

describe("buildDiagramPlainText", () => {
  it("拼接标题、元素文本与连线标签", () => {
    const text = buildDiagramPlainText("标题", sampleDoc());
    expect(text).toContain("标题");
    expect(text).toContain("开始");
    expect(text).toContain("结束");
    expect(text).toContain("提交");
  });

  it("无标签连线不产生文本", () => {
    const doc = createBlankDiagramDocument("freeform");
    doc.connectors = [
      {
        id: "c1",
        source: { point: { x: 0, y: 0 } },
        target: { point: { x: 1, y: 1 } },
        route: "straight",
        markerStart: "none",
        markerEnd: "none",
        stroke: { color: "#333", width: 1, style: "solid" },
        zIndex: 0,
      },
    ];
    expect(buildDiagramPlainText("t", doc)).toBe("t");
  });
});
