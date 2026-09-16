import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  FileClock,
  ImagePlus,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  Play,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";

import {
  AgentAvatar,
  MONA_AGENT_ID,
  MONA_AVATAR_IMAGE,
} from "@/components/room/AgentAvatar";
import {
  AgentKnowledgePanel,
  type AgentKnowledgeSelection,
} from "@/components/agents/AgentKnowledgePanel";
import { GraphViewDialog } from "@/components/notes/GraphViewDialog";
import { MaterialsPreview } from "@/components/notes/materials/MaterialsPreview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  fetchAutomationStatus,
  getAgentDetail,
  fetchSettings,
  listAgentInstructionHistory,
  listAgentInstructions,
  listAgentSkills,
} from "@/lib/api";
import { getAgentKnowledgeGraph } from "@/lib/materials-api";
import { useMaterialsOpenStore } from "@/lib/materials-open-store";
import type {
  AgentDetailPayload,
  AgentInstruction,
  AgentInstructionHistoryItem,
  AgentSkill,
  AgentSkillSetupJob,
  AutomationStatus,
} from "@/lib/types";
import { useClientContextOrNull } from "@/providers/ClientProvider";

type Tab = "overview" | "identity" | "knowledge" | "permissions" | "skills";
type SkillAction = "enable" | "disable" | "archive" | "restore" | "pin" | "unpin";
const MAX_AVATAR_FILE_BYTES = 2 * 1024 * 1024;

const INSTRUCTION_LABELS: Record<AgentInstruction["key"], string> = {
  soul: "个性",
  agents: "规则",
  user: "用户偏好",
  memory: "长期记忆",
};

const MANAGEMENT_TAB_CLASS =
  "relative after:pointer-events-none after:absolute after:inset-x-2 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-transparent after:content-[''] data-[state=active]:!bg-transparent data-[state=active]:text-foreground data-[state=active]:!shadow-none data-[state=active]:after:bg-[hsl(var(--brand-red))]";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ToolGroupId = "notes" | "knowledge" | "research" | "database" | "media" | "planning" | "automation" | "web" | "connections" | "files" | "office" | "communication" | "terminal" | "memory" | "skills" | "collaboration" | "system" | "other";

type CompositeTool = {
  id: string;
  groupId: ToolGroupId;
  names: string[];
  label: string;
  description: string;
};

type PermissionRow = {
  key: string;
  names: string[];
  label: string;
  description: string;
  available: boolean;
};

const TOOL_GROUPS: Array<{ id: ToolGroupId; label: string; description: string }> = [
  { id: "automation", label: "自动化", description: "操作浏览器页面或电脑上的其他应用。" },
  { id: "media", label: "媒体", description: "生成图片或视频内容。" },
  { id: "notes", label: "笔记", description: "访问和整理笔记仓库中的内容。" },
  { id: "knowledge", label: "知识", description: "检索和读取这个 Agent 已学习的内容。" },
  { id: "research", label: "研究", description: "检索学术资料、分析数据并生成图表。" },
  { id: "database", label: "数据库", description: "检查数据库结构、查询数据并生成 SQL 草稿。" },
  { id: "planning", label: "计划", description: "管理个人日程、提醒、待办和周期任务。" },
  { id: "web", label: "网页", description: "搜索互联网并读取网页内容。" },
  { id: "connections", label: "连接", description: "使用已经连接的 MCP 工具。" },
  { id: "files", label: "文件", description: "读写工作区文件并执行命令。" },
  { id: "office", label: "文档", description: "读取文档或在 Office 编辑器中修改文件。" },
  { id: "communication", label: "通信", description: "读取、管理邮件或向指定渠道发送消息。" },
  { id: "terminal", label: "终端", description: "管理本地执行会话或操作当前终端连接。" },
  { id: "memory", label: "记忆", description: "读取、搜索和维护智能体记忆。" },
  { id: "skills", label: "技能", description: "读取技能资料并运行技能脚本。" },
  { id: "collaboration", label: "协作", description: "委派任务或创建子任务。" },
  { id: "system", label: "系统", description: "管理系统能力。" },
  { id: "other", label: "其他", description: "完成智能体工作所需的辅助能力。" },
];

const HIDDEN_KNOWLEDGE_TOOL_NAMES = new Set([
  "knowledge_search",
  "knowledge_read",
  "materials_search",
  "materials_read",
  "wiki_search",
  "wiki_read",
]);

function normalizeCompositeToolPermissions(
  tools: string[],
  composites: CompositeTool[],
): string[] {
  const next = new Set(tools);
  composites.forEach(({ names }) => {
    if (names.every((name) => next.has(name))) return;
    names.forEach((name) => next.delete(name));
  });
  return [...next];
}

