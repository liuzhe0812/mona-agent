import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  BookOpenText,
  Calendar,
  Database,
  FileStack,
  Library,
  Mail,
  Presentation,
  Server,
  Sparkles,
  Terminal,
  UserCircle,
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
    title: "自然语言入口",
    desc: "少提示词包装，直接围绕任务调工具、看反馈、继续推进。每个入口都能唤起 Agent，不切换模式。",
    lines: ["自然语言驱动", "轻量推理链", "跨模块调度"],
    accent: "#101010",
  },
  {
    icon: Mail,
    name: "邮件",
    title: "IMAP 多账户客户端",
    desc: "Foxmail 风格界面，多账户同时收发，AI 起草回复，附件直接进笔记或知识库。",
    lines: ["多账户 IMAP", "AI 起草回复", "附件沉淀"],
    accent: "#101010",
  },
  {
    icon: Calendar,
    name: "日程",
    title: "日历 + 提醒 + 任务",
    desc: "日历视图排开每一天，定时提醒不漏事，任务列表和笔记联动，做完即归档。",
    lines: ["日历视图", "定时提醒", "任务联动"],
    accent: "#101010",
  },
  {
    icon: BookOpenText,
    name: "笔记",
    title: "双向链接 + 图谱",
    desc: "Markdown 笔记，输入两个方括号自动补全链接，图谱视图看全局关系，模板引擎快速起稿。",
    lines: ["双向链接", "图谱视图", "模板引擎"],
    accent: "#101010",
  },
  {
    icon: Library,
    name: "知识库",
    title: "向量检索 + 语义召回",
    desc: "笔记和会话自动沉淀为可检索知识，遇到同类问题直接复用历史经验，不用重新查。",
    lines: ["语义检索", "关联问答", "知识图谱"],
    accent: "#101010",
  },
  {
    icon: Terminal,
    name: "浏览器",
    title: "内置浏览器 + AI 助手",
    desc: "标签管理、书签栏、页内搜索、Cookie 管理，AI 助手读页总结，不用复制粘贴到对话框。",
    lines: ["标签管理", "AI 读页总结", "书签管理"],
    accent: "#101010",
  },
  {
    icon: Server,
    name: "终端",
    title: "SSH 批量 + 桌面接管",
    desc: "自然语言远程维护主机，支持批量 SSH、SFTP、VNC 桌面模式和全程白盒记录。",
    lines: ["远程巡检", "批量执行", "桌面接管"],
    accent: "#101010",
  },
  {
    icon: Database,
    name: "数据库",
    title: "自然语言转 SQL",
    desc: "把问题翻成 SQL，把 SQL 解释成人话，高危操作先提醒，查库和排障少来回。",
    lines: ["自然语言 SQL", "表结构问答", "高危提醒"],
    accent: "#101010",
  },
  {
    icon: Presentation,
    name: "文档",
    title: "AI 生成 PPT / 流程图",
    desc: "基于提示词或文档生成可编辑 PPT、流程图、文档，内置模板，并支持接入文生图模型。",
    lines: ["提示词生成", "文档生成", "模板系统"],
    accent: "#101010",
  },
  {
    icon: UserCircle,
    name: "画像",
    title: "用户蒸馏 + 可视化",
    desc: "你的工作模式被蒸馏成画像，八维雷达、技能矩阵、知识星图，AI 协作越来越精准。",
    lines: ["人物画像", "成长轨迹", "工作模式"],
    accent: "#101010",
  },
];

export default function ToolsSection() {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = modules[activeIndex];

  return (
    <section
      id="modules"
      className="relative flex h-[100svh] items-center overflow-hidden bg-[#f7f7f5] px-6 pb-16 pt-20 text-[#101010]"
    >
      <div className="mx-auto max-w-7xl">
        <ScrollReveal>
          <div className="mb-5 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
            <div>
              <p className="mb-3 font-mono text-sm uppercase text-black/[0.42]">
                Unified Desktop
              </p>
              <h2 className="max-w-3xl text-4xl font-semibold leading-tight md:text-5xl">
                一个桌面Agent，所有工作。
              </h2>
            </div>
            <p className="max-w-xl text-base leading-7 text-black/[0.62] md:text-lg">
              不用切 10 个工具，信息入口都在这里。每个模块都能独立用，但真正有价值的是它们互相接力——邮件附件进笔记，笔记进知识库，知识库进对话，对话生成 PPT。
            </p>
          </div>
        </ScrollReveal>

        <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr] lg:items-stretch">
          <ScrollReveal>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-2">
              {modules.map((item, index) => (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`group flex min-h-[60px] flex-col justify-between rounded-md border p-2.5 text-left transition sm:min-h-[72px] lg:flex-row lg:items-center lg:py-3 ${
                    activeIndex === index
                      ? "border-black bg-[#101010] text-white shadow-[0_14px_38px_rgba(16,16,16,0.08)]"
                      : "border-black/10 bg-white/[0.54] text-black/[0.62] hover:border-black/22 hover:text-black"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <item.icon
                      className="h-4 w-4 shrink-0"
                      style={{ color: activeIndex === index ? "#ffffff" : undefined }}
                    />
                    <span className="text-sm font-semibold">{item.name}</span>
                  </div>
                  <span className="hidden font-mono text-[10px] opacity-45 lg:inline">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                </button>
              ))}
            </div>
          </ScrollReveal>

          <ScrollReveal delay={0.1}>
            <div className="relative min-h-[340px] lg:h-[500px] overflow-hidden rounded-md border border-black/10 bg-white/[0.72] p-5 shadow-[0_24px_70px_rgba(16,16,16,0.08)]">
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
                    <span style={{ color: active.accent }}>mona</span> routes task through unified desktop
                  </p>
                  <p className="mt-2 text-black/[0.36]">
                    / {active.name.toLowerCase()} / relay to other modules / auto-sediment
                  </p>
                </div>
              </div>

              <FileStack className="absolute -bottom-10 -right-8 h-36 w-36 text-black/[0.045]" />
            </div>
          </ScrollReveal>
        </div>
      </div>
      <PageTurnButton href="#agent" label="进入贯穿屏" tone="light" />
    </section>
  );
}
