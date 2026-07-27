import { Bot, Bolt, Calendar, Database, Eye, Mail, BookOpenText, MessageSquareText, Terminal, Wand2 } from "lucide-react";
import AgentLogo from "@/components/AgentLogo";
import PageTurnButton from "@/components/PageTurnButton";
import ScrollReveal from "@/components/ScrollReveal";

const principles = [
  {
    icon: Bot,
    title: "随处在",
    desc: "邮件里起回复、笔记里提要点、浏览器里读页、终端里执行——每个入口都有 AI 接手，不切换模式。",
  },
  {
    icon: MessageSquareText,
    title: "说人话",
    desc: "巡检、查库、写文档、做 PPT 都从自然语言开始，不要求用户记命令。",
  },
  {
    icon: Eye,
    title: "过程摊开",
    desc: "AI 怎么想、准备做什么、输出是什么，全都给你看，不靠一句完成了糊弄。",
  },
  {
    icon: Wand2,
    title: "跨域协作",
    desc: "邮件里提到的文件，AI 直接从笔记拉；对话里查到的结果，AI 直接沉淀为知识。",
  },
];

const nodes = [
  { icon: Mail, label: "邮件", angle: -90 },
  { icon: Calendar, label: "日程", angle: -30 },
  { icon: BookOpenText, label: "笔记", angle: 30 },
  { icon: Bolt, label: "浏览器", angle: 90 },
  { icon: Terminal, label: "终端", angle: 150 },
  { icon: Database, label: "数据库", angle: 210 },
];

export default function AgentSection() {
  return (
    <section
      id="agent"
      className="relative flex h-[100svh] items-center overflow-hidden bg-white px-6 pb-16 pt-20 text-[#101010]"
    >
      <div className="mx-auto max-w-7xl">
        <ScrollReveal>
          <div className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
            <div>
              <p className="mb-3 font-mono text-sm uppercase text-black/[0.45]">
                AI Backbone
              </p>
              <h2 className="text-4xl font-semibold leading-tight md:text-5xl">
                AI 是骨架，不是按钮。
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-7 text-black/[0.62] md:text-lg">
              AI 不在某个功能里待命，是贯穿每个工作的心智。同一个 Agent，在邮件里起草、在终端里执行、在笔记里提要点、在浏览器里读页——它知道你在干什么，知道上下文在哪。
            </p>
          </div>
        </ScrollReveal>

        {/* 辐射可视化 */}
        <ScrollReveal delay={0.1}>
          <div className="relative mx-auto mt-10 grid max-w-5xl gap-8 lg:grid-cols-[1fr_1fr] lg:items-center">
            <div className="relative mx-auto h-[260px] w-[260px] sm:h-[320px] sm:w-[320px]">
              {/* 同心圆 */}
              <svg viewBox="0 0 320 320" className="absolute inset-0 h-full w-full">
                {[60, 110, 155].map((r) => (
                  <circle
                    key={r}
                    cx="160"
                    cy="160"
                    r={r}
                    fill="none"
                    stroke="rgba(16,16,16,0.10)"
                    strokeWidth="0.8"
                  />
                ))}
                {/* 辐射线 */}
                {nodes.map((node, i) => {
                  const rad = (node.angle * Math.PI) / 180;
                  const x = 160 + 155 * Math.cos(rad);
                  const y = 160 + 155 * Math.sin(rad);
                  return (
                    <line
                      key={i}
                      x1="160"
                      y1="160"
                      x2={x}
                      y2={y}
                      stroke="rgba(16,16,16,0.15)"
                      strokeWidth="0.8"
                      strokeDasharray="3 3"
                    />
                  );
                })}
              </svg>
              {/* 中心 AgentLogo */}
              <div className="absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2">
                <AgentLogo state="working" className="h-full w-full" title="Mona Agent" />
              </div>
              {/* 节点 */}
              {nodes.map((node, i) => {
                const rad = (node.angle * Math.PI) / 180;
                const x = 50 + 50 * Math.cos(rad);
                const y = 50 + 50 * Math.sin(rad);
                return (
                  <div
                    key={i}
                    className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5"
                    style={{ left: `${x}%`, top: `${y}%` }}
                  >
                    <div className="flex h-11 w-11 items-center justify-center rounded-md border border-black/10 bg-white shadow-sm">
                      <node.icon className="h-5 w-5 text-black" />
                    </div>
                    <span className="text-xs font-medium text-black/[0.62]">{node.label}</span>
                  </div>
                );
              })}
            </div>

            {/* 四原则 */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {principles.map((item, index) => (
                <ScrollReveal key={item.title} delay={index * 0.06}>
                  <div className="h-full rounded-md border border-black/10 bg-[#f7f7f5] p-4 transition hover:border-black/[0.24]">
                    <item.icon className="mb-3 h-5 w-5 text-black" />
                    <h3 className="mb-1.5 text-base font-semibold">{item.title}</h3>
                    <p className="text-sm leading-6 text-black/[0.58]">{item.desc}</p>
                  </div>
                </ScrollReveal>
              ))}
            </div>
          </div>
        </ScrollReveal>

        <ScrollReveal delay={0.2}>
          <p className="mt-8 text-center font-mono text-sm text-black/[0.42]">
            不是把 AI 塞进每个功能，是让每个功能都长在 AI 上。
          </p>
        </ScrollReveal>
      </div>
      <PageTurnButton href="#sediment" label="进入沉淀屏" tone="light" />
    </section>
  );
}