const TOOL_LABELS: Record<string, string> = {
  academic_search: "学术搜索",
  apply_patch: "批量修改文件",
  artifact_read: "读取协作产物",
  browser_observe: "查看浏览器",
  canvas: "流程图画布",
  chart: "生成图表",
  complete_goal: "结束长期目标",
  computer_act: "操作电脑",
  computer_observe: "查看电脑",
  config_set_provider: "配置模型供应商",
  crypto: "编码与加密",
  dataframe_query: "分析表格数据",
  db_inspect: "检查数据库",
  db_query: "查询数据库",
  db_sql_draft: "生成 SQL 草稿",
  document: "读取文档",
  email_action: "管理邮件",
  email_read: "读取邮件",
  email_search: "搜索邮件",
  find_files: "查找文件",
  grep: "搜索文件内容",
  guitar_tab: "校验吉他六线谱",
  heartbeat_update: "周期任务",
  hoard_capture: "收藏内容",
  hoard_search: "搜索收藏",
  http_request: "HTTP 请求",
  list_dir: "浏览目录",
  list_exec_sessions: "查看执行会话",
  long_task: "登记长期目标",
  message: "发送消息",
  my: "运行状态",
  music_score: "校验乐谱",
  office: "Office 实时编辑",
  propose_workflow: "设计协作流程",
  research_record: "研究记录",
  run_collaboration: "立即运行协作",
  schedule: "日程管理",
  scientific_tool: "科学工具",
  skill_create: "创建技能",
  stock_context_read: "读取股票研究上下文",
  stock_evidence_read: "读取股票研究证据",
  stock_opportunity_submit: "提交股票机会研究",
  stock_quote: "查询股票行情",
  stock_report_read: "读取股票报告",
  stock_research_status: "查看股票研究进度",
  stock_screen_compare: "比较选股候选",
  stock_screen_read: "读取选股结果",
  stock_screen_run: "运行选股分析",
  stock_screen_strategy_save: "保存选股策略",
  stock_screen_validation_read: "读取策略验证",
  stock_source_open: "查看股票数据来源",
  submit_bear_case: "提交看空观点",
  submit_bull_case: "提交看多观点",
  submit_fundamental_view: "提交基本面观点",
  submit_news_view: "提交资讯观点",
  submit_stock_diagnosis_semantic: "提交股票语义分析",
  submit_stock_report_staged: "分步提交股票报告",
  submit_technical_view: "提交技术面观点",
  todo: "待办事项",
  terminal_exec: "执行终端命令",
  terminal_output: "读取终端输出",
  terminal_task: "维护任务",
  terminal_upload: "上传远程文件",
  url2note: "网页转笔记",
  update_plan: "更新任务计划",
  video_extract_frame: "提取视频帧",
  write_stdin: "与运行中进程交互",
  notes_search: "搜索笔记",
  notes_read: "读取笔记",
  notes_create: "创建笔记",
  notes_save_image: "保存图片到笔记",
  knowledge_search: "搜索知识",
  knowledge_read: "读取知识",
  materials_search: "搜索资料",
  materials_read: "读取资料",
  wiki_search: "搜索 Wiki",
  wiki_read: "读取 Wiki",
  generate_image: "图片生成",
  generate_video: "视频生成",
  web_search: "网页搜索",
  web_fetch: "读取网页",
  browser_open: "打开浏览器页面",
  browser_navigate: "浏览器跳转",
  browser_read: "读取浏览器页面",
  browser_snapshot: "浏览器结构快照",
  browser_screenshot: "浏览器截图",
  browser_click: "浏览器点击",
  browser_type: "浏览器输入",
  browser_act: "浏览器交互",
  browser_close: "关闭浏览器页面",
  browser_go_back: "返回上一页",
  browser_go_forward: "前进到下一页",
  browser_list_tabs: "查看浏览器页面",
  read_file: "读取文件",
  write_file: "写入文件",
  edit_file: "编辑文件",
  deliver_file: "交付文件",
  memory_read: "读取记忆",
  memory_edit: "编辑记忆",
  memory_search: "搜索记忆",
  skill_read: "读取技能",
  skill_reference_read: "读取技能参考",
  skill_asset_copy: "复制技能素材",
  skill_script_run: "运行技能脚本",
  exec: "执行命令",
  delegate_agent: "委派智能体",
  spawn: "创建子任务",
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
  academic_search: "检索论文、临床试验和学术引用信息。",
  apply_patch: "一次完成一个或多个文件的精确修改。",
  artifact_read: "读取当前协作流程中其他步骤提交的结构化成果。",
  browser_observe: "查看 Mona 内置浏览器的页面、标签、结构和截图。",
  canvas: "打开、查看、编辑并导出当前流程图画布。",
  chart: "根据结构化数据生成柱状图、折线图、饼图或散点图。",
  complete_goal: "结束已经完成、取消或被替换的长期目标。",
  computer_act: "在电脑上的其他应用中执行点击、输入、滚动等操作。",
  computer_observe: "查看电脑上的窗口、界面结构或屏幕画面。",
  config_set_provider: "保存模型供应商密钥并切换默认供应商；仅在用户明确要求时使用。",
  crypto: "执行哈希、编码、解码、UUID 和密码生成等本地计算。",
  dataframe_query: "读取 CSV、JSON 或 XLSX，并使用只读 SQL 分析数据。",
  db_inspect: "检查当前数据库连接、表结构、索引、执行计划和健康状态。",
  db_query: "对当前连接的数据库执行只读查询。",
  db_sql_draft: "在数据库编辑器中生成可复制或插入的 SQL 草稿。",
  document: "将 PDF、Office、文本或代码文件解析为可阅读内容。",
  email_action: "对邮件执行已读、星标、移动或删除等操作。",
  email_read: "读取指定邮件的完整内容和附件信息。",
  email_search: "按关键词、发件人、日期或状态搜索邮件。",
  find_files: "按名称、路径或文件类型查找工作区文件。",
  grep: "使用文本或正则表达式搜索工作区文件内容。",
  guitar_tab: "检查 AlphaTex 吉他六线谱的结构、节拍、品位和小节数。",
  heartbeat_update: "更新 Mona 定期检查和执行的周期任务。",
  hoard_capture: "将有长期价值的网页或文本收藏到 Mona。",
  hoard_search: "搜索此前收藏的网页、邮件、笔记和对话内容。",
  http_request: "发送结构化 HTTP 请求，用于 API 调试或 Webhook。",
  list_dir: "查看目录中的文件和子目录。",
  list_exec_sessions: "查看仍在运行的本地命令会话。",
  long_task: "登记用户明确提出的长期目标，并在后续会话中持续跟进。",
  message: "向用户或已连接渠道主动发送消息和附件。",
  my: "检查 Mona 当前会话的运行状态和可调整配置。",
  music_score: "检查 ABC 乐谱的格式、声部和小节时值。",
  office: "在 Mona 的 Office 编辑器中打开并修改 Word、Excel 或 PowerPoint。",
  propose_workflow: "为协作房间设计可复用的任务顺序和人工确认节点，提交后等待用户启用。",
  research_record: "记录并校验研究来源、证据、实验、交付物和任务清单。",
  run_collaboration: "立即运行一次临时智能体协作，完成后汇总各智能体结果。",
  schedule: "创建、查看、修改或删除个人提醒和自动执行任务。",
  scientific_tool: "发现、查看或运行受支持的科学数据与计算工具。",
  skill_create: "为当前智能体创建并启用私有技能。",
  stock_context_read: "构建并读取可追溯的 A 股研究上下文和数据质量信息。",
  stock_evidence_read: "读取当前研究流程准备的股票证据包及其来源。",
  stock_opportunity_submit: "提交候选股票的结构化机会、风险和不同周期判断。",
  stock_quote: "查询一只 A 股或 ETF 的实时价格、涨跌幅和成交量。",
  stock_report_read: "按报告编号读取已生成的股票研究报告或复盘摘要。",
  stock_research_status: "查看多智能体股票研究的当前步骤、完成情况和失败信息。",
  stock_screen_compare: "使用结构化指标和风险比较多个候选股票。",
  stock_screen_read: "读取已经保存的选股分析结果。",
  stock_screen_run: "运行确定性的股票筛选流程并保存结果。",
  stock_screen_strategy_save: "保存用户确认的结构化选股策略。",
  stock_screen_validation_read: "读取选股策略的真实历史验证指标或不可用原因。",
  stock_source_open: "查看股票研究数据来源、时间和内容校验信息。",
  submit_bear_case: "提交包含短期、中期和长期判断及证据的看空观点。",
  submit_bull_case: "提交包含短期、中期和长期判断及证据的看多观点。",
  submit_fundamental_view: "提交公司质量、财务质量、估值和长期价值判断。",
  submit_news_view: "提交行业、政策、周期和事件日历分析。",
  submit_stock_diagnosis_semantic: "提交公司、行业、政策、周期、治理和风险语义分析。",
  submit_stock_report_staged: "分阶段保存股票深度研究内容，并在完成后执行完整校验。",
  submit_technical_view: "提交价格成交、趋势、市场环境、资金和交易性分析。",
  todo: "添加、查看、完成或整理统一待办事项。",
  terminal_exec: "在当前终端维护任务中执行一个命令步骤。",
  terminal_output: "读取当前终端或长时间运行会话的输出。",
  terminal_task: "创建并管理包含检查、修改和验证步骤的终端维护任务。",
  terminal_upload: "在终端维护任务中向远程主机上传文件。",
  url2note: "将用户指定的公开文章或视频整理为 Markdown 笔记。",
  update_plan: "更新当前任务的执行步骤和状态。",
  video_extract_frame: "从公开视频的指定时间提取关键画面并保存到笔记。",
  write_stdin: "向正在运行的本地命令发送输入、轮询输出或终止会话。",
  notes_search: "在允许访问的笔记中搜索标题和正文。",
  notes_read: "读取指定笔记的完整 Markdown 内容。",
  notes_create: "在笔记仓库中创建新的 Markdown 笔记。",
  notes_save_image: "将图片保存到笔记仓库；启用时会同时启用“创建笔记”。",
  knowledge_search: "搜索这个 Agent 从资料中学习和整理的知识。",
  knowledge_read: "读取知识搜索命中的原始内容、上下文和引用信息。",
  materials_search: "在资料库中搜索上传的文档和知识内容。",
  materials_read: "读取资料库中指定片段及其上下文。",
  wiki_search: "搜索这个 Agent 已整理的知识页面。",
  wiki_read: "读取这个 Agent 的知识页面。",
  generate_image: "根据文字描述生成或编辑图片。",
  generate_video: "根据提示生成或编辑视频。",
  web_search: "搜索互联网中的网页和公开信息。",
  web_fetch: "读取指定网页的正文内容。",
  browser_open: "打开网页并创建浏览器页面。",
  browser_navigate: "在当前浏览器页面中跳转到新地址。",
  browser_read: "读取当前浏览器页面的可见内容。",
  browser_snapshot: "获取当前页面的结构化快照。",
  browser_screenshot: "截取当前浏览器页面的图片。",
  browser_click: "点击浏览器页面中的元素。",
  browser_type: "向浏览器页面输入文字。",
  browser_act: "在浏览器页面中执行点击、输入、按键、选择、拖拽、滚动、上传和等待等操作。",
  browser_close: "关闭指定的浏览器页面。",
  browser_go_back: "返回浏览器历史记录中的上一页。",
  browser_go_forward: "前进到浏览器历史记录中的下一页。",
  browser_list_tabs: "查看当前打开的浏览器页面。",
  read_file: "读取工作区中的文件内容。",
  write_file: "创建或覆盖工作区文件。",
  edit_file: "按指定修改编辑工作区文件。",
  deliver_file: "将生成的文件交付给用户。",
  memory_read: "读取智能体的记忆文件。",
  memory_edit: "编辑智能体的记忆文件。",
  memory_search: "搜索智能体的记忆内容。",
  skill_read: "读取已安装技能的说明。",
  skill_reference_read: "读取技能的参考资料。",
  skill_asset_copy: "复制技能所需的素材。",
  skill_script_run: "运行技能提供的脚本。",
  exec: "执行受控命令或脚本。",
  delegate_agent: "委派任务给其他智能体。",
  spawn: "创建独立的子任务。",
};

