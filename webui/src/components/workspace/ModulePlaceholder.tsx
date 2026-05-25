import {
  BookOpen,
  FileText,
  Monitor,
  Server,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type { WorkspaceTabId } from "@/components/workspace/AppTitleBar";

const MODULES: Record<WorkspaceTabId,
  {
    title: string;
    description: string;
    icon: LucideIcon;
    tone: string;
    chips: string[];
  }
> = {
  ssh: {
    title: "SSH 终端",
    description: "这里后续接 SSH 会话、命令输出和 Agent 工具调用。",
    icon: Server,
    tone: "text-[#4f9de8]",
    chips: ["prod-01", "命令历史", "Agent 可读"],
  },
  rdp: {
    title: "RDP 远程桌面",
    description: "这里后续接远程桌面画面、截图和维护动作。",
    icon: Monitor,
    tone: "text-[#53c59d]",
    chips: ["win-dev", "截图", "远程操作"],
  },
  note: {
    title: "运维笔记.md",
    description: "这里后续放笔记编辑器，Agent 可以读写处理记录。",
    icon: FileText,
    tone: "text-[#eba45d]",
    chips: ["Markdown", "处理过程", "自动整理"],
  },
  kb: {
    title: "知识库",
    description: "这里后续放检索结果、资料片段和引用来源。",
    icon: BookOpen,
    tone: "text-[#a877e7]",
    chips: ["登录故障", "命中片段", "引用来源"],
  },
  windows: {
    title: "Windows 维护",
    description: "这里后续接系统状态、更新、Defender 和维护脚本。",
    icon: Wrench,
    tone: "text-[#f25b8f]",
    chips: ["CPU", "磁盘", "更新", "脚本"],
  },
};

export function ModulePlaceholder({ tab }: { tab: WorkspaceTabId }) {
  const module = MODULES[tab];
  const Icon = module.icon;

  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background px-6">
      <div className="w-full max-w-lg rounded-2xl border border-border/70 bg-card p-6 text-center shadow-[0_18px_45px_rgba(15,23,42,0.06)]">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/70 bg-muted/45">
          <Icon className={`h-6 w-6 ${module.tone}`} />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight">{module.title}</h1>
        <p className="mx-auto mt-2 max-w-sm text-[13px] leading-6 text-muted-foreground">
          {module.description}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {module.chips.map((chip) => (
            <span
              key={chip}
              className="rounded-full border border-border/70 bg-background px-2.5 py-1 text-[11.5px] font-medium text-foreground/75"
            >
              {chip}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
