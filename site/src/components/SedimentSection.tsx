import { ArrowDownRight, BookOpenText, Brain, Bookmark, MessageSquare, Sparkles } from "lucide-react";
import PageTurnButton from "@/components/PageTurnButton";
import ScrollReveal from "@/components/ScrollReveal";

const sources = [
  { icon: MessageSquare, label: "AI 聊天记录", desc: "你和 AI 的每次对话" },
  { icon: BookOpenText, label: "笔记", desc: "Markdown 写下的内容" },
  { icon: Bookmark, label: "右键收藏", desc: "网页、文字、图片随手存" },
  { icon: Sparkles, label: "浏览器收藏夹", desc: "导入的书签和链接" },
];

const stages = [
  {
    icon: Sparkles,
    label: "汇聚",
    title: "四处散落的工作自动汇到一处",
    desc: "AI 聊天记录、笔记、邮件、浏览器收藏夹，全部进同一座知识库，不用再东翻西找。",
    accent: "#101010",
  },
  {
    icon: Brain,
    label: "理解",
    title: "AI 读懂内容找出关联",
    desc: "AI 帮你提炼主题和关键词，把语义相近的内容自动连起来，不需要手动分类或打标签。",
    accent: "#101010",
  },
  {
    icon: ArrowDownRight,
    label: "沉淀",
    title: "工作变成下次能用的资产",
    desc: "解决过一次的问题、写过的方案、查到的资料，都沉淀成可被 AI 调用的知识。",
    accent: "#101010",
  },
];

export default function SedimentSection() {
  return (
    <section
      id="sediment"
      className="relative flex h-[100svh] items-center overflow-hidden bg-[#f7f7f5] px-6 pb-16 pt-20 text-[#101010]"
    >
      <div className="mx-auto max-w-7xl">
        <ScrollReveal>
          <div className="mb-8 grid gap-6 lg:grid-cols-[0.85fr_1.15fr] lg:items-end">
            <div>
              <p className="mb-3 font-mono text-sm uppercase text-black/[0.42]">
                Knowledge Loop
              </p>
              <h2 className="text-4xl font-semibold leading-tight md:text-5xl">
                工作自动变成知识。
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-7 text-black/[0.62] md:text-lg">
              你做过的每一件事，都变成下次能复用的资产。Mona 把散落各处的工作自动汇到一座知识库，AI 读懂、连起来、随时调用。
            </p>
          </div>
        </ScrollReveal>

        {/* 知识来源 */}
        <ScrollReveal delay={0.05}>
          <div className="mb-5 rounded-md border border-black/10 bg-white p-5">
            <div className="mb-4 flex items-center justify-between">
              <p className="font-mono text-xs uppercase text-black/[0.42]">
                来源 · sources
              </p>
              <p className="font-mono text-xs text-black/[0.34]">
                四处散落 → 一座知识库
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {sources.map((s) => (
                <div
                  key={s.label}
                  className="flex items-start gap-3 rounded-md border border-black/10 bg-[#f7f7f5] p-3"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-black/10 bg-white">
                    <s.icon className="h-4 w-4 text-black" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{s.label}</p>
                    <p className="mt-0.5 text-xs leading-5 text-black/[0.56]">{s.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </ScrollReveal>

        {/* 三步价值流 */}
        <div className="relative grid gap-3 md:grid-cols-3">
          <div className="pointer-events-none absolute left-0 right-0 top-1/2 hidden h-px -translate-y-1/2 bg-gradient-to-r from-transparent via-black/15 to-transparent md:block" />
          {stages.map((stage, index) => (
            <ScrollReveal key={stage.label} delay={index * 0.08}>
              <div className="group relative h-full rounded-md border border-black/10 bg-white p-5 transition hover:-translate-y-1 hover:border-black/[0.24]">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md border border-black/10 bg-[#f7f7f5]">
                    <stage.icon className="h-4 w-4" style={{ color: stage.accent }} />
                  </div>
                  <span className="font-mono text-3xl font-semibold text-black/[0.06]">
                    0{index + 1}
                  </span>
                </div>
                <p className="mb-1.5 font-mono text-xs uppercase text-black/[0.42]">
                  {stage.label}
                </p>
                <h3 className="mb-2 text-base font-semibold leading-snug">
                  {stage.title}
                </h3>
                <p className="text-sm leading-6 text-black/[0.58]">{stage.desc}</p>
              </div>
            </ScrollReveal>
          ))}
        </div>

        <ScrollReveal delay={0.22}>
          <p className="mt-5 text-center font-mono text-sm text-black/[0.42]">
            知识不是存在某个文件夹，是 AI 随时能调用的资产。
          </p>
        </ScrollReveal>
      </div>
      <PageTurnButton href="#evolution" label="进入进化屏" tone="light" />
    </section>
  );
}
