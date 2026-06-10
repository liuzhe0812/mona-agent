import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Download, ShieldCheck, Sparkles } from "lucide-react";
import AgentLogo from "@/components/AgentLogo";
import MagneticButton from "@/components/MagneticButton";
import OpsConsole from "@/components/OpsConsole";
import PageTurnButton from "@/components/PageTurnButton";
import ParticleNetwork from "@/components/ParticleNetwork";

const tags = ["极简 Agent", "白盒 SSH", "自然语言 SQL", "知识库闭环"];

export default function HeroSection() {
  const [logoState, setLogoState] = useState<"welcome" | "working">("welcome");

  useEffect(() => {
    const timer = window.setTimeout(() => setLogoState("working"), 2600);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <section id="hero" className="relative h-[100svh] overflow-hidden bg-[#f7f7f5] text-[#101010]">
      <ParticleNetwork mode="light" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_72%_18%,rgba(16,16,16,0.08),transparent_30%),linear-gradient(180deg,rgba(247,247,245,0.14),#f7f7f5_88%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(16,16,16,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(16,16,16,0.055)_1px,transparent_1px)] bg-[size:48px_48px] opacity-40" />

      <div className="relative z-10 mx-auto grid h-full max-w-7xl grid-cols-1 items-center gap-7 px-6 pb-16 pt-20 lg:grid-cols-[0.86fr_1.14fr] lg:pb-12">
        <div className="min-w-0">
          <motion.div
            className="mb-5 flex items-center gap-4"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: "easeOut" }}
          >
            <div className="h-16 w-16 shrink-0">
              <AgentLogo state={logoState} className="h-full w-full" title="Mona" />
            </div>
            <div>
              <div className="font-mono text-sm text-black/[0.45]">Mona Agent Ops</div>
              <div className="text-lg font-semibold">Mona 正在值守</div>
            </div>
          </motion.div>

          <motion.div
            className="mb-5 inline-flex items-center gap-2 rounded-md border border-black/10 bg-white/[0.62] px-3 py-2 text-sm text-black/[0.68]"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.08, ease: "easeOut" }}
          >
            <ShieldCheck className="h-4 w-4 text-black" />
            AI Agent 原生运维工具
          </motion.div>

          <motion.h1
            className="max-w-4xl text-5xl font-semibold leading-[1.04] text-[#101010] md:text-6xl xl:text-7xl"
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, delay: 0.14, ease: "easeOut" }}
          >
            mona 帮你搞定一切
          </motion.h1>

          <motion.p
            className="mt-5 max-w-2xl text-base leading-7 text-black/[0.66] md:text-lg"
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, delay: 0.22, ease: "easeOut" }}
          >
            不写工程级提示词，不把运维藏进黑盒。你说人话，Mona 规划、执行、展示每一步，把 SSH、数据库、笔记和 PPT 串成一条能复盘的工作流。
          </motion.p>

          <motion.div
            className="mt-6 flex flex-col gap-3 sm:flex-row"
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3, ease: "easeOut" }}
          >
            <MagneticButton
              href="https://mona.lzfun.vip/releases/Mona-latest.exe"
              className="inline-flex items-center justify-center gap-2 rounded-md border border-black bg-[#101010] px-5 py-3 text-sm font-semibold text-white transition hover:bg-white hover:text-black"
            >
              <Download className="h-4 w-4" />
              下载 Mona
            </MagneticButton>
            <MagneticButton
              href="#modules"
              className="inline-flex items-center justify-center gap-2 rounded-md border border-black/12 bg-white/[0.55] px-5 py-3 text-sm font-semibold text-black transition hover:border-black/28 hover:bg-white"
            >
              <Sparkles className="h-4 w-4" />
              看产品模块
            </MagneticButton>
          </motion.div>

          <motion.div
            className="mt-7 grid max-w-2xl grid-cols-2 gap-2 text-sm md:grid-cols-4"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.38, ease: "easeOut" }}
          >
            {tags.map((item) => (
              <div key={item} className="rounded-md border border-black/10 bg-white/[0.55] px-3 py-2.5 text-black/[0.68]">
                {item}
              </div>
            ))}
          </motion.div>
        </div>

        <motion.div
          className="hidden min-w-0 lg:block"
          initial={{ opacity: 0, x: 26 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, delay: 0.22, ease: "easeOut" }}
        >
          <OpsConsole compact />
        </motion.div>
      </div>

      <PageTurnButton href="#agent" label="进入下一屏" tone="light" />
    </section>
  );
}
