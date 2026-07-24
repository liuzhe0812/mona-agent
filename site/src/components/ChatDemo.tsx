import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  CheckCircle2,
  Database,
  FileText,
  Mail,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import AgentLogo from "@/components/AgentLogo";

type ScenarioKey = "mail" | "terminal" | "database" | "notes";

interface Turn {
  role: "user" | "agent";
  text: string;
}

interface Scenario {
  key: ScenarioKey;
  icon: LucideIcon;
  label: string;
  userPrompt: string;
  turns: Turn[];
  deliverable: { icon: LucideIcon; label: string };
  accent: string;
}

const scenarios: Scenario[] = [
  {
    key: "mail",
    icon: Mail,
    label: "邮件",
    userPrompt: "把这周客户邮件汇总一下，重点标出待回复的",
    turns: [
      { role: "user", text: "把这周客户邮件汇总一下，重点标出待回复的" },
      { role: "agent", text: "好，我先搜本周收件箱，按发件人和主题归类。" },
      { role: "agent", text: "找到 23 封，其中 4 封待回复。已生成汇总，需要我起草回复吗？" },
    ],
    deliverable: { icon: FileText, label: "本周邮件汇总.md" },
    accent: "#101010",
  },
  {
    key: "terminal",
    icon: TerminalSquare,
    label: "终端",
    userPrompt: "看下 prod-api 的磁盘和最近的 nginx 错误日志",
    turns: [
      { role: "user", text: "看下 prod-api 的磁盘和最近的 nginx 错误日志" },
      { role: "agent", text: "我先连上 prod-api，分两步查：磁盘占用 + error.log 尾部。" },
      { role: "agent", text: "磁盘 71%，error.log 12 分钟前有一波 502 spike，根因是上游超时。需要我清理日志并重启 nginx 吗？" },
    ],
    deliverable: { icon: FileText, label: "排障记录.md" },
    accent: "#101010",
  },
  {
    key: "database",
    icon: Database,
    label: "数据库",
    userPrompt: "查过去 24 小时支付失败最多的渠道，按原因分组",
    turns: [
      { role: "user", text: "查过去 24 小时支付失败最多的渠道，按原因分组" },
      { role: "agent", text: "我读懂你的意图，生成只读 SQL，执行前先给你看。" },
      { role: "agent", text: "扫了 18 万行，top 原因是 gateway_timeout 占 37.8%。完整 SQL 和结果已保存，需要做成图表吗？" },
    ],
    deliverable: { icon: FileText, label: "支付失败分析.md" },
    accent: "#101010",
  },
  {
    key: "notes",
    icon: Sparkles,
    label: "笔记",
    userPrompt: "把刚才的排障过程整理成笔记，提取知识点",
    turns: [
      { role: "user", text: "把刚才的排障过程整理成笔记，提取知识点" },
      { role: "agent", text: "我从刚才的会话提取事实，整理成 Markdown，并打上知识点标签。" },
      { role: "agent", text: "已生成笔记和 8 个知识点，关联了 SSH 和数据库两次会话，后续可直接调用。" },
    ],
    deliverable: { icon: FileText, label: "prod-api-nginx-spike.md" },
    accent: "#101010",
  },
];

interface ChatDemoProps {
  compact?: boolean;
}

export default function ChatDemo({ compact = false }: ChatDemoProps) {
  const [activeKey, setActiveKey] = useState<ScenarioKey>("mail");
  const [turnIndex, setTurnIndex] = useState(0);
  const active = useMemo(
    () => scenarios.find((s) => s.key === activeKey) ?? scenarios[0],
    [activeKey],
  );

  // 自动逐句播放对话
  useEffect(() => {
    setTurnIndex(0);
    const total = active.turns.length;
    if (total === 0) return;
    const timers: number[] = [];
    for (let i = 1; i < total; i++) {
      timers.push(window.setTimeout(() => setTurnIndex(i), i * 1600));
    }
    return () => timers.forEach(clearTimeout);
  }, [active]);

  const visibleTurns = active.turns.slice(0, turnIndex + 1);

  return (
    <div className="relative flex h-[520px] flex-col overflow-hidden rounded-lg border border-black/10 bg-white/[0.86] text-[#101010] shadow-[0_24px_80px_rgba(16,16,16,0.14)]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(16,16,16,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(16,16,16,0.045)_1px,transparent_1px)] bg-[size:28px_28px] opacity-40" />

      {/* 顶部：窗口栏 + Agent 状态 */}
      <div className="relative flex shrink-0 items-center justify-between border-b border-black/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[#101010]" />
          <span className="h-2.5 w-2.5 rounded-full bg-black/35" />
          <span className="h-2.5 w-2.5 rounded-full bg-black/14" />
          <span className="ml-3 font-mono text-xs text-black/[0.45]">
            Mona · 新会话
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-5 w-5">
            <AgentLogo state="working" className="h-full w-full" title="Mona" />
          </div>
          <span className="font-mono text-xs text-black/[0.55]">working</span>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col p-4">
        {/* 模块切换 */}
        <div className="mb-4 grid shrink-0 grid-cols-4 gap-2">
          {scenarios.map((item) => {
            const isActive = item.key === activeKey;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveKey(item.key)}
                className={`flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs transition ${
                  isActive
                    ? "border-black bg-[#101010] text-white"
                    : "border-black/10 bg-[#f7f7f5] text-black/[0.62] hover:text-black"
                }`}
              >
                <item.icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* 对话区 */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <AnimatePresence mode="wait">
            <motion.div
              key={active.key}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="space-y-3"
            >
              {visibleTurns.map((turn, i) => (
                <motion.div
                  key={`${active.key}-${i}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: "easeOut" }}
                  className={turn.role === "user" ? "flex justify-end" : "flex justify-start"}
                >
                  <div
                    className={`max-w-[82%] rounded-lg px-3.5 py-2.5 text-sm leading-6 ${
                      turn.role === "user"
                        ? "bg-[#101010] text-white"
                        : "border border-black/10 bg-[#f7f7f5] text-black/[0.82]"
                    }`}
                  >
                    {turn.text}
                  </div>
                </motion.div>
              ))}

              {/* 交付物 */}
              {turnIndex >= active.turns.length - 1 && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: 0.4 }}
                  className="flex items-center gap-2 rounded-md border border-black/12 bg-white px-3 py-2.5"
                >
                  <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: active.accent }} />
                  <span className="text-xs text-black/[0.55]">已交付</span>
                  <div className="flex items-center gap-1.5 rounded-md border border-black/10 bg-[#f7f7f5] px-2 py-1">
                    <active.deliverable.icon className="h-3.5 w-3.5 text-black/[0.62]" />
                    <span className="text-xs text-black/[0.72]">{active.deliverable.label}</span>
                  </div>
                  <ArrowRight className="ml-auto h-3.5 w-3.5 text-black/[0.32]" />
                </motion.div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* 底部输入框（静态展示） */}
        <div className="mt-4 flex shrink-0 items-center gap-2 rounded-md border border-black/10 bg-[#f7f7f5] px-3 py-2.5">
          <Sparkles className="h-3.5 w-3.5 text-black/[0.45]" />
          <span className="flex-1 truncate text-xs text-black/[0.42]">
            说一句话，Mona 帮你做完
          </span>
          <span className="rounded-md bg-[#101010] px-2 py-1 font-mono text-[10px] text-white">
            ⏎
          </span>
        </div>
      </div>
    </div>
  );
}
