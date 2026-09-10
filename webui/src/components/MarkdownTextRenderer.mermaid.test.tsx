import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MarkdownTextRenderer from "./MarkdownTextRenderer";

const componentMocks = vi.hoisted(() => ({
  mermaid: vi.fn(),
  codeBlock: vi.fn(),
}));

vi.mock("@/components/common/mermaid-diagram", async () => {
  const React = await import("react");
  function MermaidDiagram({ code }: { code: string }) {
    componentMocks.mermaid(code);
    return <div data-testid="mock-mermaid-diagram">{code}</div>;
  }
  return {
    MermaidDiagram,
    unwrapMermaidPre(children: ReactNode) {
      const childNodes = React.Children.toArray(children);
      if (childNodes.length !== 1) return null;
      const child = childNodes[0];
      return React.isValidElement(child) && child.type === MermaidDiagram ? child : null;
    },
  };
});

vi.mock("@/components/CodeBlock", () => ({
  CodeBlock: ({
    language,
    code,
    highlight,
  }: {
    language: string;
    code: string;
    highlight: boolean;
  }) => {
    componentMocks.codeBlock({ language, code, highlight });
    return <pre data-testid="mock-code-block">{code}</pre>;
  },
}));

const mermaidFence = ["```mermaid", "flowchart LR", "  A --> B", "```"].join("\n");

describe("MarkdownTextRenderer Mermaid fences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a complete Mermaid fence to MermaidDiagram when highlighting is enabled", () => {
    render(<MarkdownTextRenderer>{mermaidFence}</MarkdownTextRenderer>);

    expect(componentMocks.mermaid).toHaveBeenCalledOnce();
    expect(componentMocks.mermaid).toHaveBeenCalledWith("flowchart LR\n  A --> B");
    expect(screen.getByTestId("mock-mermaid-diagram")).toHaveTextContent("flowchart LR");
    expect(componentMocks.codeBlock).not.toHaveBeenCalled();
  });

  it("keeps Mermaid source in a code block while highlighting is disabled", () => {
    render(
      <MarkdownTextRenderer highlightCode={false}>{mermaidFence}</MarkdownTextRenderer>,
    );

    expect(componentMocks.mermaid).not.toHaveBeenCalled();
    expect(componentMocks.codeBlock).toHaveBeenCalledOnce();
    expect(componentMocks.codeBlock).toHaveBeenCalledWith({
      language: "mermaid",
      code: "flowchart LR\n  A --> B",
      highlight: false,
    });
    expect(screen.queryByTestId("mock-mermaid-diagram")).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-code-block")).toHaveTextContent("flowchart LR");
  });
});
