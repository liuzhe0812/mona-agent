import { Eye, FileClock, ListTree, Play, ShieldAlert } from "lucide-react";
import PageTurnButton from "@/components/PageTurnButton";
import ScrollReveal from "@/components/ScrollReveal";

const steps = [
  {
    icon: ListTree,
    title: "先拆任务",
    desc: "Mona 先把一句话拆成可确认的步骤，不急着执行。",
    code: "plan: read mail -> draft reply -> attach note -> send",
  },
  {
    icon: ShieldAlert,
    title: "再看风险",
    desc: "涉及写入、删除、重启、发送这类动作，会把意图说清楚再让你确认。",
    code: "guard: destructive action requires approval",
  },
  {
    icon: Play,
    title: "透明执行",
    desc: "命令、SQL、邮件、文档的执行过程都展开，不靠一句完成了糊弄。",
    code: "$ db.query 'SELECT count(*) FROM orders WHERE status=...'",
  },
  {
    icon: FileClock,
    title: "可复盘",
    desc: "对话和操作记录完整保留，随时回看当时怎么做的、为什么这么做。",
    code: "history: session 2026-07-11 · 12 steps · replayable",
  },
];

export default function FeaturesSection() {
  return (
    <section id="whitebox" className="relative flex h-[100svh] items-center overflow-hidden bg-white px-6 pb-16 pt-20 text-[#101010]">
      <div className="mx-auto max-w-7xl">
        <ScrollReveal>
          <div className="mb-8 grid gap-6 lg:grid-cols-[0.85fr_1.15fr] lg:items-end">
            <div>
              <p className="mb-3 font-mono text-sm uppercase text-black/[0.42]">
                Whitebox Ops
              </p>
              <h2 className="text-4xl font-semibold leading-tight md:text-5xl">
                看得见，才敢交给 AI 做。
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-7 text-black/[0.62] md:text-lg">
              Mona 不做神秘自动化。它先计划，再执行，再沉淀。人可以随时看见它正在做什么，也能在关键节点接手。
            </p>
          </div>
        </ScrollReveal>

        <div className="grid gap-4 lg:grid-cols-4">
          {steps.map((step, index) => (
            <ScrollReveal key={step.title} delay={index * 0.08}>
              <div className="group relative min-h-[235px] overflow-hidden rounded-md border border-black/10 bg-[#f7f7f5] p-5 transition hover:-translate-y-1 hover:border-black/[0.24]">
                <div className="absolute right-4 top-4 font-mono text-5xl font-semibold text-black/[0.045]">
                  0{index + 1}
                </div>
                <step.icon className="mb-5 h-6 w-6 text-black" />
                <h3 className="mb-2 text-xl font-semibold">{step.title}</h3>
                <p className="mb-5 text-sm leading-6 text-black/[0.58]">{step.desc}</p>
                <div className="absolute bottom-4 left-4 right-4 rounded-md border border-black/10 bg-white p-2.5 font-mono text-xs leading-5 text-black/[0.62]">
                  {step.code}
                </div>
              </div>
            </ScrollReveal>
          ))}
        </div>

        <ScrollReveal delay={0.18}>
          <div className="mt-5 flex flex-col justify-between gap-4 rounded-md border border-black/10 bg-[#f7f7f5] p-4 text-[#101010] md:flex-row md:items-center">
            <div className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-white text-black">
                <Eye className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">每个动作都有据可查。</h3>
                <p className="mt-1 text-sm text-black/[0.52]">
                  邮件起草、文档生成、批量运维、数据库查询都会保留上下文和操作记录。
                </p>
              </div>
            </div>
            <a
              href="/download"
              className="inline-flex items-center justify-center rounded-md border border-black/10 bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:border-black/28"
            >
              下载 Mona
            </a>
          </div>
        </ScrollReveal>
      </div>
      <PageTurnButton href="#desktop" label="进入桌面端屏" tone="light" />
    </section>
  );
}
