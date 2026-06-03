import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  BookOpenText,
  Bot,
  CheckCircle2,
  Database,
  Presentation,
  Server,
} from "lucide-react";

type ScenarioKey = "ssh" | "database" | "notes" | "ppt";

interface Scenario {
  key: ScenarioKey;
  icon: LucideIcon;
  label: string;
  title: string;
  prompt: string;
  command: string;
  summary: string;
  steps: string[];
  telemetry: string[];
  quickActions: string[];
  accent: string;
}

const scenarios: Scenario[] = [
  {
    key: "ssh",
    icon: Server,
    label: "SSH 运维",
    title: "AI 正在值守生产主机",
    prompt: "检查 prod-api 的负载、磁盘和异常日志，必要时给出清理建议。",
    command: 'mona ssh prod-api --ask "做一次白盒巡检"',
    summary: "3 台主机已完成巡检，1 条风险需要确认，所有命令和输出已留痕。",
    steps: ["读取主机分组和 SSH 会话状态", "生成巡检计划", "逐条执行命令", "汇总风险记录"],
    telemetry: ["prod-api-01 load 0.82 disk 71%", "prod-api-02 load 1.13 disk 68%", "nginx error spike 12m ago"],
    quickActions: ["批量巡检", "日志解释", "桌面接管"],
    accent: "#101010",
  },
  {
    key: "database",
    icon: Database,
    label: "数据库",
    title: "把问题直接翻成 SQL",
    prompt: "查过去 24 小时支付失败最多的渠道，按失败原因分组。",
    command: "SELECT channel, reason, COUNT(*) FROM payments ...",
    summary: "已生成可读 SQL，自动标出高风险写操作，支持继续追问表结构。",
    steps: ["读取表结构", "拆查询条件", "生成 SQL", "解释结果"],
    telemetry: ["rows scanned 184,209", "top reason gateway_timeout 37.8%", "write guard enabled"],
    quickActions: ["生成 SQL", "解释慢查询", "表结构问答"],
    accent: "#101010",
  },
  {
    key: "notes",
    icon: BookOpenText,
    label: "笔记",
    title: "运维记录自动变成知识",
    prompt: "把刚才的 SSH 排障过程整理成 Markdown 笔记，并提取知识点。",
    command: "mona note from-session ssh/prod-api-2026-06-02",
    summary: "已生成 Markdown 笔记、知识点卡片和可检索索引。",
    steps: ["抽取事实", "整理 Markdown", "提炼知识点", "写入知识库"],
    telemetry: ["note saved: prod-api-nginx-spike.md", "knowledge points extracted: 8", "linked sessions: ssh + db"],
    quickActions: ["生成笔记", "提取知识点", "关联会话"],
    accent: "#101010",
  },
  {
    key: "ppt",
    icon: Presentation,
    label: "AI PPT",
    title: "把复盘材料做成可编辑 PPT",
    prompt: "基于这份故障复盘文档，生成一套 8 页技术汇报 PPT。",
    command: "mona ppt make incident-review.md --template ops-clean",
    summary: "已匹配模板、生成页面结构，可接入文生图模型补齐视觉素材。",
    steps: ["读取文档", "拆页面大纲", "套用模板", "按需补图"],
    telemetry: ["template: ops-clean / 16:9", "slides generated: 8", "editable shapes: 96"],
    quickActions: ["提示词生成", "文档生成", "文生图接入"],
    accent: "#101010",
  },
];

interface OpsConsoleProps {
  compact?: boolean;
}

export default function OpsConsole({ compact = false }: OpsConsoleProps) {
  const [activeKey, setActiveKey] = useState<ScenarioKey>("ssh");
  const active = useMemo(
    () => scenarios.find((item) => item.key === activeKey) ?? scenarios[0],
    [activeKey],
  );

  const content = (
    <AnimatePresence mode="wait">
      <motion.div
        key={active.key}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-black/[0.42]">
          <Bot className="h-3.5 w-3.5" />
          Agent Native Ops
        </p>
        <h3 className="text-2xl font-semibold text-[#101010]">{active.title}</h3>
        <div className="mt-4 rounded-md border border-black/10 bg-[#f7f7f5] p-3">
          <p className="text-xs text-black/[0.45]">你只需要说</p>
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-black/[0.78]">
            {active.prompt}
          </p>
        </div>
        <div className="mt-4 overflow-hidden rounded-md border border-black/10 bg-white font-mono">
          <div className="border-b border-black/10 px-3 py-2 text-xs text-black/[0.42]">
            透明执行区
          </div>
          <div className="space-y-1.5 p-3 text-xs">
            <p className="truncate text-black/[0.76]">
              <span style={{ color: active.accent }}>$</span> {active.command}
            </p>
            {active.telemetry.slice(0, compact ? 2 : 3).map((line) => (
              <p key={line} className="truncate text-black/[0.52]">
                <span className="text-black/[0.25]">-&gt;</span> {line}
              </p>
            ))}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {active.quickActions.map((action) => (
            <div
              key={action}
              className="rounded-md border border-black/10 bg-[#f7f7f5] px-2 py-2 text-center text-xs text-black/[0.68]"
            >
              {action}
            </div>
          ))}
        </div>
        {!compact ? (
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {active.steps.map((step, index) => (
              <div key={step} className="flex gap-2 rounded-md border border-black/10 bg-white p-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: active.accent }} />
                <p className="text-sm text-black/[0.66]">
                  <span className="mr-2 font-mono text-black/[0.32]">0{index + 1}</span>
                  {step}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </motion.div>
    </AnimatePresence>
  );

  return (
    <div className="relative overflow-hidden rounded-lg border border-black/10 bg-white/[0.82] text-[#101010] shadow-[0_24px_80px_rgba(16,16,16,0.14)]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(16,16,16,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(16,16,16,0.055)_1px,transparent_1px)] bg-[size:28px_28px] opacity-40" />
      <div className="relative flex items-center justify-between border-b border-black/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[#101010]" />
          <span className="h-2.5 w-2.5 rounded-full bg-black/35" />
          <span className="h-2.5 w-2.5 rounded-full bg-black/14" />
          <span className="ml-3 font-mono text-xs text-black/[0.45]">
            mona://ops-console
          </span>
        </div>
        <div
          className="rounded-md border px-2.5 py-1 font-mono text-xs"
          style={{ borderColor: active.accent, color: active.accent }}
        >
          live
        </div>
      </div>
      <div className="relative p-4">
        <div className="mb-4 grid grid-cols-4 gap-2">
          {scenarios.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveKey(item.key)}
              className={`flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs transition ${
                active.key === item.key
                  ? "border-black bg-[#101010] text-white"
                  : "border-black/10 bg-[#f7f7f5] text-black/[0.62] hover:text-black"
              }`}
            >
              <item.icon className="h-3.5 w-3.5" style={{ color: active.key === item.key ? "#ffffff" : undefined }} />
              <span className="hidden sm:inline">{item.label}</span>
            </button>
          ))}
        </div>
        {content}
      </div>
    </div>
  );
}
