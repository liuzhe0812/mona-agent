import {
  Activity,
  FolderUp,
  MonitorCog,
  PanelsTopLeft,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import AgentLogo from "@/components/AgentLogo";
import PageTurnButton from "@/components/PageTurnButton";
import ScrollReveal from "@/components/ScrollReveal";

const features = [
  { name: "SSH 会话", icon: TerminalSquare, desc: "远程命令、批量任务和执行记录在一个地方。" },
  { name: "桌面模式", icon: MonitorCog, desc: "复杂现场切到可视化操作，不硬靠命令。" },
  { name: "SFTP 文件", icon: FolderUp, desc: "传文件、看配置、改脚本，不跳来跳去。" },
  { name: "快捷面板", icon: PanelsTopLeft, desc: "巡检、解释日志、生成笔记一键发起。" },
];

const events = [
  "prod-api-01 connected",
  "batch command queued",
  "db result linked",
  "note generated",
];

export default function DesktopSection() {
  return (
    <section id="desktop" className="relative flex h-[100svh] items-center overflow-hidden bg-[#f7f7f5] px-6 pb-16 pt-20 text-[#101010]">
      <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <ScrollReveal direction="right">
          <div className="overflow-hidden rounded-md border border-black/10 bg-white shadow-[0_28px_70px_rgba(16,16,16,0.12)]">
            <div className="flex items-center justify-between border-b border-black/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-[#101010]" />
                <span className="h-2.5 w-2.5 rounded-full bg-black/35" />
                <span className="h-2.5 w-2.5 rounded-full bg-black/14" />
              </div>
              <span className="font-mono text-xs text-black/[0.42]">Mona Desktop</span>
            </div>
            <div className="grid h-[430px] grid-cols-[64px_1fr]">
              <div className="border-r border-black/10 bg-[#f7f7f5] p-3">
                <div className="mb-4 h-10 w-10">
                  <AgentLogo state="working" className="h-full w-full" title="Mona" />
                </div>
                <div className="space-y-2.5">
                  {[TerminalSquare, Activity, ShieldCheck, FolderUp].map((Icon, index) => (
                    <div
                      key={index}
                      className={`flex h-9 w-9 items-center justify-center rounded-md border ${
                        index === 0
                          ? "border-[#101010] bg-white text-black"
                          : "border-black/10 text-black/[0.45]"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid grid-rows-[1fr_104px]">
                <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px]">
                  <div className="p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <p className="font-mono text-xs text-black/[0.38]">active session</p>
                        <h3 className="text-lg font-semibold text-[#101010]">prod-api 巡检</h3>
                      </div>
                      <span className="rounded-md border border-black/20 px-2.5 py-1 font-mono text-xs text-black/[0.68]">
                        live
                      </span>
                    </div>
                    <div className="space-y-1.5 rounded-md border border-black/10 bg-[#f7f7f5] p-3 font-mono text-xs">
                      <p className="truncate text-black/[0.76]">
                        <span className="text-black">$</span> uptime && df -h && tail -n 80 error.log
                      </p>
                      <p className="text-black/[0.46]">load average: 0.82, 0.91, 0.88</p>
                      <p className="text-black/[0.46]">/data 71% used, threshold ok</p>
                      <p className="font-semibold text-black/[0.72]">nginx error spike detected at 21:08</p>
                      <p className="text-black/[0.24]">_</p>
                    </div>
                  </div>
                  <div className="border-t border-black/10 p-4 lg:border-l lg:border-t-0">
                    <p className="mb-3 text-sm font-semibold text-[#101010]">Mona 建议</p>
                    <div className="space-y-2">
                      {["解释异常日志", "拉取相关配置", "整理成笔记"].map((item) => (
                        <button
                          key={item}
                          type="button"
                          className="w-full rounded-md border border-black/10 bg-[#f7f7f5] px-3 py-2 text-left text-xs text-black/[0.66] transition hover:border-black/[0.28] hover:text-black"
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="border-t border-black/10 p-4">
                  <p className="mb-2 font-mono text-xs text-black/[0.34]">timeline</p>
                  <div className="grid gap-2 md:grid-cols-4">
                    {events.map((event) => (
                      <div key={event} className="rounded-md border border-black/10 bg-[#f7f7f5] px-2 py-2 text-xs text-black/[0.52]">
                        {event}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </ScrollReveal>

        <div>
          <ScrollReveal>
            <p className="mb-3 font-mono text-sm uppercase text-black/[0.42]">Desktop Mode</p>
            <h2 className="text-4xl font-semibold leading-tight md:text-5xl">
              不只会聊，还能进现场。
            </h2>
            <p className="mt-5 text-base leading-7 text-black/[0.62] md:text-lg">
              Mona 的桌面端把终端、SSH、SFTP、快捷操作和 AI 面板放在一起。该自动时自动，该你确认时确认，该人工接管时也不用换工具。
            </p>
          </ScrollReveal>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {features.map((item, index) => (
              <ScrollReveal key={item.name} delay={index * 0.07}>
                <div className="flex h-full gap-3 rounded-md border border-black/10 bg-white/[0.62] p-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-black/10 bg-white text-black">
                    <item.icon className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="font-semibold">{item.name}</h3>
                    <p className="mt-1 text-sm leading-6 text-black/[0.56]">{item.desc}</p>
                  </div>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </div>
      <PageTurnButton href="#quickstart" label="进入下载屏" tone="light" />
    </section>
  );
}
