import { ArrowRight, Download, HardDrive } from "lucide-react";
import AgentLogo from "@/components/AgentLogo";
import PageTurnButton from "@/components/PageTurnButton";
import ScrollReveal from "@/components/ScrollReveal";

export default function QuickStartSection() {
  return (
    <section id="quickstart" className="relative flex h-[100svh] items-center overflow-hidden bg-white px-6 pb-16 pt-20 text-[#101010]">
      <div className="mx-auto max-w-5xl">
        <ScrollReveal>
          <div className="relative overflow-hidden rounded-md border border-black/10 bg-[#f7f7f5] p-7 shadow-[0_28px_70px_rgba(16,16,16,0.08)] md:p-10">
            <div className="absolute inset-0 bg-[linear-gradient(rgba(16,16,16,0.052)_1px,transparent_1px),linear-gradient(90deg,rgba(16,16,16,0.052)_1px,transparent_1px)] bg-[size:36px_36px] opacity-30" />
            <div className="relative grid gap-10 md:grid-cols-[1fr_180px] md:items-center">
              <div>
                <div className="mb-6 inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-black/[0.62]">
                  <HardDrive className="h-4 w-4 text-black" />
                  Mona Desktop
                </div>
                <h2 className="max-w-3xl text-4xl font-semibold leading-tight md:text-5xl">
                  下载 Mona，直接进运维现场。
                </h2>
                <p className="mt-5 max-w-2xl text-base leading-7 text-black/[0.62] md:text-lg">
                  Mona 面向真实团队的日常运维、排障、知识沉淀和汇报产出，把高频现场收进一个稳定、可复盘的工作台。
                </p>
                <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                  <a
                    href="/download"
                    className="inline-flex items-center justify-center gap-2 rounded-md border border-black bg-[#101010] px-5 py-3 text-sm font-semibold text-white transition hover:bg-white hover:text-black"
                  >
                    <Download className="h-4 w-4" />
                    下载 Mona
                  </a>
                  <a
                    href="#modules"
                    className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-5 py-3 text-sm font-semibold text-black transition hover:border-black/28"
                  >
                    再看一遍模块
                    <ArrowRight className="h-4 w-4" />
                  </a>
                </div>
                <p className="mt-8 font-mono text-xs text-black/[0.38]">
                  © 2026 Mona · AI Agent 原生运维工具
                </p>
              </div>
              <div className="mx-auto h-36 w-36 md:h-44 md:w-44">
                <AgentLogo state="welcome" className="h-full w-full" title="Mona" />
              </div>
            </div>
          </div>
        </ScrollReveal>
      </div>
      <PageTurnButton href="#" label="回到首页" tone="light" />
    </section>
  );
}
