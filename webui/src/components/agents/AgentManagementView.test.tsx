import { render, screen, waitFor, within } from "@testing-library/react";
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
    knowledgeBaseScope: { mode: "all", knowledgeBaseIds: [] },
    disabledSkills: [],
    delegationEnabled: false,
  },
  effective: {
    agentId: "agent.demo",
    enabled: true,
    displayName: "Demo Agent",
    knowledgeBaseScope: { mode: "all", knowledgeBaseIds: [] },
    disabledSkills: [],
    delegationEnabled: false,
  },
  toolCatalog: [
    { name: "web_search", description: "Search the web", available: true, readOnly: true },
    { name: "generate_image", description: "Generate an image", available: false, readOnly: false },
    { name: "notes_search", description: "Search notes", available: true, readOnly: true },
    { name: "notes_read", description: "Read notes", available: true, readOnly: true },
    { name: "notes_create", description: "Create notes", available: true, readOnly: false },
    { name: "notes_save_image", description: "Save note image", available: true, readOnly: false },
    { name: "knowledge_search", description: "Search knowledge", available: true, readOnly: true },
    { name: "materials_search", description: "Search materials", available: true, readOnly: true },
    { name: "materials_read", description: "Read materials", available: true, readOnly: true },
    { name: "wiki_search", description: "Search Wiki", available: true, readOnly: true },
    { name: "wiki_read", description: "Read Wiki", available: true, readOnly: true },
  ],
  data: { memoryFiles: 0, memoryBytes: 0, skillFiles: 0, skillBytes: 0 },
};

const partialDetail = {
  ...detail,
  agent: { ...detail.agent, id: "agent.partial", displayName: "Partial Agent" },
  definition: { ...detail.definition, id: "agent.partial" },
  config: { ...detail.config, grantedTools: ["web_search", "notes_search", "notes_read", "materials_search"] },
  effective: { ...detail.effective, agentId: "agent.partial", displayName: "Partial Agent" },
};

const skills = [
  {
    name: "learned-research",
    ownerAgentId: "agent.demo",
    source: "private",
    category: "self_learning",
    provenance: "agent",
    editable: true,
    description: "从历史研究中整理出的分析方法。",
    content: "---\nname: learned-research\ndescription: 从历史研究中整理出的分析方法。\n---\n",
    accessCount: 7,
    createdAt: "2026-08-20T10:00:00Z",
    lastAccessedAt: "2026-08-26T10:00:00Z",
    pinned: false,
    enabled: true,
    archived: false,
    hasScripts: false,
    scriptsEnabled: false,
    contentHash: "hash-learned",
  },
  {
    name: "web-search",
    ownerAgentId: "agent.demo",
    source: "platform",
    category: "external",
    provenance: "bundled",
    editable: false,
    description: "搜索公开网页和信息。",
    accessCount: 2,
    createdAt: "2026-08-18T10:00:00Z",
    lastAccessedAt: "2026-08-25T10:00:00Z",
    pinned: false,
    enabled: true,
    archived: false,
    hasScripts: false,
    scriptsEnabled: false,
    contentHash: "hash-web",
  },
  {
    name: "analysis-experiment",
    ownerAgentId: "agent.demo",
    source: "package",
    category: "external",
    provenance: "bundled",
    editable: false,
    description: "运行科研分析脚本。",
    accessCount: 0,
    createdAt: "2026-09-10T10:00:00Z",
    lastAccessedAt: null,
    pinned: false,
    enabled: true,
    archived: false,
    hasScripts: true,
    scriptsEnabled: false,
    runtime: {
      packs: ["python-base@3.13.15", "python-academic@1.0.0"],
      optional_script_types: ["r"],
    },
    runtimeReady: false,
    runtimeError: "Mona Agent Python environment is not prepared",
    contentHash: "hash-analysis",
  },
  {
    name: "archived-research",
    ownerAgentId: "agent.demo",
    source: "private",
    category: "self_learning",
    provenance: "agent",
    editable: false,
    description: "已归档的研究技能。",
    accessCount: 1,
    createdAt: "2026-08-10T10:00:00Z",
    lastAccessedAt: "2026-08-12T10:00:00Z",
    pinned: false,
    enabled: false,
    archived: true,
    hasScripts: false,
    scriptsEnabled: false,
    contentHash: "hash-archived",
  },
];

