import { describe, expect, it } from "vitest";

import {
  DIAGRAM_CAPABILITY_REGISTRY,
  agentWritableConnectorFields,
  agentWritableElementFields,
  buildAgentContract,
  createCapabilityDefault,
  declaredConnectorFields,
  declaredElementFields,
  getCapability,
  getElementCapability,
  listCapabilities,
} from "./diagram-capabilities";
import {
  DIAGRAM_ELEMENT_TYPES,
  type DiagramDocument,
  type DiagramElement,
  createBlankDiagramDocument,
} from "./diagram-document";
import { parseDiagramMarkdown, serializeDiagramMarkdown } from "./diagram-serializer";
import { validateDiagramDocument } from "./diagram-validator";

/** 把能力默认对象装进文档（处理 image/activation 的引用前提）。 */
function docWith(capabilityId: string): DiagramDocument {
  const created = createCapabilityDefault(capabilityId);
  if (!created) throw new Error(`unknown capability: ${capabilityId}`);
  const doc = createBlankDiagramDocument("freeform");
  doc.elements = [];
  if ("source" in created) {
    doc.connectors = [created];
    return doc;
  }
  const element = created;
  if (element.type === "image") {
    doc.assets = [{ id: "asset-placeholder", path: "assets/placeholder.png", mime: "image/png" }];
  }
  if (element.type === "activation") {
    doc.elements.push({
      id: "lifeline-placeholder",
      type: "lifeline",
      position: { x: 0, y: 0 },
      size: { width: 120, height: 200 },
      rotation: 0,
      zIndex: 0,
      title: "参与者",
    });
  }
  doc.elements.push(element);
  return doc;
}

describe("能力注册表完整性", () => {
  it("注册表覆盖全部 11 种元素类型 + connector", () => {
    const elementCaps = DIAGRAM_CAPABILITY_REGISTRY.filter((c) => c.category === "element");
    for (const type of DIAGRAM_ELEMENT_TYPES) {
      expect(
        elementCaps.some((c) => c.elementType === type),
        `缺少元素能力：${type}`,
      ).toBe(true);
    }
    expect(DIAGRAM_CAPABILITY_REGISTRY.some((c) => c.category === "connector")).toBe(true);
  });

  it("capability id 唯一", () => {
    const ids = DIAGRAM_CAPABILITY_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getCapability / getElementCapability 查找", () => {
    expect(getCapability("shape")?.elementType).toBe("shape");
    expect(getElementCapability("table")?.id).toBe("table");
    expect(getCapability("nonexistent")).toBeUndefined();
  });
});

describe("supportedKinds 过滤", () => {
  it("sequence 图型包含 lifeline/activation，flowchart 不包含", () => {
    const sequence = listCapabilities("sequence").map((c) => c.id);
    expect(sequence).toContain("lifeline");
    expect(sequence).toContain("activation");
    const flowchart = listCapabilities("flowchart").map((c) => c.id);
    expect(flowchart).not.toContain("lifeline");
    expect(flowchart).not.toContain("activation");
  });

  it("framework 包含 brace/table，flowchart 不包含", () => {
    const framework = listCapabilities("framework").map((c) => c.id);
    expect(framework).toContain("brace");
    expect(framework).toContain("table");
    const flowchart = listCapabilities("flowchart").map((c) => c.id);
    expect(flowchart).not.toContain("brace");
    expect(flowchart).not.toContain("table");
  });

  it("所有图型都包含 shape/text/connector", () => {
    for (const kind of ["flowchart", "erd", "matrix", "freeform"] as const) {
      const ids = listCapabilities(kind).map((c) => c.id);
      expect(ids).toContain("shape");
      expect(ids).toContain("text");
      expect(ids).toContain("connector");
    }
  });
});

