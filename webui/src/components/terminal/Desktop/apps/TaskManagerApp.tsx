import { useState, useEffect, useCallback, useRef } from "react";
import { Cpu, HardDrive, Activity, MemoryStick } from "lucide-react";
import {
  desktopGetSystemInfo,
  desktopGetProcesses,
  desktopExec,
} from "../../ipc";
import type { DesktopSystemInfo, DesktopProcess, DesktopDiskInfo } from "../../ipc";

interface TaskManagerAppProps {
  sessionId: string;
}

function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i];
}

function CircularProgress({
  value,
  color,
}: {
  value: number;
  color: string;
}) {
  const radius = 24;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (value / 100) * circumference;

  return (
    <div className="relative h-14 w-14">
      <svg className="h-full w-full -rotate-90">
        <circle
          cx="28"
          cy="28"
          r={radius}
          stroke="rgba(255,255,255,0.1)"
          strokeWidth="3"
          fill="none"
        />
        <circle
          cx="28"
          cy="28"
          r={radius}
          stroke={color}
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
          style={{
            strokeDasharray: circumference,
            strokeDashoffset,
            transition: "stroke-dashoffset 0.3s ease",
          }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-xs text-white/80">
        {value.toFixed(1)}%
      </div>
    </div>
  );
}

export function TaskManagerApp({ sessionId }: TaskManagerAppProps) {
  const [activeTab, setActiveTab] = useState<"process" | "performance">(
    "process",
  );
  const [systemInfo, setSystemInfo] = useState<DesktopSystemInfo | null>(null);
  const [processes, setProcesses] = useState<DesktopProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [info, procs] = await Promise.all([
        desktopGetSystemInfo(sessionId),
        desktopGetProcesses(sessionId),
      ]);
      setSystemInfo(info);
      setProcesses(procs);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadData();
    pollIntervalRef.current = setInterval(loadData, 3000);
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [loadData]);

  const handleKill = async (pid: number) => {
    try {
      await desktopExec(sessionId, `kill ${pid}`);
      loadData();
    } catch {}
  };

  if (loading || !systemInfo) {
    return (
      <div className="flex h-full items-center justify-center text-white/50">
        加载中...
      </div>
    );
  }

  const getStatusText = (state: string) => {
    switch (state) {
      case "R":
        return "运行中";
      case "S":
        return "睡眠中";
      case "I":
        return "空闲";
      case "Z":
        return "僵尸";
      case "T":
        return "已停止";
      default:
        return state;
    }
  };

  const getStatusColor = (state: string) => {
    switch (state) {
      case "R":
        return "text-green-400";
      case "S":
        return "text-yellow-400";
      case "I":
        return "text-blue-400";
      case "Z":
        return "text-purple-400";
      case "T":
        return "text-red-400";
      default:
        return "text-white/60";
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b border-white/5">
        <button
          onClick={() => setActiveTab("process")}
          className={`flex items-center gap-2 px-4 py-3 text-sm transition-colors ${
            activeTab === "process"
              ? "border-b-2 border-blue-400 text-blue-400"
              : "text-white/60 hover:text-white/80"
          }`}
        >
          <Activity className="h-4 w-4" />
          进程
        </button>
        <button
          onClick={() => setActiveTab("performance")}
          className={`flex items-center gap-2 px-4 py-3 text-sm transition-colors ${
            activeTab === "performance"
              ? "border-b-2 border-blue-400 text-blue-400"
              : "text-white/60 hover:text-white/80"
          }`}
        >
          <Cpu className="h-4 w-4" />
          性能
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        {activeTab === "process" ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center bg-white/5 px-4 py-2 text-sm text-white/60">
              <div className="flex-1">名称</div>
              <div className="w-20">PID</div>
              <div className="w-24">状态</div>
              <div className="w-20">CPU</div>
              <div className="w-20">内存</div>
              <div className="w-16" />
            </div>
            <div className="flex-1 overflow-auto">
              {processes.map((proc) => (
                <div
                  key={proc.pid}
                  className="flex items-center border-b border-white/5 px-4 py-2.5 text-sm hover:bg-white/5"
                >
                  <div className="flex-1 truncate pr-4 text-white/90">
                    {proc.name}
                  </div>
                  <div className="w-20 text-white/70">{proc.pid}</div>
                  <div className={`w-24 ${getStatusColor(proc.state)}`}>
                    {getStatusText(proc.state)}
                  </div>
                  <div className="w-20 text-white/70">
                    {proc.cpu.toFixed(1)}%
                  </div>
                  <div className="w-20 text-white/70">
                    {proc.mem.toFixed(1)}%
                  </div>
                  <div className="w-16">
                    <button
                      onClick={() => handleKill(proc.pid)}
                      className="rounded px-2 py-0.5 text-xs text-red-400 hover:bg-red-500/20"
                    >
                      Kill
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="h-full overflow-auto p-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-lg bg-white/5 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-blue-400" />
                  <span className="text-sm font-medium text-white/80">CPU</span>
                </div>
                <div className="text-xs text-white/50">使用率</div>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white">
                    {systemInfo.cpu.brand || "N/A"}
                  </span>
                  <CircularProgress value={systemInfo.cpu.load} color="#3b82f6" />
                </div>
              </div>

              <div className="rounded-lg bg-white/5 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <MemoryStick className="h-4 w-4 text-green-400" />
                  <span className="text-sm font-medium text-white/80">内存</span>
                </div>
                <div className="text-xs text-white/50">使用</div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-white">
                    {formatBytes(systemInfo.memory.used)}
                    <br />/ {formatBytes(systemInfo.memory.total)}
                  </span>
                  <CircularProgress
                    value={systemInfo.memory.used_percent}
                    color="#22c55e"
                  />
                </div>
              </div>

              {systemInfo.disk.map((disk: DesktopDiskInfo, i: number) => (
                <div key={i} className="rounded-lg bg-white/5 p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <HardDrive className="h-4 w-4 text-purple-400" />
                    <span className="text-sm font-medium text-white/80">
                      {disk.fs}
                    </span>
                  </div>
                  <div className="text-xs text-white/50">
                    {disk.mount} ({disk.type})
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white">
                      {formatBytes(disk.used)}/{formatBytes(disk.size)}
                    </span>
                    <CircularProgress
                      value={disk.use_percent}
                      color="#a855f7"
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4 text-sm lg:grid-cols-4">
              <div>
                <div className="text-white/50">CPU 速度</div>
                <div className="font-bold text-blue-400">
                  {systemInfo.cpu.speed} GHz
                </div>
              </div>
              <div>
                <div className="text-white/50">逻辑处理器</div>
                <div className="font-bold text-blue-400">
                  {systemInfo.cpu.cores}
                </div>
              </div>
              <div>
                <div className="text-white/50">物理核心</div>
                <div className="font-bold text-blue-400">
                  {systemInfo.cpu.physical_cores}
                </div>
              </div>
              <div>
                <div className="text-white/50">进程数</div>
                <div className="font-bold text-blue-400">
                  {systemInfo.processes.all}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
