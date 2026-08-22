import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentSummary } from "@/lib/types";
import { PartnersView } from "./PartnersView";

function agent(partial: Partial<AgentSummary> & { id: string }): AgentSummary {
  return {
    displayName: partial.id,
    enabled: true,
    ...partial,
  };
}

describe("PartnersView (stock-module design §4.4 visibility)", () => {
  it("hides internal agents from the global partner list", () => {
    render(
      <PartnersView
        agents={[
          agent({ id: "mona", displayName: "Mona" }),
          agent({ id: "com.mona.a-share-analyst", displayName: "A-Share Analyst" }),
          agent({
            id: "com.mona.stock-tech-analyst",
            displayName: "Tech Analyst",
            visibility: "internal",
          }),
        ]}
        onStartDirect={vi.fn()}
        onCreateRoom={vi.fn()}
      />,
    );

    expect(screen.getByText("A-Share Analyst")).toBeInTheDocument();
    expect(screen.queryByText("Tech Analyst")).not.toBeInTheDocument();
  });
});
