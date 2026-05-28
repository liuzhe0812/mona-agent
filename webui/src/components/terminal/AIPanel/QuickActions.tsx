import { Activity, HardDrive, MemoryStick, CircleAlert, Network, ShieldAlert } from "lucide-react";

interface Props {
  onAction: (prompt: string) => void;
}

const QUICK_ACTIONS = [
  {
    id: "service",
    icon: Activity,
    label: "服务状态",
    prompt:
      "检查关键服务运行状态（docker, nginx, sshd, mysql 等），是否有服务崩溃或异常重启，查看 failed 单元",
  },
  {
    id: "disk",
    icon: HardDrive,
    label: "磁盘空间",
    prompt:
      "检查各分区使用率，找出占用空间最大的目录和大文件，预警即将满的分区",
  },
  {
    id: "memory",
    icon: MemoryStick,
    label: "内存占用",
    prompt:
      "查看内存和 swap 使用情况，列出内存占用最高的进程，判断是否有内存泄漏",
  },
  {
    id: "errors",
    icon: CircleAlert,
    label: "系统报错",
    prompt:
      "查看最近的系统错误日志（journalctl），重点关注 OOM killer、服务崩溃、内核错误等关键错误",
  },
  {
    id: "network",
    icon: Network,
    label: "端口与连接",
    prompt:
      "查看当前监听端口和活跃网络连接，发现异常监听或可疑外连",
  },
  {
    id: "login",
    icon: ShieldAlert,
    label: "登录审计",
    prompt:
      "检查最近的登录记录和失败登录尝试，排查暴力破解和异常来源 IP",
  },
];

export function QuickActions({ onAction }: Props) {
  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-medium text-muted-foreground">AI快捷功能</h3>
      <div className="grid grid-cols-2 gap-1">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.id}
            onClick={() => onAction(action.prompt)}
            className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground transition-colors"
          >
            <action.icon className="h-3 w-3 shrink-0" />
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
