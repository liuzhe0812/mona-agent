import type { ReactNode } from "react";
import {
  Activity,
  BookOpen,
  Cpu,
  FilePenLine,
  HardDrive,
  Monitor,
  PlugZap,
  RefreshCw,
  ScrollText,
  Server,
  ShieldCheck,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";

const connectionRows = [
  { label: "SSH prod-01", state: "connected", text: "已连接", tone: "bg-emerald-500" },
  { label: "RDP win-dev", state: "idle", text: "空闲", tone: "bg-amber-500" },
  { label: "Local Windows", state: "ready", text: "可用", tone: "bg-blue-500" },
];

const contextRows = [
  { label: "运维笔记.md", detail: "刚更新 2 分钟前" },
  { label: "知识库：登录故障", detail: "命中 3 条" },
  { label: "终端输出 42 行", detail: "Agent 可读取" },
];

const actionRows = [
  { label: "重连 SSH", icon: RefreshCw },
  { label: "打开 RDP", icon: Monitor },
  { label: "写入笔记", icon: FilePenLine },
  { label: "生成维护脚本", icon: ScrollText },
];

const windowsRows = [
  { label: "CPU", value: "18%", icon: Cpu },
  { label: "磁盘", value: "72%", icon: HardDrive },
  { label: "更新", value: "2 项", icon: Wrench },
  { label: "Defender", value: "正常", icon: ShieldCheck },
];

export function AgentWorkbench({ width = 320 }: { width?: number }) {
  return (
    <aside
      className="hidden h-full shrink-0 flex-col border-l border-border/75 bg-sidebar/70 xl:flex"
      style={{ width }}
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/65 px-4">
        <div>
          <h2 className="text-[13px] font-semibold text-foreground">AI 工作台</h2>
          <p className="text-[11px] text-muted-foreground">Agent 会把模块上下文放在这里</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/8 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          在线
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 scrollbar-thin">
        <WorkbenchSection
          icon={<Activity className="h-4 w-4 text-[#f25b8f]" />}
          title="当前任务"
        >
          <div className="rounded-lg border border-border/70 bg-background px-3 py-2.5">
            <div className="text-[12.5px] font-medium leading-5 text-foreground">
              排查 prod-01 登录失败并记录处理过程
            </div>
            <div className="mt-2 inline-flex items-center rounded-full bg-[#4f9de8]/10 px-2 py-1 text-[11px] font-medium text-[#2f7fca] dark:text-[#8bc8f3]">
              Agent 正在跟进
            </div>
          </div>
        </WorkbenchSection>

        <WorkbenchSection
          icon={<PlugZap className="h-4 w-4 text-[#4f9de8]" />}
          title="连接"
        >
          <div className="space-y-1">
            {connectionRows.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between rounded-lg px-2.5 py-2 text-[12px] hover:bg-background"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cn("h-1.5 w-1.5 rounded-full", row.tone)} />
                  <span className="truncate font-medium text-foreground/85">{row.label}</span>
                </span>
                <span className="shrink-0 text-muted-foreground">{row.text}</span>
              </div>
            ))}
          </div>
        </WorkbenchSection>

        <WorkbenchSection
          icon={<BookOpen className="h-4 w-4 text-[#a877e7]" />}
          title="上下文"
        >
          <div className="space-y-1">
            {contextRows.map((row) => (
              <button
                key={row.label}
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-background"
              >
                <span className="min-w-0 truncate text-[12px] font-medium text-foreground/85">
                  {row.label}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{row.detail}</span>
              </button>
            ))}
          </div>
        </WorkbenchSection>

        <WorkbenchSection
          icon={<Server className="h-4 w-4 text-[#53c59d]" />}
          title="可执行动作"
        >
          <div className="grid grid-cols-2 gap-2">
            {actionRows.map(({ label, icon: Icon }) => (
              <button
                key={label}
                type="button"
                className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border/70 bg-background px-2 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
              >
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>
        </WorkbenchSection>

        <WorkbenchSection
          icon={<Wrench className="h-4 w-4 text-[#eba45d]" />}
          title="Windows 状态"
        >
          <div className="grid grid-cols-2 gap-2">
            {windowsRows.map(({ label, value, icon: Icon }) => (
              <div
                key={label}
                className="rounded-lg border border-border/70 bg-background px-2.5 py-2"
              >
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" />
                  <span>{label}</span>
                </div>
                <div className="mt-1 text-[13px] font-semibold text-foreground">{value}</div>
              </div>
            ))}
          </div>
        </WorkbenchSection>
      </div>
    </aside>
  );
}

function WorkbenchSection({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-3 rounded-xl border border-border/70 bg-card/80 p-2.5 shadow-[0_8px_22px_rgba(15,23,42,0.035)]">
      <div className="mb-2 flex items-center gap-2 px-0.5">
        {icon}
        <h3 className="text-[12px] font-semibold text-foreground/88">{title}</h3>
      </div>
      {children}
    </section>
  );
}
