import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SystemAssistant } from "./SystemAssistant";

vi.mock("./SystemAgentChat", () => ({
  SystemAgentChat: ({ task }: { task: { error: string } | null }) => <p>{task?.error}</p>,
}));

describe("SystemAssistant", () => {
  it("keeps the wide right rail constrained so its content can scroll", () => {
    render(
      <SystemAssistant
        tab="software"
        requestId={0}
        storage={{ result: null, clean: vi.fn() }}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={null}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Mona 系统管家" }).className).toContain("min-h-0");
  });

  it("opens the embedded Agent for a handoff and keeps the planner available", async () => {
    render(
      <SystemAssistant
        tab="software"
        requestId={0}
        storage={{ result: null, clean: vi.fn() }}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={{ id: "failed-uninstall", title: "卸载 Notepad++", action: "卸载软件", target: "Notepad++", arguments: { id: null, name: "Notepad++" }, error: "WinGet exit code 1603" }}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={null}
      />,
    );

    expect(await screen.findByText("WinGet exit code 1603")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回系统方案" }));
    expect(screen.getByText(/从一个问题开始/)).toBeTruthy();
  });
});