function toolGroupId(name: string): ToolGroupId {
  if (name.startsWith("notes_")) return "notes";
  if (name.startsWith("materials_") || name.startsWith("wiki_") || name === "knowledge_search" || name === "kb_search") return "knowledge";
  if (name.startsWith("generate_")) return "media";
  if (
    ["academic_search", "chart", "dataframe_query", "research_record", "scientific_tool"].includes(name)
    || name.startsWith("stock_")
    || name.startsWith("submit_")
  ) return "research";
  if (name.startsWith("db_")) return "database";
  if (["crypto", "config_set_provider"].includes(name)) return "other";
  if (["schedule", "todo", "heartbeat_update"].includes(name)) return "planning";
  if (["document", "office"].includes(name)) return "office";
  if (name.startsWith("email_") || name === "message") return "communication";
  if (name.startsWith("terminal_") || ["list_exec_sessions", "write_stdin"].includes(name)) return "terminal";
  if (["url2note", "video_extract_frame"].includes(name)) return "notes";
  if (name.startsWith("hoard_")) return "memory";
  if (["music_score", "guitar_tab"].includes(name)) return "media";
  if (name.startsWith("browser_") || name.startsWith("computer_")) return "automation";
  if (name.startsWith("mcp_")) return "connections";
  if (name.startsWith("web_") || name === "http_request") return "web";
  if (name.endsWith("_file") || ["read_file", "write_file", "edit_file", "deliver_file", "exec", "apply_patch", "find_files", "grep", "list_dir"].includes(name)) return "files";
  if (name.startsWith("memory_")) return "memory";
  if (name.startsWith("skill_")) return "skills";
  if (["delegate_agent", "spawn", "run_collaboration", "propose_workflow", "artifact_read"].includes(name)) return "collaboration";
  return "other";
}

function computerStatusText(
  status: AutomationStatus["computerUse"] | null,
  enabled: boolean,
): string {
  if (!status) return enabled ? "正在读取运行状态…" : "默认关闭；首次开启会自动下载驱动。";
  if (status.state === "disabled") return enabled ? "正在准备电脑操作能力…" : "默认关闭；首次开启会自动下载驱动。";
  if (status.state === "downloading") {
    const job = status.job;
    const progress = job && job.totalBytes > 0
      ? Math.min(100, Math.round((job.downloadedBytes / job.totalBytes) * 100))
      : 0;
    return `正在下载驱动 · ${progress}%`;
  }
  if (status.state === "pending_authorization") return "等待完成系统授权。";
  if (status.state === "available") {
    return status.degraded ? "可用，部分精细操作暂时受限。" : "可用";
  }
  if (status.state === "not_installed") return "首次开启会自动下载驱动。";
  return status.error || status.job?.error || "电脑操作运行异常，请关闭后重新开启。";
}

function ConfigFields({
  detail,
  modelPresets,
  onSave,
}: {
  detail: AgentDetailPayload;
  modelPresets: Array<{ name: string; label: string; model: string; provider: string }>;
  onSave: (update: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(detail.config.displayName ?? detail.agent.displayName);
  const [avatar, setAvatar] = useState(detail.config.avatar ?? "");
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(detail.config.enabled);
  const [modelPreset, setModelPreset] = useState(detail.config.modelPreset ?? "__inherit__");
  const [saving, setSaving] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const chooseAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
      setAvatarError("请选择 PNG、JPEG、WebP 或 GIF 图片");
      return;
    }
    if (file.size > MAX_AVATAR_FILE_BYTES) {
      setAvatarError("头像图片不能超过 2 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setAvatarError("读取头像失败");
        return;
      }
      setAvatar(reader.result);
      setAvatarError(null);
    };
    reader.onerror = () => setAvatarError("读取头像失败");
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        display_name: name || null,
        avatar: avatar || null,
        enabled,
        model_preset: modelPreset === "__inherit__" ? null : modelPreset,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid max-w-2xl gap-4">
      <label className="grid gap-1.5 text-ui">
        <span className="text-caption text-muted-foreground">显示名称</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
      </label>
      <div className="grid gap-2 text-ui">
        <span className="text-caption text-muted-foreground">头像</span>
        <div className="flex items-center gap-4 rounded-xl border border-dashed border-border/70 bg-muted/20 p-4 transition-colors hover:border-theme/50 hover:bg-muted/35">
          <AgentAvatar
            agentId={detail.agent.id}
            displayName={detail.agent.displayName}
            avatarUrl={avatar || detail.agent.avatarUrl || (detail.agent.id === MONA_AGENT_ID ? MONA_AVATAR_IMAGE : null)}
            className="h-16 w-16 shrink-0 ring-2 ring-background ring-offset-2 ring-offset-muted/20"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => avatarInputRef.current?.click()}>
                <ImagePlus className="h-4 w-4" />
                {avatar ? "更换头像" : "选择本地图片"}
              </Button>
              {avatar ? (
                <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => { setAvatar(""); setAvatarError(null); }}>
                  <Trash2 className="h-3.5 w-3.5" />移除
                </Button>
              ) : null}
            </div>
            <p className="mt-2 text-caption text-muted-foreground">从本机选择 PNG、JPEG、WebP 或 GIF，最大 2 MB。</p>
          </div>
        </div>
        <input ref={avatarInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={chooseAvatar} className="sr-only" />
        {avatarError ? <p className="text-caption text-destructive">{avatarError}</p> : null}
      </div>
      <label className="flex items-center gap-2 text-ui">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
         启用此 Agent（停用后保留会话、记忆和技能）
      </label>
      <label className="grid gap-1.5 text-ui">
        <span className="text-caption text-muted-foreground">绑定模型</span>
        <Select
          aria-label="绑定模型"
          value={modelPreset}
          onValueChange={setModelPreset}
          options={[
            { value: "__inherit__", label: "跟随全局默认模型" },
            ...modelPresets.map((preset) => ({
              value: preset.name,
              label: `${preset.label} · ${preset.model}`,
            })),
          ]}
        />
        <span className="text-micro text-muted-foreground">群聊议题、协作任务和单独对话都会使用此模型。</span>
      </label>
      <div><Button onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存基本设置"}</Button></div>
    </div>
  );
}

