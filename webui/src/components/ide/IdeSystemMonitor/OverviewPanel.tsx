import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cpu,
  HardDrive,
  Wifi,
  Activity,
  Zap,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ideRemoteGetSystemInfo } from "@/components/terminal/ipc";
import type { RemoteSystemInfo } from "@/components/terminal/types/terminal";

const POLL_INTERVAL_MS = 2000;
const HISTORY_LENGTH = 30;

interface Props {
  sessionId: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(1)} ${units[exp]}`;
}

function Sparkline({
  data,
  color,
  maxValue,
}: {
  data: number[];
  color: string;
  maxValue?: number;
}) {
  const displayMax = maxValue || Math.max(...data, 10);
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * 100;
      const y = 100 - (v / displayMax) * 100;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg className="h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
      {[0, 25, 50, 75, 100].map((tick) => (
        <line
          key={tick}
          x1="0"
          y1={100 - tick}
          x2="100"
          y2={100 - tick}
          stroke="rgba(255,255,255,0.05)"
          strokeWidth="1"
        />
      ))}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function OverviewPanel({ sessionId }: Props) {
  const [systemData, setSystemData] = useState<RemoteSystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDisk, setSelectedDisk] = useState<string>("");
  const [selectedNetwork, setSelectedNetwork] = useState<string>("");

  const historyRef = useRef({
    cpu: Array(HISTORY_LENGTH).fill(0),
    memory: Array(HISTORY_LENGTH).fill(0),
    diskIO: {} as Record<string, number[]>,
    networkRx: {} as Record<string, number[]>,
    networkTx: {} as Record<string, number[]>,
  });
  const [history, setHistory] = useState(historyRef.current);

  const loadData = useCallback(async () => {
    try {
      const data = await ideRemoteGetSystemInfo(sessionId);
      setSystemData(data);
      setError(null);

      historyRef.current = {
        cpu: [...historyRef.current.cpu.slice(1), data.cpu.load],
        memory: [...historyRef.current.memory.slice(1), data.memory.usedPercent],
        diskIO: { ...historyRef.current.diskIO },
        networkRx: { ...historyRef.current.networkRx },
        networkTx: { ...historyRef.current.networkTx },
      };

      data.disk.forEach((disk) => {
        historyRef.current.diskIO[disk.fs] = [
          ...(historyRef.current.diskIO[disk.fs] ||
            Array(HISTORY_LENGTH).fill(0)).slice(1),
          disk.busyPercent,
        ];
      });

      data.network.forEach((net) => {
        historyRef.current.networkRx[net.iface] = [
          ...(historyRef.current.networkRx[net.iface] ||
            Array(HISTORY_LENGTH).fill(0)).slice(1),
          net.rxSec,
        ];
        historyRef.current.networkTx[net.iface] = [
          ...(historyRef.current.networkTx[net.iface] ||
            Array(HISTORY_LENGTH).fill(0)).slice(1),
          net.txSec,
        ];
      });

      setHistory(historyRef.current);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval>;

    const tick = async () => {
      if (!active) return;
      await loadData();
    };

    tick();
    timer = setInterval(tick, POLL_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [loadData]);

  useEffect(() => {
    if (systemData?.disk.length && !selectedDisk) {
      setSelectedDisk(systemData.disk[0].fs);
    }
    if (systemData?.network.length && !selectedNetwork) {
      setSelectedNetwork(systemData.network[0].iface);
    }
  }, [systemData, selectedDisk, selectedNetwork]);

  if (loading && !systemData) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        <span className="text-caption">加载中...</span>
      </div>
    );
  }

  if (error && !systemData) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-caption text-destructive">
        {error}
      </div>
    );
  }

  if (!systemData) return null;

  const selectedDiskData =
    systemData.disk.find((d) => d.fs === selectedDisk) || systemData.disk[0];
  const selectedNetworkData =
    systemData.network.find((n) => n.iface === selectedNetwork) ||
    systemData.network[0];

  const networkMax = Math.max(
    ...(history.networkRx[selectedNetworkData?.iface] || [0]),
    ...(history.networkTx[selectedNetworkData?.iface] || [0]),
    1024,
  );

  return (
    <ScrollArea className="h-full">
      {/* 卡片图标色与 Sparkline 曲线色为数据可视化系列色（design §4.5 例外），同一指标保持同色 */}
      <div className="space-y-2 p-2">
        {/* CPU */}
        <div className="rounded-lg border bg-card p-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5 text-blue-500" />
              <span className="text-caption">CPU</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-body font-semibold">
                {systemData.cpu.load.toFixed(1)}%
              </span>
              <span className="text-micro text-muted-foreground">
                {systemData.cpu.cores}核
              </span>
            </div>
          </div>
          <div className="mt-1 h-10">
            <Sparkline data={history.cpu} color="#3b82f6" maxValue={100} />
          </div>
          <div className="mt-1 truncate text-micro text-muted-foreground">
            {systemData.cpu.brand}
          </div>
        </div>

        {/* Memory */}
        <div className="rounded-lg border bg-card p-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5 text-green-500" />
              <span className="text-caption">内存</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-body font-semibold">
                {systemData.memory.usedPercent.toFixed(1)}%
              </span>
              <span className="text-micro text-muted-foreground">
                {formatBytes(systemData.memory.used)}
              </span>
            </div>
          </div>
          <div className="mt-1 h-10">
            <Sparkline data={history.memory} color="#22c55e" maxValue={100} />
          </div>
          <div className="mt-1 text-micro text-muted-foreground">
            共 {formatBytes(systemData.memory.total)}
          </div>
        </div>

        {/* Disk */}
        <div className="rounded-lg border bg-card p-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <HardDrive className="h-3.5 w-3.5 text-purple-500" />
              {systemData.disk.length > 1 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1 text-caption font-normal"
                    >
                      {selectedDiskData?.fs}
                      <ChevronDown className="ml-1 h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {systemData.disk.map((d) => (
                      <DropdownMenuItem
                        key={d.fs}
                        onClick={() => setSelectedDisk(d.fs)}
                      >
                        {d.fs}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span className="text-caption">{selectedDiskData?.fs}</span>
              )}
            </div>
            <span className="text-body font-semibold">
              {(selectedDiskData?.busyPercent || 0).toFixed(1)}%
            </span>
          </div>
          <div className="mt-1 h-10">
            <Sparkline
              data={
                history.diskIO[selectedDiskData?.fs] ||
                Array(HISTORY_LENGTH).fill(0)
              }
              color="#a855f7"
              maxValue={100}
            />
          </div>
          <div className="mt-1 flex gap-2 text-micro text-muted-foreground">
            <span>读 {formatBytes(selectedDiskData?.rIoSec || 0)}/s</span>
            <span>写 {formatBytes(selectedDiskData?.wIoSec || 0)}/s</span>
          </div>
        </div>

        {/* Network */}
        <div className="rounded-lg border bg-card p-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Wifi className="h-3.5 w-3.5 text-orange-500" />
              {systemData.network.length > 1 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1 text-caption font-normal"
                    >
                      {selectedNetworkData?.iface}
                      <ChevronDown className="ml-1 h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {systemData.network.map((n) => (
                      <DropdownMenuItem
                        key={n.iface}
                        onClick={() => setSelectedNetwork(n.iface)}
                      >
                        {n.iface}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span className="text-caption">{selectedNetworkData?.iface}</span>
              )}
            </div>
            <span className="text-body font-semibold">
              {formatBytes(
                (selectedNetworkData?.rxSec || 0) +
                  (selectedNetworkData?.txSec || 0),
              )}
              /s
            </span>
          </div>
          <div className="mt-1 h-10">
            <Sparkline
              data={
                history.networkRx[selectedNetworkData?.iface] ||
                Array(HISTORY_LENGTH).fill(0)
              }
              color="#f97316"
              maxValue={networkMax}
            />
          </div>
          <div className="mt-1 flex gap-2 text-micro text-muted-foreground">
            <span>↓ {formatBytes(selectedNetworkData?.rxSec || 0)}/s</span>
            <span>↑ {formatBytes(selectedNetworkData?.txSec || 0)}/s</span>
          </div>
        </div>

        {/* Load */}
        <div className="rounded-lg border bg-card p-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-yellow-500" />
              <span className="text-caption">负载</span>
            </div>
            <span className="text-body font-semibold">
              {systemData.cpu.load.toFixed(2)}
            </span>
          </div>
          <div className="mt-1 h-10">
            <Sparkline
              data={history.cpu}
              color="#eab308"
              maxValue={Math.max(
                systemData.cpu.load,
                systemData.cpu.cores,
                1,
              )}
            />
          </div>
          <div className="mt-1 text-micro text-muted-foreground">
            1m:{systemData.cpu.load1.toFixed(2)} 5m:
            {systemData.cpu.load5.toFixed(2)} 15m:
            {systemData.cpu.load15.toFixed(2)}
          </div>
        </div>

        {/* Processes */}
        <div className="rounded-lg border bg-card p-2">
          <div className="flex items-center justify-between text-caption">
            <span>进程</span>
            <span className="font-semibold">
              {systemData.processes.all} / {systemData.processes.running} 运行中
            </span>
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
