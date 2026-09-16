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
    { name: "web_search", description: "Search the web", available: true, readOnly: true, systemManaged: true },
    { name: "generate_image", description: "Generate an image", available: false, readOnly: false },
    { name: "notes_search", description: "Search notes", available: true, readOnly: true },
    { name: "notes_read", description: "Read notes", available: true, readOnly: true },
    { name: "notes_create", description: "Create notes", available: true, readOnly: false },
    { name: "notes_save_image", description: "Save note image", available: true, readOnly: false },
    { name: "knowledge_search", description: "Search Agent Knowledge", available: true, readOnly: true },
    { name: "knowledge_read", description: "Read Agent Knowledge", available: true, readOnly: true },
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
  config: { ...detail.config, grantedTools: ["web_search", "notes_search", "notes_read", "materials_search", "removed_tool"] },
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
  fetchAutomationStatus: vi.fn(async () => ({
    browserAutomationEnabled: true,
    computerUse: {
      enabled: false,
      state: "disabled",
      supported: true,
      version: "0.23.2",
      downloadBytes: 27_635_699,
      installed: true,
      degraded: false,
      error: null,
      job: null,
    },
  })),
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
        toolCatalog: [
          ...detail.toolCatalog,
          { name: "browser_observe", description: "Observe browser", available: true, readOnly: true },
          { name: "browser_act", description: "Act in browser", available: true, readOnly: false },
          { name: "computer_observe", description: "Observe desktop", available: true, readOnly: true, requiresExplicitPermission: true },
          { name: "computer_act", description: "Act on desktop", available: true, readOnly: false, requiresExplicitPermission: true },
          { name: "canvas", description: "Canvas", available: false, readOnly: false, systemManaged: true },
          { name: "long_task", description: "Long goal", available: false, readOnly: false, systemManaged: true },
          { name: "read_file", description: "Read file", available: true, readOnly: true, systemManaged: true },
          { name: "memory_read", description: "Read memory", available: true, readOnly: true, systemManaged: true },
          { name: "skill_read", description: "Read skill", available: true, readOnly: true, systemManaged: true },
          { name: "db_query", description: "Database query", available: true, readOnly: true },
          { name: "office", description: "Office", available: true, readOnly: false },
          { name: "email_search", description: "Email search", available: true, readOnly: true },
          { name: "delegate_agent", description: "Delegate an agent", available: true, readOnly: false, systemManaged: true },
          { name: "propose_workflow", description: "Propose a structured workflow", available: true, readOnly: false, systemManaged: true },
          { name: "run_collaboration", description: "Run a one-time collaboration", available: true, readOnly: false, systemManaged: true },
          { name: "spawn", description: "Spawn a subtask", available: true, readOnly: false, systemManaged: true },
          { name: "terminal_task", description: "Terminal task", available: true, readOnly: false },
          { name: "crypto", description: "Crypto utility", available: true, readOnly: true, requiresExplicitPermission: true },
          { name: "config_set_provider", description: "Provider settings", available: true, readOnly: false, requiresExplicitPermission: true },
          { name: "http_request", description: "HTTP request", available: true, readOnly: false, systemManaged: true },
          { name: "heartbeat_update", description: "Update heartbeat", available: true, readOnly: false },
          { name: "schedule", description: "Manage schedules", available: true, readOnly: false },
          { name: "todo", description: "Manage todos", available: true, readOnly: false },
          { name: "my", description: "Inspect runtime state", available: true, readOnly: true, systemManaged: true },
        ],
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

    expect(screen.getByText("图片生成")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "图片生成工具" })).toBeInTheDocument();
    expect(screen.queryByText("Search the web")).not.toBeInTheDocument();
    expect(screen.queryByText("继承推荐工具")).not.toBeInTheDocument();
  });

  it("uses the Agent tool tab as the only automation permission entry", async () => {
    const user = userEvent.setup();
    render(<AgentManagementView agentId="mona" onBack={() => {}} onStartDirect={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: "工具" }));

    expect(screen.getByRole("switch", { name: "浏览器自动操作工具" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "电脑操作自动化工具" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getAllByRole("heading", { level: 3 }).slice(0, 2).map((heading) => heading.textContent)).toEqual(["自动化", "媒体"]);
    expect(screen.getByText("默认关闭；首次开启会自动下载驱动。")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "browser observe工具" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "computer act工具" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "canvas工具" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "long task工具" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "my工具" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "记忆" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "技能" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "查询笔记工具" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("heading", { name: "研究" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "校验乐谱工具" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "数据库" })).toBeInTheDocument();
    const planningTools = screen.getByRole("heading", { name: "计划" }).closest("section");
    expect(planningTools).not.toBeNull();
    expect(within(planningTools as HTMLElement).getByRole("switch", { name: "日程管理工具" })).toHaveAttribute("aria-checked", "true");
    expect(within(planningTools as HTMLElement).getByRole("switch", { name: "待办事项工具" })).toHaveAttribute("aria-checked", "true");
    expect(within(planningTools as HTMLElement).getByRole("switch", { name: "周期任务工具" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("heading", { name: "网页" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "协作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "设计协作流程工具" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "立即运行协作工具" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "文档" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "通信" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "终端" })).toBeInTheDocument();
    const otherTools = screen.getByRole("heading", { name: "其他" }).closest("section");
    expect(otherTools).not.toBeNull();
    expect(within(otherTools as HTMLElement).getByRole("switch", { name: "编码与加密工具" })).toBeInTheDocument();
    expect(within(otherTools as HTMLElement).getByRole("switch", { name: "配置模型供应商工具" })).toBeInTheDocument();
    expect(within(otherTools as HTMLElement).getByRole("switch", { name: "编码与加密工具" })).toHaveAttribute("aria-checked", "false");
    expect(within(otherTools as HTMLElement).getByRole("switch", { name: "配置模型供应商工具" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("heading", { name: "实用工具" })).not.toBeInTheDocument();
  });

  it("shows the tool permission overview and filters tools by search", async () => {
    const user = userEvent.setup();
    render(<AgentManagementView agentId="agent.demo" onBack={() => {}} onStartDirect={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: "工具" }));

    expect(screen.getByRole("heading", { name: "工具权限" })).toBeInTheDocument();
    expect(screen.getByText("已启用 4 / 4")).toBeInTheDocument();
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
      { granted_tools: ["materials_search"] },
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

  it("prepares a package skill environment and explains optional runtimes", async () => {
    const user = userEvent.setup();
    render(<AgentManagementView agentId="agent.demo" onBack={() => {}} onStartDirect={() => {}} />);
    await user.click(await screen.findByRole("tab", { name: "技能" }));

    await user.click(screen.getByRole("button", { name: "准备环境" }));
    const dialog = await screen.findByRole("dialog", { name: /配置技能：analysis-experiment/ });
    expect(within(dialog).getByText("可选 R 后端")).toBeInTheDocument();
    expect(within(dialog).getByText("当前版本不支持")).toBeInTheDocument();
    expect(within(dialog).queryByText("运行权限")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/待允许|允许并准备|撤销脚本权限|前往工具权限/)).not.toBeInTheDocument();

    clientMocks.startAgentSkillSetup.mockClear();
    await user.click(within(dialog).getByRole("button", { name: "准备环境" }));
    await waitFor(() => expect(clientMocks.startAgentSkillSetup).toHaveBeenCalledWith(
      "agent.demo",
      "analysis-experiment",
    ));
  });

  it("treats a ready skill as complete without script approval", async () => {
    const user = userEvent.setup();
    const skill = skills.find((item) => item.name === "analysis-experiment");
    if (!skill) throw new Error("analysis-experiment fixture is missing");
    const previousRuntimeReady = skill.runtimeReady;
    skill.runtimeReady = true;
    try {
      render(<AgentManagementView agentId="agent.demo" onBack={() => {}} onStartDirect={() => {}} />);
      await user.click(await screen.findByRole("tab", { name: "技能" }));
      await user.click(await screen.findByRole("button", { name: "查看环境" }));

      const dialog = await screen.findByRole("dialog", { name: /配置技能：analysis-experiment/ });
      expect(within(dialog).getByText("已就绪")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "完成" })).toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "准备环境" })).not.toBeInTheDocument();
      expect(within(dialog).queryByText(/运行权限|待允许|允许并准备|撤销脚本权限|前往工具权限/)).not.toBeInTheDocument();
    } finally {
      skill.runtimeReady = previousRuntimeReady;
    }
  });
});