const clientMocks = vi.hoisted(() => ({
  actOnAgentSkill: vi.fn(async () => undefined),
  startAgentSkillSetup: vi.fn(async () => ({
    schemaVersion: 1,
    jobId: "setup-1",
    agentId: "agent.demo",
    skillName: "analysis-experiment",
    contentHash: "hash-analysis",
    state: "queued" as const,
    stage: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })),
  getAgentSkillSetup: vi.fn(async () => null),
  cancelAgentSkillSetup: vi.fn(async () => ({
    schemaVersion: 1,
    jobId: "setup-1",
    agentId: "agent.demo",
    skillName: "analysis-experiment",
    contentHash: "hash-analysis",
    state: "cancelled" as const,
    stage: "cancelled",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })),
  updateAgentConfig: vi.fn(async () => undefined),
  updateAgentSkill: vi.fn(async () => undefined),
}));

vi.mock("@/lib/api", () => ({
  fetchSettings: vi.fn(async () => ({
    model_presets: [
      { name: "default", label: "默认模型", model: "demo-model", provider: "demo" },
      { name: "review", label: "评审模型", model: "review-model", provider: "demo" },
    ],
  })),
  getAgentDetail: vi.fn(async (_token: string, agentId: string) => agentId === "mona"
    ? {
        ...detail,
        agent: { ...detail.agent, id: "mona", displayName: "Mona" },
        definition: { ...detail.definition, id: "mona" },
        effective: { ...detail.effective, agentId: "mona", displayName: "Mona" },
      }
    : agentId === "agent.partial" ? partialDetail : detail),
  listAgentInstructions: vi.fn(async () => [
    { key: "soul", filename: "SOUL.md", content: "", contentHash: "" },
    { key: "agents", filename: "AGENTS.md", content: "", contentHash: "" },
    { key: "user", filename: "USER.md", content: "", contentHash: "" },
    { key: "memory", filename: "MEMORY.md", content: "", contentHash: "" },
  ]),
  listAgentSkills: vi.fn(async () => skills),
  getAgentSkill: vi.fn(async (_token: string, _agentId: string, name: string) => {
    const skill = skills.find((item) => item.name === name) ?? skills[0];
    return {
      ...skill,
      content: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n`,
    };
  }),
  listAgentChangeProposals: vi.fn(async () => []),
  listAgentInstructionHistory: vi.fn(async () => []),
}));
vi.mock("@/lib/materials-api", () => ({
  listAgentKnowledgeDocuments: vi.fn(async () => []),
  getAgentKnowledgeGraph: vi.fn(async () => ({
    nodes: [],
    edges: [],
    positions: {},
    lastScanAt: "",
  })),
  listWikiPages: vi.fn(async () => []),
  addAgentKnowledgeDocuments: vi.fn(async () => []),
  retryAgentKnowledgeDocument: vi.fn(async () => undefined),
  deleteAgentKnowledgeDocument: vi.fn(async () => undefined),
  getMaterialsRawFile: vi.fn(async () => ({ path: "", content: "", ext: "txt" })),
  getMaterialsText: vi.fn(async () => ({ path: "", content: "" })),
  getWikiPage: vi.fn(async () => ({ path: "", content: "" })),
  getEvidenceDetail: vi.fn(async () => ({})),
}));
vi.mock("@/providers/ClientProvider", () => ({
  useClientContextOrNull: () => ({
    token: "test-token",
    client: {
      onAgentsUpdated: () => () => {},
      actOnAgentSkill: clientMocks.actOnAgentSkill,
      startAgentSkillSetup: clientMocks.startAgentSkillSetup,
      getAgentSkillSetup: clientMocks.getAgentSkillSetup,
      cancelAgentSkillSetup: clientMocks.cancelAgentSkillSetup,
      updateAgentConfig: clientMocks.updateAgentConfig,
      updateAgentSkill: clientMocks.updateAgentSkill,
    },
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

    const personalization = screen.getByRole("tab", { name: /个性化|Personalization/ });
    expect(personalization).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /模型与运行|Model & Runtime/ })).not.toBeInTheDocument();

    await user.click(personalization);
    const instruction = await screen.findByRole("button", { name: "个性" });
    expect(instruction).toHaveClass("bg-transparent", "before:bg-[hsl(var(--brand-red))]");
    expect(instruction).not.toHaveClass("bg-accent");
    expect(screen.queryByText(/SOUL\.md|AGENTS\.md|USER\.md|MEMORY\.md/)).not.toBeInTheDocument();
    expect(screen.getByText("手动和 AI 修改都会自动记录版本，可随时恢复。")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "技能" }));
    expect(screen.queryByText("添加专属 Skill")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "技能" })).toBeInTheDocument();
  });

  it("uses the human Mona avatar when the API avatar is empty", async () => {
    render(<AgentManagementView agentId="mona" onBack={() => {}} onStartDirect={() => {}} />);

    await waitFor(() => expect(screen.getByText("Mona")).toBeInTheDocument());
    expect(document.querySelectorAll('img[src="/brand/mona_avatar_human.png"]')).toHaveLength(2);
    expect(document.querySelector('img[src="/brand/mona_avatar_white.png"]')).not.toBeInTheDocument();
  });

  it("binds a configured model preset from the overview", async () => {
    const user = userEvent.setup();
    clientMocks.updateAgentConfig.mockClear();
    render(<AgentManagementView agentId="agent.demo" onBack={() => {}} onStartDirect={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "绑定模型" }));
    await user.click(await screen.findByText("评审模型 · review-model"));
    await user.click(screen.getByRole("button", { name: "保存基本设置" }));

    await waitFor(() => expect(clientMocks.updateAgentConfig).toHaveBeenCalledWith(
      "agent.demo",
      expect.objectContaining({ model_preset: "review" }),
      1,
    ));
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

  it("shows the tool permission overview and filters tools by search", async () => {
    const user = userEvent.setup();
    render(<AgentManagementView agentId="agent.demo" onBack={() => {}} onStartDirect={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: "工具" }));

    expect(screen.getByRole("heading", { name: "工具权限" })).toBeInTheDocument();
    expect(screen.getByText("已启用 6 / 6")).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "搜索工具" });
    expect(search).toBeInTheDocument();

    await user.type(search, "图片");
    expect(screen.getByText("图片生成")).toBeInTheDocument();
    expect(screen.getByText("保存图片到笔记")).toBeInTheDocument();
    expect(screen.queryByText("网页搜索")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "网页搜索工具" })).not.toBeInTheDocument();
  });

  it("keeps Agent knowledge out of the tool permission switches", async () => {
    const user = userEvent.setup();
    render(<AgentManagementView agentId="agent.demo" onBack={() => {}} onStartDirect={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: "工具" }));

    expect(screen.getByRole("heading", { name: "笔记" })).toBeInTheDocument();
    expect(screen.getByText("查询笔记")).toBeInTheDocument();
    expect(screen.getByText("创建笔记")).toBeInTheDocument();
    expect(screen.getByText("保存图片到笔记")).toBeInTheDocument();
    expect(screen.getByText("搜索并读取允许访问的笔记。")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "查询笔记工具" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "知识库查询" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "知识" })).toBeInTheDocument();
    expect(screen.queryByText("搜索笔记")).not.toBeInTheDocument();
    expect(screen.queryByText("读取笔记")).not.toBeInTheDocument();
    expect(screen.queryByText("搜索资料")).not.toBeInTheDocument();
    expect(screen.queryByText("读取资料")).not.toBeInTheDocument();
    expect(screen.queryByText("查询资料")).not.toBeInTheDocument();
    expect(screen.queryByText("查询 Wiki")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "查询资料工具" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "查询 Wiki工具" })).not.toBeInTheDocument();
    expect(screen.queryByText("Search notes")).not.toBeInTheDocument();
  });

  it("updates note permissions without changing Agent knowledge", async () => {
    const user = userEvent.setup();
    clientMocks.updateAgentConfig.mockClear();
    render(<AgentManagementView agentId="agent.partial" onBack={() => {}} onStartDirect={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: "工具" }));

    expect(screen.getByRole("switch", { name: "查询笔记工具" })).toHaveAttribute("aria-checked", "true");

    const notesSwitch = screen.getByRole("switch", { name: "查询笔记工具" });
    await user.click(notesSwitch);
    await waitFor(() => expect(clientMocks.updateAgentConfig).toHaveBeenCalledWith(
      "agent.partial",
      { granted_tools: ["web_search", "materials_search"] },
      1,
    ));
  });

  it("shows knowledge as an Agent configuration page", async () => {
    const user = userEvent.setup();
    render(<AgentManagementView agentId="agent.demo" onBack={() => {}} onStartDirect={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: "知识" }));

    expect(screen.getByRole("heading", { name: "知识" })).toBeInTheDocument();
    expect(screen.getByText("添加资料，让这个 Agent 在完成任务时参考其中的信息。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加资料" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "知识图谱" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "调整资料列表宽度" })).toBeInTheDocument();
    expect(screen.queryByText(/知识库|MD5|编译/)).not.toBeInTheDocument();
  });

  it("groups skills by origin and only allows editing self-learned skills", async () => {
    const user = userEvent.setup();
    render(<AgentManagementView agentId="agent.demo" onBack={() => {}} onStartDirect={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: "技能" }));

    expect(screen.getByRole("heading", { name: "自我学习" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "外部安装" })).toBeInTheDocument();
    const learnedGroup = screen.getByRole("heading", { name: "自我学习" }).closest("section");
    expect(learnedGroup).not.toBeNull();
    const learnedList = learnedGroup?.querySelector("div.divide-y");
    expect(learnedList).not.toBeNull();
    expect(learnedList).not.toHaveClass("sm:grid-cols-2");
    const learnedRow = learnedGroup?.querySelector("article");
    expect(learnedRow).not.toBeNull();
    expect(learnedRow).toHaveClass("sm:flex-row");
    expect(within(learnedRow as HTMLElement).getByText("访问 7")).toBeInTheDocument();
    expect(within(learnedRow as HTMLElement).getByText(/最近/)).toBeInTheDocument();
    expect(within(learnedRow as HTMLElement).getByText(/创建/)).toBeInTheDocument();

    const editButton = screen.getByRole("button", { name: "编辑 learned-research" });
    expect(editButton).toHaveAccessibleName("编辑 learned-research");
    expect(editButton).not.toHaveAttribute("title");
    expect(editButton).toHaveTextContent(/^$/);
    expect(learnedRow).not.toHaveTextContent("编辑");
    await user.hover(editButton);
    const editTooltip = await screen.findByRole("tooltip", { name: "编辑" });
    expect(editTooltip).not.toHaveTextContent("learned-research");
    await user.unhover(editButton);

    const pinButton = screen.getByRole("button", { name: "置顶 learned-research" });
    expect(pinButton).toHaveAccessibleName("置顶 learned-research");
    expect(pinButton).not.toHaveAttribute("title");
    await user.hover(pinButton);
    const pinTooltip = await screen.findByRole("tooltip", { name: "置顶" });
    expect(pinTooltip).not.toHaveTextContent("learned-research");
    await user.unhover(pinButton);

    const archiveButton = screen.getByRole("button", { name: "归档 learned-research" });
    expect(archiveButton).toHaveAccessibleName("归档 learned-research");
    expect(archiveButton).not.toHaveAttribute("title");
    await user.hover(archiveButton);
    const archiveTooltip = await screen.findByRole("tooltip", { name: "归档" });
    expect(archiveTooltip).not.toHaveTextContent("learned-research");
    await user.unhover(archiveButton);

    const restoreButton = screen.getByRole("button", { name: "恢复 archived-research" });
    expect(restoreButton).toHaveAccessibleName("恢复 archived-research");
    expect(restoreButton).not.toHaveAttribute("title");
    await user.hover(restoreButton);
    const restoreTooltip = await screen.findByRole("tooltip", { name: "恢复" });
    expect(restoreTooltip).not.toHaveTextContent("archived-research");
    await user.unhover(restoreButton);

    clientMocks.actOnAgentSkill.mockClear();
    await user.click(pinButton);
    await waitFor(() => expect(clientMocks.actOnAgentSkill).toHaveBeenCalledWith(
      "agent.demo",
      "learned-research",
      "pin",
    ));

    await user.click(editButton);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/编辑技能/)).toBeInTheDocument();
  });

  it("filters both skill groups by name without rendering skill descriptions", async () => {
    const user = userEvent.setup();
    render(<AgentManagementView agentId="agent.demo" onBack={() => {}} onStartDirect={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: "技能" }));

    const search = screen.getByRole("searchbox", { name: /搜索.*技能|Search skills/i });
    expect(search).toBeInTheDocument();
    expect(screen.getByText("learned-research")).toBeInTheDocument();
    expect(screen.getByText("web-search")).toBeInTheDocument();
    expect(screen.queryByText("从历史研究中整理出的分析方法。")).not.toBeInTheDocument();
    expect(screen.queryByText("搜索公开网页和信息。")).not.toBeInTheDocument();
    expect(screen.queryByText("未提供说明")).not.toBeInTheDocument();

    await user.type(search, "learned");
    expect(screen.getByText("learned-research")).toBeInTheDocument();
    expect(screen.queryByText("web-search")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "web");
    expect(screen.getByText("web-search")).toBeInTheDocument();
    expect(screen.queryByText("learned-research")).not.toBeInTheDocument();
  });

  it("configures scripts for a package skill and explains optional runtimes", async () => {
    const user = userEvent.setup();
    render(<AgentManagementView agentId="agent.demo" onBack={() => {}} onStartDirect={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: "技能" }));

    await user.click(screen.getByRole("button", { name: "完成配置" }));
    const dialog = await screen.findByRole("dialog", { name: /配置技能：analysis-experiment/ });
    expect(within(dialog).getByText("可选 R 后端")).toBeInTheDocument();
    expect(within(dialog).getByText("当前版本不支持")).toBeInTheDocument();

    clientMocks.startAgentSkillSetup.mockClear();
    await user.click(within(dialog).getByRole("button", { name: "允许并准备" }));
    await waitFor(() => expect(clientMocks.startAgentSkillSetup).toHaveBeenCalledWith(
      "agent.demo",
      "analysis-experiment",
    ));
  });
});