describe("createDefaults 默认对象", () => {
  it.each(DIAGRAM_CAPABILITY_REGISTRY.map((c) => [c.id] as const))(
    "%s 默认对象通过文档校验",
    (id) => {
      const doc = docWith(id);
      const result = validateDiagramDocument(doc);
      expect(result.ok, JSON.stringify(result)).toBe(true);
    },
  );

  it.each(DIAGRAM_CAPABILITY_REGISTRY.map((c) => [c.id] as const))(
    "%s 默认对象可序列化往返",
    (id) => {
      const doc = docWith(id);
      const markdown = serializeDiagramMarkdown("测试", doc);
      const parsed = parseDiagramMarkdown(markdown);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.document.elements).toEqual(doc.elements);
      expect(parsed.document.connectors).toEqual(doc.connectors);
    },
  );

  it("每次调用生成不同 id（不共享引用）", () => {
    const a = createCapabilityDefault("shape") as DiagramElement;
    const b = createCapabilityDefault("shape") as DiagramElement;
    expect(a.id).not.toBe(b.id);
  });

  it("未知 capability 返回 null", () => {
    expect(createCapabilityDefault("nope")).toBeNull();
  });
});

describe("字段白名单一致性", () => {
  it.each(DIAGRAM_CAPABILITY_REGISTRY.map((c) => [c.id] as const))(
    "%s 默认对象的键都在 declaredFields 内",
    (id) => {
      const created = createCapabilityDefault(id);
      if (!created) throw new Error("unreachable");
      const declared =
        "source" in created
          ? declaredConnectorFields()
          : declaredElementFields((created as DiagramElement).type);
      for (const key of Object.keys(created)) {
        expect(declared, `字段 ${key} 未声明`).toContain(key);
      }
    },
  );

  it("agentWritableFields ⊆ declaredFields，且排除 id/type/parentId", () => {
    for (const type of DIAGRAM_ELEMENT_TYPES) {
      const declared = declaredElementFields(type);
      const writable = agentWritableElementFields(type);
      for (const f of writable) expect(declared).toContain(f);
      expect(writable).not.toContain("id");
      expect(writable).not.toContain("type");
      expect(writable).not.toContain("parentId");
    }
    const connectorWritable = agentWritableConnectorFields();
    for (const f of connectorWritable) expect(declaredConnectorFields()).toContain(f);
    expect(connectorWritable).not.toContain("id");
  });

  it("所有元素可写字段都包含几何与样式基础字段", () => {
    for (const type of DIAGRAM_ELEMENT_TYPES) {
      const writable = agentWritableElementFields(type);
      expect(writable).toContain("position");
      expect(writable).toContain("size");
      expect(writable).toContain("rotation");
      expect(writable).toContain("zIndex");
      expect(writable).toContain("opacity");
      expect(writable).toContain("semantic");
    }
  });

  it("导出支持与渲染器声明存在", () => {
    for (const cap of DIAGRAM_CAPABILITY_REGISTRY) {
      expect(cap.renderer.length).toBeGreaterThan(0);
      expect(cap.exportSupport).toEqual({ png: true, svg: true, pdf: true });
      expect(cap.inspectorFields.length).toBeGreaterThan(0);
    }
  });
});

describe("Agent 契约生成", () => {
  it("契约确定性：两次生成一致", () => {
    expect(buildAgentContract("flowchart")).toBe(buildAgentContract("flowchart"));
  });

  it("flowchart 契约排除 lifeline，sequence 契约包含 lifeline", () => {
    const flowchart = buildAgentContract("flowchart");
    expect(flowchart).not.toContain("lifeline");
    const sequence = buildAgentContract("sequence");
    expect(sequence).toContain("lifeline");
    expect(sequence).toContain("activation");
  });

  it("契约包含协议版本、枚举与限制", () => {
    const contract = buildAgentContract("flowchart");
    expect(contract).toContain("mona-diagram-patch");
    expect(contract).toContain("protocolVersion");
    expect(contract).toContain("baseDocumentHash");
    expect(contract).toContain("arrow-closed");
    expect(contract).toContain("orthogonal");
    expect(contract).toContain("linear-gradient");
    expect(contract).toContain("2000"); // maxElements
    expect(contract).toContain("diamond");
    expect(contract).toContain("rectangle");
  });

  it("契约包含安全边界声明", () => {
    const contract = buildAgentContract("architecture");
    expect(contract).toContain("assetId");
    expect(contract).toMatch(/禁止|不允许/);
  });

  it("erd 契约包含 table 元素，flowchart 不包含", () => {
    expect(buildAgentContract("erd")).toContain("- table：");
    expect(buildAgentContract("flowchart")).not.toContain("- table：");
  });
});
