import { Bolt, Eye, Gauge, MessageSquareText } from "lucide-react";
import PageTurnButton from "@/components/PageTurnButton";
import ScrollReveal from "@/components/ScrollReveal";
import TiltCard from "@/components/TiltCard";

const principles = [
  {
    icon: Gauge,
    title: "快，不绕",
    desc: "没有一层层工程级提示词和多余人格包装，目标是把事办完，响应更直接。",
  },
  {
    icon: MessageSquareText,
    title: "人话驱动",
    desc: "巡检、查库、整理笔记、做 PPT 都从自然语言开始，不要求用户记命令。",
  },
  {
    icon: Eye,
    title: "过程可见",
    desc: "AI 怎么想、准备执行什么、命令输出是什么，全都摊开给你看。",
  },
  {
    icon: Bolt,
    title: "快捷功能随手用",
    desc: "把高频动作做成 AI 快捷入口，少点配置，多点直接可用。",
  },
];

export default function AgentSection() {
  return (
    <section id="agent" className="relative flex h-[100svh] items-center overflow-hidden bg-white px-6 pb-16 pt-20 text-[#101010]">
      <div className="mx-auto max-w-7xl">
        <ScrollReveal>
          <div className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
            <div>
              <p className="mb-3 font-mono text-sm uppercase text-black/[0.45]">
                Minimal Agent
              </p>
              <h2 className="text-4xl font-semibold leading-tight md:text-5xl">
                极简主义 Agent，少说套话，多干正事。
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-7 text-black/[0.62] md:text-lg">
              Mona 的核心不是陪聊，而是把 AI 放到真实工作台上。它会拆任务、调工具、展示执行细节，再把结果沉淀成后续能复用的记录。
            </p>
          </div>
        </ScrollReveal>

        <div className="mt-10 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {principles.map((item, index) => (
            <ScrollReveal key={item.title} delay={index * 0.05}>
              <TiltCard className="h-full rounded-md border border-black/10 bg-[#f7f7f5] p-5 transition hover:border-black/[0.24]">
                <item.icon className="mb-4 h-5 w-5 text-black" />
                <h3 className="mb-2 text-lg font-semibold">{item.title}</h3>
                <p className="text-sm leading-6 text-black/[0.58]">{item.desc}</p>
              </TiltCard>
            </ScrollReveal>
          ))}
        </div>
      </div>
      <PageTurnButton href="#modules" label="进入模块屏" tone="light" />
    </section>
  );
}
