import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BookOpenText,
  Bot,
  Database,
  FileStack,
  Library,
  Presentation,
  Server,
  Sparkles,
} from "lucide-react";
import PageTurnButton from "@/components/PageTurnButton";
import ScrollReveal from "@/components/ScrollReveal";

interface ModuleItem {
  icon: LucideIcon;
  name: string;
  title: string;
  desc: string;
  lines: string[];
  accent: string;
}

const modules: ModuleItem[] = [
  {
    icon: Bot,
    name: "Agent",
    title: "极简 Agent 内核",
    desc: "少提示词包装，直接围绕任务调工具、看反馈、继续推进。",
    lines: ["自然语言入口", "轻量推理链", "快捷功能调度"],
    accent: "#101010",
  },
  {
    icon: Server,
    name: "SSH",
    title: "AI 驱动系统运维",
    desc: "自然语言远程维护主机，支持批量 SSH、桌面模式和全程白盒记录。",
    lines: ["远程巡检", "批量执行", "桌面接管"],
    accent: "#101010",
  },
  {
    icon: Database,
    name: "DB",
    title: "AI 驱动数据库运维",
    desc: "把问题翻成 SQL，把 SQL 解释成人话，让查库和排障少来回。",
    lines: ["自然语言生成 SQL", "表结构问答", "高危操作提醒"],
    accent: "#101010",
  },
  {
    icon: BookOpenText,
    name: "Notes",
    title: "AI 驱动笔记",
    desc: "Markdown 笔记、会话记录、知识点提取和个人知识库形成闭环。",
    lines: ["对话转笔记", "运维记录归档", "知识点提取"],
    accent: "#101010",
  },
  {
    icon: Library,
    name: "Knowledge",
    title: "AI 驱动知识库",
    desc: "笔记和会话自动沉淀为可检索知识，遇到同类问题直接复用历史经验。",
    lines: ["语义检索", "关联问答", "知识图谱"],
    accent: "#101010",
  },
  {
    icon: Presentation,
    name: "PPT",
    title: "AI PPT 制作",
    desc: "基于提示词或文档生成可编辑 PPT，内置模板，并支持接入文生图模型。",
    lines: ["提示词生成", "文档生成", "模板系统"],
    accent: "#101010",
  },
];

export default function ToolsSection() {
  const [activeIndex, setActiveIndex] = useState(1);
  const active = modules[activeIndex];

  return (
    <section id="modules" className="relative flex h-[100svh] items-center overflow-hidden bg-[#f7f7f5] px-6 pb-16 pt-20 text-[#101010]">
      <div className="mx-auto max-w-7xl">
        <ScrollReveal>
          <div className="mb-5 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
            <div>
              <p className="mb-3 font-mono text-sm uppercase text-black/[0.42]">
                Product Map
              </p>
              <h2 className="max-w-3xl text-4xl font-semibold leading-tight md:text-5xl">
                一个 Agent，接住六类高频工作。
              </h2>
            </div>
            <p className="max-w-xl text-base leading-7 text-black/[0.62] md:text-lg">
              每个模块都有独立入口，但真正有价值的是它们能互相接力：排障记录进笔记，知识点进知识库，复盘材料再生成 PPT。
            </p>
          </div>
        </ScrollReveal>

        <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr] lg:items-stretch">
          <ScrollReveal>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-6 lg:grid-cols-1">
              {modules.map((item, index) => (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`group flex min-h-[76px] flex-col justify-between rounded-md border p-3 text-left transition sm:min-h-[96px] lg:min-h-0 lg:flex-row lg:items-center lg:py-4 ${
                    activeIndex === index
                      ? "border-black bg-[#101010] text-white shadow-[0_14px_38px_rgba(16,16,16,0.08)]"
                      : "border-black/10 bg-white/[0.54] text-black/[0.62] hover:border-black/22 hover:text-black"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <item.icon
                      className="h-5 w-5 shrink-0"
                      style={{ color: activeIndex === index ? "#ffffff" : undefined }}
                    />
                    <span className="font-semibold">{item.name}</span>
                  </div>
                  <span className="font-mono text-xs opacity-45">0{index + 1}</span>
                </button>
              ))}
            </div>
          </ScrollReveal>

          <ScrollReveal delay={0.1}>
            <div className="relative min-h-[340px] overflow-hidden rounded-md border border-black/10 bg-white/[0.72] p-5 shadow-[0_24px_70px_rgba(16,16,16,0.08)]">
              <div className="absolute inset-0 bg-[linear-gradient(rgba(16,16,16,0.052)_1px,transparent_1px),linear-gradient(90deg,rgba(16,16,16,0.052)_1px,transparent_1px)] bg-[size:34px_34px] opacity-30" />
              <div className="relative">
                <div
                  className="mb-5 inline-flex rounded-md border bg-[#f7f7f5] px-3 py-2 font-mono text-sm"
                  style={{ borderColor: active.accent, color: active.accent }}
                >
                  {active.name.toLowerCase()} module online
                </div>
                <active.icon className="mb-5 h-11 w-11" style={{ color: active.accent }} />
                <h3 className="max-w-xl text-3xl font-semibold md:text-4xl">
                  {active.title}
                </h3>
                <p className="mt-4 max-w-2xl text-base leading-7 text-black/[0.64]">
                  {active.desc}
                </p>

                <div className="mt-5 grid gap-3 md:grid-cols-3">
                  {active.lines.map((line) => (
                    <div
                      key={line}
                      className="rounded-md border border-black/10 bg-[#f7f7f5] p-3"
                    >
                      <Sparkles className="mb-3 h-4 w-4" style={{ color: active.accent }} />
                      <p className="text-sm text-black/[0.7]">{line}</p>
                    </div>
                  ))}
                </div>

                <div className="mt-5 rounded-md border border-black/10 bg-white p-3 font-mono text-xs text-black/[0.58]">
                  <p>
                    <span style={{ color: active.accent }}>mona</span> routes task through agent graph
                  </p>
                  <p className="mt-2 text-black/[0.36]">
                    / {active.name.toLowerCase()} / quick actions / history / knowledge
                  </p>
                </div>
              </div>

              <FileStack className="absolute -bottom-10 -right-8 h-36 w-36 text-black/[0.045]" />
            </div>
          </ScrollReveal>
        </div>
      </div>
      <PageTurnButton href="#whitebox" label="进入白盒运维屏" tone="light" />
    </section>
  );
}
