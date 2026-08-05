import { describe, expect, it } from "vitest";

import {
  applyPendingDiagramPatch,
  formatDiagramSummary,
  prepareDiagramPatch,
} from "./diagram-apply";
import {
  createBlankDiagramDocument,
  createShapeElement,
  generateDiagramId,
  type DiagramDocument,
} from "./diagram-document";
import { computeDiagramDocumentHash, computeDiagramSemanticHash } from "./diagram-hash";
import { serializeDiagramMarkdown, parseDiagramMarkdown } from "./diagram-serializer";
import type { DiagramDocumentStateSnapshot } from "./DiagramSelectionContext";

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function docStateOf(doc: DiagramDocument, revision = 0): DiagramDocumentStateSnapshot {
  return {
    revision,
    documentHash: computeDiagramDocumentHash(doc),
    semanticHash: computeDiagramSemanticHash(doc),
  };
}

function blankDoc(): DiagramDocument {
  return createBlankDiagramDocument("freeform");
}

function markdownOf(doc: DiagramDocument): string {
  return serializeDiagramMarkdown("测试图表", doc);
}

function patchText(patch: Record<string, unknown>): string {
  return `好的，我来修改。\n\n\`\`\`mona-diagram-patch\n${JSON.stringify(patch, null, 2)}\n\`\`\`\n`;
}

function addShapePatch(doc: DiagramDocument, revision: number): Record<string, unknown> {
  const shape = createShapeElement(generateDiagramId("shape"), "rectangle", "新节点", {
    x: 10,
    y: 20,
  });
  return {
    protocolVersion: 2,
    capabilityVersion: 1,
    baseRevision: revision,
    baseDocumentHash: computeDiagramDocumentHash(doc),
    ops: [{ op: "addElements", elements: [shape] }],
  };
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

describe("prepareDiagramPatch", () => {
  it("有效 patch → ready，摘要正确", () => {
    const doc = blankDoc();
    const md = markdownOf(doc);
    const result = prepareDiagramPatch(
      patchText(addShapePatch(doc, 0)),
      md,
      "msg-1",
      docStateOf(doc),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pending.status).toBe("ready");
    expect(result.pending.summary.addedElementIds).toHaveLength(1);
    expect(result.pending.proposedState.document.elements).toHaveLength(1);
  });

  it("无 patch block → not ok", () => {
    const doc = blankDoc();
    const result = prepareDiagramPatch("纯文本回答", markdownOf(doc), "msg-1", docStateOf(doc));
    expect(result.ok).toBe(false);
  });

  it("非法 op（未声明字段）→ pending.status = invalid", () => {
    const doc = blankDoc();
    const shape = createShapeElement(generateDiagramId("shape"), "rectangle", "x", { x: 0, y: 0 });
    const docWithShape: DiagramDocument = { ...doc, elements: [shape] };
    const patch = {
      protocolVersion: 2,
      capabilityVersion: 1,
      baseRevision: 0,
      baseDocumentHash: computeDiagramDocumentHash(docWithShape),
      ops: [{ op: "updateElements", updates: [{ id: shape.id, patch: { nope: 1 } }] }],
    };
    const result = prepareDiagramPatch(
      patchText(patch),
      markdownOf(docWithShape),
      "msg-1",
      docStateOf(docWithShape),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pending.status).toBe("invalid");
    expect(result.pending.error).toBeTruthy();
  });

  it("replaceDocument 与其他 op 混用 → not ok", () => {
    const doc = blankDoc();
    const patch = {
      protocolVersion: 2,
      capabilityVersion: 1,
      baseRevision: 0,
      baseDocumentHash: computeDiagramDocumentHash(doc),
      ops: [
        { op: "replaceDocument", document: blankDoc() },
        { op: "addElements", elements: [createShapeElement(generateDiagramId("shape"), "ellipse", "y", { x: 0, y: 0 })] },
      ],
    };
    const result = prepareDiagramPatch(patchText(patch), markdownOf(doc), "msg-1", docStateOf(doc));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

describe("applyPendingDiagramPatch", () => {
  it("状态匹配 → 应用成功并生成可解析 markdown", () => {
    const doc = blankDoc();
    const md = markdownOf(doc);
    const state = docStateOf(doc);
    const prepared = prepareDiagramPatch(patchText(addShapePatch(doc, 0)), md, "msg-1", state);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const applied = applyPendingDiagramPatch(prepared.pending, md, "测试图表", state);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const parsed = parseDiagramMarkdown(applied.markdown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.elements).toHaveLength(1);
    expect(parsed.document.elements[0].type).toBe("shape");
  });

  it("revision 不匹配 → stale 拒绝", () => {
    const doc = blankDoc();
    const md = markdownOf(doc);
    const prepared = prepareDiagramPatch(patchText(addShapePatch(doc, 0)), md, "msg-1", docStateOf(doc));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // 模拟用户期间编辑：revision 前进
    const staleState = docStateOf(doc, 1);
    const applied = applyPendingDiagramPatch(prepared.pending, md, "测试图表", staleState);
    expect(applied.ok).toBe(false);
  });

  it("documentHash 不匹配 → stale 拒绝", () => {
    const doc = blankDoc();
    const md = markdownOf(doc);
    const prepared = prepareDiagramPatch(patchText(addShapePatch(doc, 0)), md, "msg-1", docStateOf(doc));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // 文档已被修改：hash 变化
    const changed: DiagramDocument = {
      ...doc,
      elements: [createShapeElement(generateDiagramId("shape"), "diamond", "干扰", { x: 0, y: 0 })],
    };
    const applied = applyPendingDiagramPatch(
      prepared.pending,
      markdownOf(changed),
      "测试图表",
      docStateOf(changed),
    );
    expect(applied.ok).toBe(false);
  });

  it("已 applied / ignored / invalid 的 pending 拒绝重复应用", () => {
    const doc = blankDoc();
    const md = markdownOf(doc);
    const prepared = prepareDiagramPatch(patchText(addShapePatch(doc, 0)), md, "msg-1", docStateOf(doc));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const state = docStateOf(doc);
    for (const status of ["applied", "ignored", "invalid"] as const) {
      const applied = applyPendingDiagramPatch(
        { ...prepared.pending, status },
        md,
        "测试图表",
        state,
      );
      expect(applied.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 摘要格式化
// ---------------------------------------------------------------------------

describe("formatDiagramSummary", () => {
  it("替换文档", () => {
    expect(
      formatDiagramSummary({
        addedElementIds: [],
        updatedElementIds: [],
        removedElementIds: [],
        addedConnectorIds: [],
        updatedConnectorIds: [],
        removedConnectorIds: [],
        attachedAssetIds: [],
        replacedDocument: true,
        canvasUpdated: false,
        layoutApplied: false,
      }),
    ).toContain("替换");
  });

  it("增量摘要", () => {
    const text = formatDiagramSummary({
      addedElementIds: ["a", "b"],
      updatedElementIds: ["c"],
      removedElementIds: ["d"],
      addedConnectorIds: ["e"],
      updatedConnectorIds: [],
      removedConnectorIds: ["f"],
      attachedAssetIds: [],
      replacedDocument: false,
      canvasUpdated: true,
      layoutApplied: false,
    });
    expect(text).toContain("新增 2 元素");
    expect(text).toContain("修改 1 元素");
    expect(text).toContain("删除 1 元素");
    expect(text).toContain("新增 1 连线");
    expect(text).toContain("删除 1 连线");
    expect(text).toContain("画布");
  });
});
