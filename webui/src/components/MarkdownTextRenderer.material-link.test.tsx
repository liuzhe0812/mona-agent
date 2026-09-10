import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import MarkdownTextRenderer from "./MarkdownTextRenderer";
import { useMaterialsOpenStore } from "@/lib/materials-open-store";

function materialLink(label: string): HTMLElement {
  const text = screen.getByText(label);
  const link = text.closest("[role='button'], a");
  if (!(link instanceof HTMLElement)) throw new Error(`找不到资料链接：${label}`);
  link.addEventListener("click", (event) => event.preventDefault(), { once: true });
  return link;
}

describe("MarkdownTextRenderer material links", () => {
  beforeEach(() => {
    useMaterialsOpenStore.getState().clear();
  });

  it("stores an Agent-scoped original-material link", async () => {
    const user = userEvent.setup();
    render(
      <MarkdownTextRenderer>
        {'[查看原文](mona:material?agentId=agent.demo&path=raw%2Fdocs%2Fguide.pdf&location=Page%2012)'}
      </MarkdownTextRenderer>,
    );

    await user.click(materialLink("查看原文"));

    expect(useMaterialsOpenStore.getState().pending).toEqual(expect.objectContaining({
      agentId: "agent.demo",
      kind: "raw",
      path: "raw/docs/guide.pdf",
      location: "Page 12",
    }));
  });

  it("stores an Agent-scoped Wiki link without its wiki prefix", async () => {
    const user = userEvent.setup();
    render(
      <MarkdownTextRenderer>
        {'[查看知识页面](mona:material?agentId=agent.demo&path=wiki%2Fconcepts%2Fagent.md&location=实体关系)'}
      </MarkdownTextRenderer>,
    );

    await user.click(materialLink("查看知识页面"));

    expect(useMaterialsOpenStore.getState().pending).toEqual(expect.objectContaining({
      agentId: "agent.demo",
      kind: "wiki",
      path: "concepts/agent.md",
      location: "实体关系",
    }));
  });

  it("keeps legacy knowledgeBaseId links working", async () => {
    const user = userEvent.setup();
    render(
      <MarkdownTextRenderer>
        {'[打开旧资料](mona:material?knowledgeBaseId=kb-product&path=raw%2Flegacy.pdf&location=Page%201)'}
      </MarkdownTextRenderer>,
    );

    await user.click(materialLink("打开旧资料"));

    expect(useMaterialsOpenStore.getState().pending).toEqual(expect.objectContaining({
      knowledgeBaseId: "kb-product",
      kind: "raw",
      path: "raw/legacy.pdf",
      location: "Page 1",
    }));
  });
});
