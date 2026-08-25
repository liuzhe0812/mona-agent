import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

const detail = {
  agent: { id: "agent.demo", displayName: "Demo Agent", enabled: true },
  definition: {
    id: "agent.demo",
    model: "demo-model",
    toolAllowlist: [],
    canDelegate: false,
    skills: [],
    packageId: "",
    packageVersion: "",
  },
  config: {
    revision: 1,
    enabled: true,
    disabledSkills: [],
    delegationEnabled: false,
  },
  effective: {
    agentId: "agent.demo",
    enabled: true,
    displayName: "Demo Agent",
    disabledSkills: [],
    delegationEnabled: false,
  },
  toolCatalog: [
    { name: "web_search", description: "Search the web", available: true, readOnly: true },
    { name: "generate_image", description: "Generate an image", available: false, readOnly: false },
  ],
  data: { memoryFiles: 0, memoryBytes: 0, skillFiles: 0, skillBytes: 0 },
};

vi.mock("@/lib/api", () => ({
  getAgentDetail: vi.fn(async () => detail),
  listAgentInstructions: vi.fn(async () => [
    { key: "soul", filename: "SOUL.md", content: "", contentHash: "" },
    { key: "agents", filename: "AGENTS.md", content: "", contentHash: "" },
    { key: "user", filename: "USER.md", content: "", contentHash: "" },
    { key: "memory", filename: "MEMORY.md", content: "", contentHash: "" },
  ]),
  listAgentSkills: vi.fn(async () => []),
  listAgentChangeProposals: vi.fn(async () => []),
  listAgentInstructionHistory: vi.fn(async () => []),
}));
vi.mock("@/providers/ClientProvider", () => ({
  useClientContextOrNull: () => ({
    token: "test-token",
    client: { onAgentsUpdated: () => () => {} },
  }),
}));

import { AgentManagementView } from "./AgentManagementView";

describe("AgentManagementView navigation surfaces", () => {
  it("uses transparent tabs and a red instruction selection marker", async () => {
    const user = userEvent.setup();
    render(
      <AgentManagementView
        agentId="agent.demo"
        onBack={() => {}}
        onStartDirect={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText("Demo Agent")).toBeInTheDocument());
    const tabs = screen.getByRole("tablist");
    expect(tabs).toHaveClass("!bg-transparent", "p-0");

    const overview = screen.getByRole("tab", { name: "概览" });
    expect(overview).toHaveClass(
      "data-[state=active]:!bg-transparent",
      "data-[state=active]:!shadow-none",
      "data-[state=active]:after:bg-[hsl(var(--brand-red))]",
    );

    await user.click(screen.getByRole("tab", { name: "个性与规则" }));
    const instruction = await screen.findByRole("button", { name: "SOUL.md · 个性" });
    expect(instruction).toHaveClass("bg-transparent", "before:bg-[hsl(var(--brand-red))]");
    expect(instruction).not.toHaveClass("bg-accent");

    await user.click(screen.getByRole("tab", { name: "技能" }));
    expect(screen.queryByText("添加专属 Skill")).not.toBeInTheDocument();
    expect(screen.getByText("已安装技能")).toBeInTheDocument();
  });

  it("renders tools as compact name-and-switch rows", async () => {
    const user = userEvent.setup();
    render(<AgentManagementView agentId="agent.demo" onBack={() => {}} onStartDirect={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: "工具" }));

    expect(screen.getByText("网页搜索")).toBeInTheDocument();
    expect(screen.getByText("图片生成")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "网页搜索工具" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "图片生成工具" })).toBeInTheDocument();
    expect(screen.queryByText("Search the web")).not.toBeInTheDocument();
    expect(screen.queryByText("继承推荐工具")).not.toBeInTheDocument();
  });
});