function PermissionFields({
  detail,
  onSave,
}: {
  detail: AgentDetailPayload;
  onSave: (update: Record<string, unknown>) => Promise<void>;
}) {
  const catalog = detail.toolCatalog ?? [];
  const configurableCatalog = catalog.filter((tool) => !tool.systemManaged);
  const { token } = useClientContextOrNull() ?? { token: "" };
  const defaultTools = configurableCatalog
    .filter((tool) => !tool.requiresExplicitPermission)
    .map((tool) => tool.name);
  const configurableToolNames = new Set(configurableCatalog.map((tool) => tool.name));
  const initialTools = detail.config.grantedTools ?? detail.effective.allowedTools ?? defaultTools;
  const [selectedTools, setSelectedTools] = useState<string[]>(
    initialTools.filter((name) => configurableToolNames.has(name)),
  );
  const [automationStatus, setAutomationStatus] = useState<AutomationStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const browserTools = configurableCatalog.filter((tool) => tool.name.startsWith("browser_")).map((tool) => tool.name);
  const computerTools = configurableCatalog.filter((tool) => tool.name.startsWith("computer_")).map((tool) => tool.name);
  const compositeTools: CompositeTool[] = [
    {
      id: "notes_query",
      groupId: "notes",
      names: ["notes_search", "notes_read"],
      label: "查询笔记",
      description: "搜索并读取允许访问的笔记。",
    },
    ...(browserTools.length > 0 ? [{ id: "browser_automation", groupId: "automation" as const, names: browserTools, label: "浏览器自动操作", description: "读取并操作 Mona 内置浏览器中的页面，默认开启。" }] : []),
    ...(computerTools.length > 0 ? [{ id: "computer_automation", groupId: "automation" as const, names: computerTools, label: "电脑操作自动化", description: "观察并操作电脑上的其他应用；首次开启会下载驱动。" }] : []),
  ];
  const compositeToolNames = new Set(compositeTools.flatMap((tool) => tool.names));
  const visibleGroups = TOOL_GROUPS.map((group) => {
    const groupCatalogTools = configurableCatalog.filter(
      (tool) => ((tool.category as ToolGroupId | undefined) ?? toolGroupId(tool.name)) === group.id,
    );
    const rows: PermissionRow[] = [
      ...compositeTools
        .filter((composite) => composite.groupId === group.id && composite.names.some((name) => groupCatalogTools.some((tool) => tool.name === name)))
        .map((composite) => ({
          key: composite.id,
          names: composite.names,
          label: composite.label,
          description: composite.description,
          available: composite.names.every((name) => configurableCatalog.find((tool) => tool.name === name)?.available === true),
        })),
      ...groupCatalogTools
        .filter((tool) => !compositeToolNames.has(tool.name) && !HIDDEN_KNOWLEDGE_TOOL_NAMES.has(tool.name))
        .map((tool) => ({
          key: tool.name,
          names: [tool.name],
          label: TOOL_LABELS[tool.name] ?? `${tool.name.startsWith("mcp_") ? "外部工具" : "扩展工具"} · ${tool.name.replaceAll("_", " ")}`,
          description: TOOL_DESCRIPTIONS[tool.name]
            ?? (tool.description && /[\u3400-\u9fff]/u.test(tool.description)
              ? tool.description
              : tool.name.startsWith("mcp_")
                ? "调用已连接的外部服务提供的这项能力。"
                : "用于完成当前智能体任务的扩展能力。"),
          available: tool.available,
        })),
    ].filter((row) => !normalizedQuery || `${row.label} ${row.description} ${row.names.join(" ")}`.toLocaleLowerCase().includes(normalizedQuery));
    return { ...group, rows };
  }).filter((group) => group.rows.length > 0);
  const visibleRows = visibleGroups.flatMap((group) => group.rows);
  const enabledCount = visibleRows.filter((row) => row.names.every((name) => selectedTools.includes(name))).length;

  const loadAutomationStatus = useCallback(async () => {
    if (!token) return;
    try {
      setAutomationStatus(await fetchAutomationStatus(token, detail.agent.id));
    } catch {
      setAutomationStatus(null);
    }
  }, [detail.agent.id, token]);

  useEffect(() => {
    void loadAutomationStatus();
  }, [loadAutomationStatus]);

  useEffect(() => {
    if (automationStatus?.computerUse.state !== "downloading") return;
    const timer = window.setInterval(() => void loadAutomationStatus(), 800);
    return () => window.clearInterval(timer);
  }, [automationStatus?.computerUse.state, loadAutomationStatus]);
  const toggleTool = async (names: string[], checked: boolean) => {
    if (saving) return;
    const previous = selectedTools;
    let next = checked
      ? [...new Set([...previous, ...names])]
      : previous.filter((item) => !names.includes(item));
    if (checked && names.includes("notes_save_image")) {
      next = [...new Set([...next, "notes_create"])];
    } else if (!checked && names.includes("notes_create")) {
      next = next.filter((item) => item !== "notes_save_image");
    }
    next = normalizeCompositeToolPermissions(next, compositeTools);
    setSelectedTools(next);
    setSaving(true);
    try {
      await onSave({ granted_tools: next });
      await loadAutomationStatus();
    } catch {
      setSelectedTools(previous);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="grid w-full gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-title-sm">工具权限</h2>
          <p className="mt-1 text-caption leading-5 text-muted-foreground">控制这个 Agent 可以使用哪些能力。关闭后，不会影响已有会话和数据。</p>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <span className="text-caption text-muted-foreground">已启用 {enabledCount} / {visibleRows.length}</span>
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索工具"
              aria-label="搜索工具"
              className="pl-8 [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
        </div>
      </div>
      {visibleGroups.map((group) => {
        const groupEnabledCount = group.rows.filter((row) => row.names.every((name) => selectedTools.includes(name))).length;
        return (
          <section key={group.id} className="overflow-hidden rounded-lg border border-border/60 bg-background/65">
            <div className="flex items-center justify-between gap-4 border-b border-border/50 bg-muted/20 px-4 py-3">
              <div className="min-w-0">
                <h3 className="text-ui font-medium">{group.label}</h3>
                <p className="mt-0.5 text-caption text-muted-foreground">{group.description}</p>
              </div>
              <span className="shrink-0 rounded-full border border-border/60 bg-background px-2 py-0.5 text-micro text-muted-foreground">
                {groupEnabledCount} / {group.rows.length}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-px bg-border/45 sm:grid-cols-2">
              {group.rows.map((row) => {
                const checked = row.names.every((name) => selectedTools.includes(name));
                return (
                  <div key={row.key} className="flex min-h-16 min-w-0 items-center justify-between gap-4 bg-background px-4 py-3 transition-colors hover:bg-muted/25">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ui font-medium">{row.label}</p>
                      <p className="mt-1 line-clamp-2 text-caption leading-4 text-muted-foreground">{row.description}</p>
                      {row.key === "computer_automation" ? <p className="mt-1 text-caption leading-4 text-muted-foreground">{computerStatusText(automationStatus?.computerUse ?? null, checked)}</p> : null}
                      {!row.available ? <p className="text-caption leading-4 text-amber-600">当前运行配置不可用</p> : null}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      role="switch"
                      aria-label={`${row.label}工具`}
                      aria-checked={checked}
                      disabled={saving}
                      onClick={() => void toggleTool(row.names, !checked)}
                      className={`relative h-5 w-9 shrink-0 rounded-full p-0 transition-colors ${checked ? "bg-info hover:bg-info/90 active:bg-info/80" : "bg-muted-foreground/25 hover:bg-muted-foreground/35 active:bg-muted-foreground/40"} disabled:opacity-55`}
                    >
                      <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {configurableCatalog.length === 0 ? <p className="rounded-lg border border-dashed border-border/60 px-4 py-10 text-center text-caption text-muted-foreground">暂无工具</p> : null}
      {configurableCatalog.length > 0 && visibleGroups.length === 0 ? <p className="rounded-lg border border-dashed border-border/60 px-4 py-10 text-center text-caption text-muted-foreground">没有匹配的工具</p> : null}
    </div>
  );
}

function skillSourceLabel(skill: AgentSkill): string {
  if (skill.category === "self_learning") return "自我学习";
  if (skill.source === "platform") return "平台内置";
  if (skill.source === "package") return "随 Agent 安装";
  return "外部安装";
}

function skillRelativeTime(value?: string | null): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString();
}

function skillRuntimeSummary(runtime: AgentSkill["runtime"] | Record<string, unknown> | null | undefined): string {
  if (!runtime || typeof runtime !== "object") return "Mona 共享工作环境";
  const row = runtime as {
    packs?: unknown;
    python?: { profile?: unknown; requirements?: unknown };
    node?: { packages?: unknown };
  };
  const profileLabels: Record<string, string> = {
    "platform-docx": "Word 文档环境",
    "platform-pdf": "PDF 处理环境",
    "platform-presentations": "演示文稿环境",
    "platform-video": "视频制作环境",
    "platform-authoring": "Skill 制作环境",
    platform: "Mona 完整环境",
  };
  const parts: string[] = [];
  if (Array.isArray(row.packs) && row.packs.length) parts.push(`${row.packs.length} 个能力包`);
  if (typeof row.python?.profile === "string") {
    parts.push(profileLabels[row.python.profile] ?? "Mona Python 环境");
  } else if (Array.isArray(row.python?.requirements)) {
    parts.push(row.python.requirements.length ? `${row.python.requirements.length} 个 Python 依赖` : "Python 基础环境");
  }
  if (Array.isArray(row.node?.packages)) parts.push(`${row.node.packages.length} 个 Node 依赖`);
  return parts.join(" · ") || "Mona 共享工作环境";
}

function SkillGroup({
  title,
  description,
  emptyLabel,
  skills,
  onEdit,
  onAction,
  onConfigure,
}: {
  title: string;
  description: string;
  emptyLabel: string;
  skills: AgentSkill[];
  onEdit: (skill: AgentSkill) => void;
  onAction: (name: string, action: SkillAction) => void;
  onConfigure: (skill: AgentSkill) => void;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border/60 bg-background/65">
      <div className="flex items-start justify-between gap-4 border-b border-border/50 bg-muted/20 px-4 py-3">
        <div>
          <h2 className="text-ui font-medium">{title}</h2>
          <p className="mt-0.5 text-caption leading-5 text-muted-foreground">{description}</p>
        </div>
        <span className="rounded-full border border-border/60 bg-background px-2 py-0.5 text-micro text-muted-foreground">{skills.length}</span>
      </div>
      {skills.length ? (
        <div className="divide-y divide-border/50">
          {skills.map((skill) => (
            <article key={`${skill.source}:${skill.name}:${skill.archived}`} className="flex min-w-0 flex-col gap-3 bg-background px-4 py-3 transition-colors hover:bg-muted/20 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-ui font-medium">{skill.name}</p>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">{skillSourceLabel(skill)}</span>
                  {skill.pinned ? <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-micro text-amber-600">已置顶</span> : null}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground">
                  <span>访问 {skill.accessCount}</span>
                  <span>最近 {skillRelativeTime(skill.lastAccessedAt)}</span>
                  <span>创建 {skillRelativeTime(skill.createdAt)}</span>
                  <span>{skill.archived ? "已归档" : skill.enabled ? "已启用" : "已停用"}</span>
                  {skill.hasScripts ? (
                    <span
                      className={skill.runtimeReady ? "text-emerald-600" : "text-amber-600"}
                      title={skill.runtimeError ?? undefined}
                    >
                      {skill.runtimeReady ? "环境就绪" : "环境待准备"}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 sm:max-w-[22rem]">
                {skill.editable ? <SkillIconButton label={`编辑 ${skill.name}`} tooltip="编辑" onClick={() => onEdit(skill)}><Pencil className="h-3.5 w-3.5" /></SkillIconButton> : null}
                {skill.source === "private" ? <SkillIconButton label={`${skill.pinned ? "取消置顶" : "置顶"} ${skill.name}`} tooltip={skill.pinned ? "取消置顶" : "置顶"} onClick={() => onAction(skill.name, skill.pinned ? "unpin" : "pin")}>{skill.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}</SkillIconButton> : null}
                {skill.source === "private" && !skill.archived ? <SkillIconButton label={`归档 ${skill.name}`} tooltip="归档" onClick={() => onAction(skill.name, "archive")}><Archive className="h-3.5 w-3.5" /></SkillIconButton> : null}
                {skill.source === "private" && skill.archived ? <SkillIconButton label={`恢复 ${skill.name}`} tooltip="恢复" onClick={() => onAction(skill.name, "restore")}><ArchiveRestore className="h-3.5 w-3.5" /></SkillIconButton> : null}
                {!skill.archived ? <Button size="sm" variant="outline" onClick={() => onAction(skill.name, skill.enabled ? "disable" : "enable")}>{skill.enabled ? "停用" : "启用"}</Button> : null}
                {skill.hasScripts && !skill.archived ? <Button size="sm" variant="outline" className="gap-1" onClick={() => onConfigure(skill)}><Settings2 className="h-3.5 w-3.5" />{skill.runtimeReady ? "查看环境" : "准备环境"}</Button> : null}
              </div>
            </article>
          ))}
        </div>
      ) : <p className="px-4 py-8 text-center text-caption text-muted-foreground">{emptyLabel}</p>}
    </section>
  );
}

function SkillSetupDialog({
  skill,
  busy,
  job,
  error,
  onRun,
  onCancel,
  onOpenChange,
}: {
  skill: AgentSkill | null;
  busy: boolean;
  job: AgentSkillSetupJob | null;
  error: string | null;
  onRun: () => void;
  onCancel: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const ready = Boolean(skill?.runtimeReady);
  const optionalTypes = skill?.runtime?.optional_script_types ?? [];
  return (
    <Dialog open={skill !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>配置技能：{skill?.name ?? ""}</DialogTitle>
          <DialogDescription>技能内容保持只读；以下环境配置仅用于当前 Agent。</DialogDescription>
        </DialogHeader>
        {skill ? <div className="grid gap-4 py-1 text-caption">
          <section className="rounded-lg border border-border/60 p-4">
            <div className="flex items-center justify-between gap-3"><h3 className="text-ui font-medium">基础环境</h3><span className={skill.runtimeReady ? "text-emerald-600" : "text-amber-600"}>{skill.runtimeReady ? "已就绪" : "待准备"}</span></div>
            <p className="mt-1 text-muted-foreground">{skillRuntimeSummary(skill.runtime)}</p>
            {!skill.runtimeReady && skill.runtimeError ? <p className="mt-2 text-amber-600">{skill.runtimeError}</p> : null}
          </section>
          {optionalTypes.includes("r") ? <section className="rounded-lg border border-border/60 p-4"><div className="flex items-center justify-between gap-3"><h3 className="text-ui font-medium">可选 R 后端</h3><span className="text-muted-foreground">当前版本不支持</span></div><p className="mt-1 text-muted-foreground">不会阻止 Python 分析和科研绘图能力完成配置。</p></section> : null}
          {error ? <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">{error}</p> : null}
          {busy ? <p className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />{job?.stage === "checking" ? "正在检查环境…" : "正在下载并准备所需环境…"}关闭窗口后准备仍会继续。</p> : null}
          {job?.state === "cancelled" ? <p className="text-muted-foreground">准备已取消，可继续配置。</p> : null}
        </div> : null}
        <DialogFooter>
          {busy ? <Button variant="outline" onClick={onCancel}>取消准备</Button> : null}
          {!ready ? <Button disabled={busy} className="gap-1.5" onClick={onRun}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}准备环境</Button> : <Button onClick={() => onOpenChange(false)}>完成</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillIconButton({
  label,
  tooltip,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={label} onClick={onClick}>
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function SkillEditorDialog({
  skill,
  content,
  loading,
  saving,
  onContentChange,
  onSave,
  onOpenChange,
}: {
  skill: AgentSkill | null;
  content: string;
  loading: boolean;
  saving: boolean;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={skill !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>编辑技能：{skill?.name ?? ""}</DialogTitle>
          <DialogDescription>请保留 YAML frontmatter，且名称与目录名必须一致。</DialogDescription>
        </DialogHeader>
        {loading ? <p className="py-16 text-center text-caption text-muted-foreground">正在加载技能…</p> : <Textarea value={content} onChange={(event) => onContentChange(event.target.value)} className="min-h-[28rem] font-mono text-caption" />}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={onSave} disabled={loading || saving}>{saving ? "保存中…" : "保存技能"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AgentManagementView({
  agentId,
  onBack,
  onStartDirect,
}: {
  agentId: string;
  onBack: () => void;
  onStartDirect: () => void;
}) {
  const context = useClientContextOrNull();
  const [tab, setTab] = useState<Tab>("overview");
  const [detail, setDetail] = useState<AgentDetailPayload | null>(null);
  const [instructions, setInstructions] = useState<AgentInstruction[]>([]);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [selectedInstruction, setSelectedInstruction] = useState<AgentInstruction["key"]>("soul");
  const [draftInstruction, setDraftInstruction] = useState("");
  const [history, setHistory] = useState<AgentInstructionHistoryItem[]>([]);
  const [editingSkill, setEditingSkill] = useState<AgentSkill | null>(null);
  const [skillDraft, setSkillDraft] = useState("");
  const [skillEditorLoading, setSkillEditorLoading] = useState(false);
  const [skillSaving, setSkillSaving] = useState(false);
  const [configuringSkill, setConfiguringSkill] = useState<AgentSkill | null>(null);
  const [skillSetupBusy, setSkillSetupBusy] = useState(false);
  const [skillSetupJob, setSkillSetupJob] = useState<AgentSkillSetupJob | null>(null);
  const [skillSetupError, setSkillSetupError] = useState<string | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [knowledgeSelection, setKnowledgeSelection] = useState<AgentKnowledgeSelection | null>(null);
  const [knowledgeGraphRevision, setKnowledgeGraphRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [modelPresets, setModelPresets] = useState<Array<{ name: string; label: string; model: string; provider: string }>>([]);
  const pendingMaterialOpen = useMaterialsOpenStore((state) => state.pending);

  const token = context?.token ?? "";
  const client = context?.client ?? null;
  const selected = useMemo(
    () => instructions.find((instruction) => instruction.key === selectedInstruction) ?? null,
    [instructions, selectedInstruction],
  );
  const knowledgePanelLayout = useMemo(() => {
    try {
      const stored = window.localStorage.getItem("mona.agentKnowledge.layout");
      if (!stored) return undefined;
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      return typeof parsed["knowledge-sources"] === "number"
        && typeof parsed["knowledge-content"] === "number"
        ? parsed as Record<string, number>
        : undefined;
    } catch {
      return undefined;
    }
  }, []);
  const loadKnowledgeGraph = useCallback(
    () => getAgentKnowledgeGraph(agentId),
    [agentId],
  );
  const handleKnowledgeChanged = useCallback(() => {
    setKnowledgeGraphRevision((current) => current + 1);
  }, []);

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [nextDetail, nextInstructions, nextSkills] = await Promise.all([
        getAgentDetail(token, agentId),
        listAgentInstructions(token, agentId),
        listAgentSkills(token, agentId),
      ]);
      setDetail(nextDetail);
      setInstructions(nextInstructions);
      setSkills(nextSkills);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法加载 Agent 管理信息");
    } finally {
      setLoading(false);
    }
  }, [agentId, token]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!token) return;
    void fetchSettings(token)
      .then((settings) => setModelPresets(settings.model_presets))
      .catch(() => setModelPresets([]));
  }, [token]);
  useEffect(() => {
    setTab("overview");
    setSelectedInstruction("soul");
    setKnowledgeSelection(null);
  }, [agentId]);
  useEffect(() => {
    if (!pendingMaterialOpen || pendingMaterialOpen.agentId !== agentId) return;
    setTab("knowledge");
    setKnowledgeSelection({
      kind: pendingMaterialOpen.kind,
      path: pendingMaterialOpen.path,
      agentId,
    });
  }, [agentId, pendingMaterialOpen]);
  useEffect(() => {
    setDraftInstruction(selected?.content ?? "");
    if (!token) return;
    void listAgentInstructionHistory(token, agentId, selectedInstruction).then(setHistory).catch(() => setHistory([]));
  }, [agentId, selected, selectedInstruction, token]);
  useEffect(() => {
    if (!client) return;
    return client.onAgentsUpdated((changedAgentId) => {
      if (changedAgentId === agentId) void reload();
    });
  }, [agentId, client, reload]);

  const saveConfig = async (update: Record<string, unknown>) => {
    if (!client || !detail) return;
    try {
      await client.updateAgentConfig(agentId, update, detail.config.revision);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存设置失败");
      throw cause;
    }
  };
  const saveInstruction = async () => {
    if (!client) return;
    try {
      await client.saveAgentInstruction(agentId, selectedInstruction, draftInstruction);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存指令失败"); }
  };
  const restoreInstruction = async (commit: string) => {
    if (!client) return;
    try { await client.restoreAgentInstruction(agentId, selectedInstruction, commit); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : "恢复版本失败"); }
  };
  const actOnSkill = async (name: string, action: SkillAction) => {
    if (!client) return;
    try { await client.actOnAgentSkill(agentId, name, action); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : "更新 Skill 失败"); }
  };
  const runSkillSetup = async () => {
    if (!client || !configuringSkill) return;
    setSkillSetupBusy(true);
    setSkillSetupError(null);
    try {
      const job = await client.startAgentSkillSetup(agentId, configuringSkill.name);
      setSkillSetupJob(job);
    } catch (cause) {
      setSkillSetupError(cause instanceof Error ? cause.message : "技能配置失败");
    } finally {
      setSkillSetupBusy(false);
    }
  };
  const openSkillSetup = async (skill: AgentSkill) => {
    setConfiguringSkill(skill);
    setSkillSetupError(null);
    setSkillSetupJob(null);
    if (!client) return;
    try {
      const job = await client.getAgentSkillSetup(agentId, skill.name);
      if (job?.contentHash === (skill.executionHash ?? skill.contentHash)) setSkillSetupJob(job);
    } catch {
      // The current Skill state remains usable even if old setup history is unavailable.
    }
  };
  const cancelSkillSetup = async () => {
    if (!client || !skillSetupJob) return;
    try {
      setSkillSetupJob(await client.cancelAgentSkillSetup(skillSetupJob.jobId));
    } catch (cause) {
      setSkillSetupError(cause instanceof Error ? cause.message : "无法取消准备");
    }
  };
  useEffect(() => {
    if (!client || !configuringSkill || !skillSetupJob || !["queued", "running"].includes(skillSetupJob.state)) return;
    const timer = window.setInterval(() => {
      void client.getAgentSkillSetup(agentId, configuringSkill.name, skillSetupJob.jobId)
        .then(async (job) => {
          if (!job) return;
          setSkillSetupJob(job);
          setSkillSetupBusy(["queued", "running"].includes(job.state));
          if (job.state === "failed") setSkillSetupError(job.error ?? "技能配置失败");
          if (job.state === "completed") {
            const nextSkills = await listAgentSkills(token, agentId);
            setSkills(nextSkills);
            setConfiguringSkill(nextSkills.find((item) => item.name === configuringSkill.name) ?? null);
          }
        })
        .catch((cause) => setSkillSetupError(cause instanceof Error ? cause.message : "无法获取准备进度"));
    }, 800);
    return () => window.clearInterval(timer);
  }, [agentId, client, configuringSkill, skillSetupJob, token]);
  const openSkillEditor = async (skill: AgentSkill) => {
    if (!skill.editable) return;
    setEditingSkill(skill);
    setSkillDraft(skill.content ?? "");
    setSkillEditorLoading(false);
    if (skill.content == null) {
      setError("技能内容尚未由后端返回，请重启 Mona 后重试");
      setEditingSkill(null);
    }
  };
  const saveSkill = async () => {
    if (!client || !editingSkill) return;
    setSkillSaving(true);
    try {
      await client.updateAgentSkill(agentId, editingSkill.name, skillDraft, editingSkill.contentHash);
      setEditingSkill(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存 Skill 失败");
    } finally {
      setSkillSaving(false);
    }
  };
  const normalizedSkillQuery = skillQuery.trim().toLocaleLowerCase();
  const filteredSkills = normalizedSkillQuery
    ? skills.filter((skill) => skill.name.toLocaleLowerCase().includes(normalizedSkillQuery))
    : skills;
  const learnedSkills = filteredSkills.filter((skill) => skill.category === "self_learning");
  const externalSkills = filteredSkills.filter((skill) => skill.category !== "self_learning");

  if (loading && !detail) return <div className="flex h-full items-center justify-center text-muted-foreground">正在加载 Agent 管理…</div>;
  if (!detail) return <div className="flex h-full items-center justify-center text-destructive">{error ?? "Agent 不存在"}</div>;

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/50 px-5 py-3">
        <Button variant="ghost" size="icon" aria-label="返回会话" onClick={onBack}><ChevronLeft className="h-4 w-4" /></Button>
        <AgentAvatar agentId={detail.agent.id} displayName={detail.agent.displayName} avatarUrl={detail.agent.avatarUrl ?? (detail.agent.id === MONA_AGENT_ID ? MONA_AVATAR_IMAGE : null)} className="h-9 w-9" />
        <div className="min-w-0 flex-1"><h1 className="truncate text-title-sm">{detail.agent.displayName}</h1></div>
        <Button size="sm" className="gap-1.5" onClick={onStartDirect} disabled={!detail.agent.enabled}><MessageSquarePlus className="h-4 w-4" />新建对话</Button>
      </header>
      {error ? <div className="mx-5 mt-3 flex items-center justify-between rounded-md border border-destructive/35 bg-destructive/5 px-3 py-2 text-caption text-destructive"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="关闭"><X className="h-3.5 w-3.5" /></button></div> : null}
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="flex min-h-0 flex-1 flex-col">
         <div className="shrink-0 overflow-x-auto border-b border-border/45 px-5 py-2"><TabsList className="h-8 !bg-transparent p-0"><TabsTrigger className={MANAGEMENT_TAB_CLASS} value="overview">概览</TabsTrigger><TabsTrigger className={MANAGEMENT_TAB_CLASS} value="identity">个性化</TabsTrigger><TabsTrigger className={MANAGEMENT_TAB_CLASS} value="knowledge">知识</TabsTrigger><TabsTrigger className={MANAGEMENT_TAB_CLASS} value="permissions">工具</TabsTrigger><TabsTrigger className={MANAGEMENT_TAB_CLASS} value="skills">技能</TabsTrigger></TabsList></div>
        <TabsContent value="overview" className="m-0 min-h-0 flex-1 overflow-auto p-6">
          <div className="mx-auto max-w-3xl"><ConfigFields key={`${agentId}:${detail.config.revision}`} detail={detail} modelPresets={modelPresets} onSave={saveConfig} /><section className="mt-8 rounded-lg border border-border/65 p-4"><h2 className="text-ui font-medium">来源</h2><dl className="mt-3 grid gap-2 text-caption sm:grid-cols-2"><div><dt className="text-muted-foreground">包</dt><dd>{detail.definition.packageId || "Mona 平台"}</dd></div><div><dt className="text-muted-foreground">版本</dt><dd>{detail.definition.packageVersion || "—"}</dd></div></dl></section><section className="mt-4 rounded-lg border border-border/65 p-4"><h2 className="text-ui font-medium">私有数据</h2><p className="mt-1 text-caption text-muted-foreground">停用不会删除这些数据；记忆可在“个性化”中查看、编辑和恢复历史。</p><dl className="mt-3 grid gap-2 text-caption sm:grid-cols-2"><div><dt className="text-muted-foreground">记忆</dt><dd>{detail.data.memoryFiles} 个文件 · {formatBytes(detail.data.memoryBytes)}</dd></div><div><dt className="text-muted-foreground">Skills</dt><dd>{detail.data.skillFiles} 个文件 · {formatBytes(detail.data.skillBytes)}</dd></div></dl></section></div>
        </TabsContent>
        <TabsContent value="identity" className="m-0 min-h-0 flex-1 overflow-auto p-6">
          <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[12rem_minmax(0,1fr)]"><aside className="flex flex-col gap-1">{(Object.keys(INSTRUCTION_LABELS) as AgentInstruction["key"][]).map((key) => <button key={key} type="button" onClick={() => setSelectedInstruction(key)} className={`relative rounded-md px-3 py-2 text-left text-ui before:pointer-events-none before:absolute before:left-0 before:top-1/2 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-r before:bg-transparent before:content-[''] ${selectedInstruction === key ? "bg-transparent text-foreground before:bg-[hsl(var(--brand-red))]" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}>{INSTRUCTION_LABELS[key]}</button>)}</aside><div><div className="mb-3 flex items-center justify-between"><div><h2 className="text-ui font-medium">{INSTRUCTION_LABELS[selectedInstruction]}</h2><p className="text-caption text-muted-foreground">手动和 AI 修改都会自动记录版本，可随时恢复。</p></div><Button size="sm" className="gap-1.5" onClick={() => void saveInstruction()}><Save className="h-3.5 w-3.5" />保存</Button></div><Textarea value={draftInstruction} onChange={(event) => setDraftInstruction(event.target.value)} className="min-h-[22rem] font-mono text-caption" /><section className="mt-5"><h3 className="mb-2 flex items-center gap-1.5 text-ui font-medium"><FileClock className="h-4 w-4" />版本历史</h3><div className="grid gap-1">{history.length ? history.map((item) => <div key={item.sha} className="flex items-center gap-2 rounded-md border border-border/55 px-3 py-2 text-caption"><span className="min-w-0 flex-1 truncate">{item.message}</span><span className="shrink-0 text-muted-foreground">{item.timestamp}</span><Button size="sm" variant="ghost" onClick={() => void restoreInstruction(item.sha)}>恢复</Button></div>) : <p className="text-caption text-muted-foreground">保存后将显示版本历史。</p>}</div></section></div></div>
        </TabsContent>
        <TabsContent value="knowledge" className="m-0 min-h-0 flex-1 overflow-hidden">
          <ResizablePanelGroup
            id="agent-knowledge-layout"
            direction="horizontal"
            className="h-full min-h-0"
            defaultLayout={knowledgePanelLayout}
            onLayoutChanged={(layout) => {
              window.localStorage.setItem("mona.agentKnowledge.layout", JSON.stringify(layout));
            }}
          >
            <ResizablePanel
              id="knowledge-sources"
              defaultSize="34%"
              minSize="18rem"
              maxSize="46%"
            >
              <AgentKnowledgePanel
                agentId={agentId}
                selection={knowledgeSelection}
                onSelect={setKnowledgeSelection}
                onKnowledgeChanged={handleKnowledgeChanged}
              />
            </ResizablePanel>
            <ResizableHandle
              aria-label="调整资料列表宽度"
              className="data-[separator=hover]:bg-ring/35 data-[separator=active]:bg-ring/50"
            />
            <ResizablePanel
              id="knowledge-content"
              defaultSize="66%"
              minSize="20rem"
            >
              <div className="flex h-full min-h-0 flex-col bg-editor-surface">
                {knowledgeSelection ? (
                  <MaterialsPreview selection={knowledgeSelection} />
                ) : (
                  <GraphViewDialog
                    open
                    onOpenChange={() => undefined}
                    loadGraph={loadKnowledgeGraph}
                    refreshKey={knowledgeGraphRevision}
                    title="知识图谱"
                    loadingLabel="正在构建知识图谱..."
                    emptyTitle="还没有形成知识图谱"
                    emptyDescription="添加资料并完成学习后，知识之间的关系会显示在这里。"
                    legendMode="knowledge"
                    showClose={false}
                    onSelectNode={(node) => setKnowledgeSelection({
                      kind: "wiki",
                      path: node.path,
                      agentId,
                    })}
                  />
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </TabsContent>
        <TabsContent value="permissions" className="m-0 min-h-0 flex-1 overflow-auto p-6"><div className="mx-auto w-full max-w-5xl"><PermissionFields key={`${agentId}:${detail.config.revision}`} detail={detail} onSave={saveConfig} /></div></TabsContent>
        <TabsContent value="skills" className="m-0 min-h-0 flex-1 overflow-auto p-6">
          <div className="mx-auto grid max-w-5xl gap-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div><h2 className="text-title-sm">技能</h2><p className="mt-1 text-caption text-muted-foreground">自我学习由 Agent 创建；外部安装来自平台、Agent 包或导入内容。</p></div>
              <div className="relative w-full sm:w-64"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden /><Input type="search" value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="搜索技能" aria-label="搜索技能" className="pl-8 [&::-webkit-search-cancel-button]:hidden" /></div>
            </div>
            <SkillGroup title="自我学习" description="Agent 从任务中自动沉淀的专属能力。" emptyLabel={normalizedSkillQuery ? "没有匹配的自我学习技能。" : "这个 Agent 还没有自我学习的技能。"} skills={learnedSkills} onEdit={(skill) => void openSkillEditor(skill)} onAction={(name, action) => void actOnSkill(name, action)} onConfigure={(skill) => void openSkillSetup(skill)} />
            <SkillGroup title="外部安装" description="来自平台、Agent 包或其他来源的技能。平台和包技能为只读，个人配置可管理。" emptyLabel={normalizedSkillQuery ? "没有匹配的外部安装技能。" : "没有外部安装的技能。"} skills={externalSkills} onEdit={(skill) => void openSkillEditor(skill)} onAction={(name, action) => void actOnSkill(name, action)} onConfigure={(skill) => void openSkillSetup(skill)} />
            <section className="rounded-lg border border-border/60 bg-muted/20 p-4 text-caption leading-5 text-muted-foreground"><ShieldCheck className="mb-2 h-4 w-4 text-theme" />安装技能不会自动增加工具、连接或密钥权限。包含脚本的技能可按需准备共享环境。</section>
          </div>
          <SkillEditorDialog skill={editingSkill} content={skillDraft} loading={skillEditorLoading} saving={skillSaving} onContentChange={setSkillDraft} onSave={() => void saveSkill()} onOpenChange={(open) => { if (!open && !skillSaving) setEditingSkill(null); }} />
          <SkillSetupDialog skill={configuringSkill} busy={skillSetupBusy || skillSetupJob?.state === "queued" || skillSetupJob?.state === "running"} job={skillSetupJob} error={skillSetupError} onRun={() => void runSkillSetup()} onCancel={() => void cancelSkillSetup()} onOpenChange={(open) => { if (!open) setConfiguringSkill(null); }} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
