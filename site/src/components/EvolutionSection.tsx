import { Eye, GitGraph, HeartHandshake, ShieldCheck, Sparkles } from "lucide-react";
import PageTurnButton from "@/components/PageTurnButton";
import ScrollReveal from "@/components/ScrollReveal";

const values = [
  {
    icon: HeartHandshake,
    label: "更懂你",
    title: "AI 记得你怎么工作",
    desc: "你和 AI 的每次协作、每条笔记、每次邮件回复，都让 Mona 更懂你的领域、风格和偏好。下次开口它就知道你在说什么。",
    points: ["知道你常处理什么", "记得你的写作风格", "理解你的工作习惯"],
  },
  {
    icon: GitGraph,
    label: "看得见成长",
    title: "自己的能力被画出来",
    desc: "Mona 把你解决过的问题、学过的新东西、做过的产出串成一条成长线。不靠自我感觉，是有据可查的轨迹。",
    points: ["学到了哪些新东西", "形成了哪些新技能", "和过去的自己对比"],
  },
  {
    icon: Sparkles,
    label: "工作模式复用",
    title: "高频路径自动加速",
    desc: "你反复在做的事，Mona 会识别出模式。下次类似场景，它先帮你预填好步骤、找好资料，让你少走几步。",
    points: ["识别重复工作流", "自动调取历史方案", "下次直接复用"],
  },
];

const promises = [
  { icon: Eye, label: "看得见", desc: "AI 眼里的你是什么样，随时可看" },
  { icon: ShieldCheck, label: "可改可删", desc: "不满意就改，不想要就删" },
  { icon: HeartHandshake, label: "为你服务", desc: "画像用来让 AI 更懂你，不是评判你" },
];

export default function EvolutionSection() {
  return (
    <section
      id="evolution"
      className="relative flex h-[100svh] items-center overflow-hidden bg-white px-6 pb-16 pt-20 text-[#101010]"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(16,16,16,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(16,16,16,0.04)_1px,transparent_1px)] bg-[size:48px_48px] opacity-40" />
      <div className="pointer-events-none absolute left-1/2 top-0 h-[300px] w-[700px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(16,16,16,0.06),transparent_70%)]" />

      <div className="relative mx-auto max-w-7xl">
        <ScrollReveal>
          <div className="mb-8 grid gap-6 lg:grid-cols-[0.85fr_1.15fr] lg:items-end">
            <div>
              <p className="mb-3 font-mono text-sm uppercase text-black/[0.42]">
                Self Evolving
              </p>
              <h2 className="text-4xl font-semibold leading-tight md:text-5xl">
                AI 会越来越懂你。
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-7 text-black/[0.62] md:text-lg">
              你和 Mona 的每一次协作都在喂养它对你的理解。工作模式被蒸馏成画像，下次对话更精准，建议更贴身。
            </p>
          </div>
        </ScrollReveal>

        {/* 三大价值卡片 */}
        <div className="grid gap-3 md:grid-cols-3">
          {values.map((v, index) => (
            <ScrollReveal key={v.label} delay={index * 0.08}>
              <div className="group relative flex h-full flex-col rounded-md border border-black/10 bg-[#f7f7f5] p-5 transition hover:-translate-y-1 hover:border-black/[0.24]">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md border border-black/10 bg-white">
                    <v.icon className="h-5 w-5 text-black" />
                  </div>
                  <span className="font-mono text-3xl font-semibold text-black/[0.06]">
                    0{index + 1}
                  </span>
                </div>
                <p className="mb-1.5 font-mono text-xs uppercase text-black/[0.42]">
                  {v.label}
                </p>
                <h3 className="mb-2 text-lg font-semibold leading-snug">
                  {v.title}
                </h3>
                <p className="mb-4 text-sm leading-6 text-black/[0.58]">{v.desc}</p>
                <ul className="mt-auto space-y-1.5">
                  {v.points.map((p) => (
                    <li
                      key={p}
                      className="flex items-center gap-2 text-xs text-black/[0.62]"
                    >
                      <span className="h-1 w-1 rounded-full bg-black/40" />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            </ScrollReveal>
          ))}
        </div>

        {/* 隐私承诺 */}
        <ScrollReveal delay={0.18}>
          <div className="mt-5 overflow-hidden rounded-md border border-black/10 bg-[#101010] p-5 text-white">
            <div className="mb-3 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
              <p className="font-mono text-xs uppercase text-white/60">
                你说了算 · privacy first
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {promises.map((p) => (
                <div key={p.label} className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/[0.04]">
                    <p.icon className="h-4 w-4 text-white" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{p.label}</p>
                    <p className="mt-0.5 text-xs leading-5 text-white/55">{p.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </ScrollReveal>

        <ScrollReveal delay={0.22}>
          <p className="mt-5 text-center font-mono text-sm text-black/[0.42]">
            画像不是评判你，是让 AI 更懂你。
          </p>
        </ScrollReveal>
      </div>

      <PageTurnButton href="#whitebox" label="进入透明屏" tone="light" />
    </section>
  );
}
