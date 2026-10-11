import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { DevSession } from "@/lib/development-api";
import { recentTasks, SubagentAvatar, SubagentLoadError, taskAge, taskElapsed, taskGroup, taskLabel, taskTime, useSubagentTasks } from "./subagent-tasks";

export function DevelopmentSubagentTasks({ session, visible, onSelect }: { session: DevSession; visible: boolean; onSelect: (childId: string) => void }) {
  const { records, error, retry } = useSubagentTasks(session.id, visible);
  const sorted = recentTasks(records ?? []);
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(Date.now);
  const hasActive = sorted.some((record) => taskGroup(record) === "active");
  useEffect(() => {
    if (!visible || !hasActive) return;
    setCurrentTime(Date.now());
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible, hasActive, session.id]);
  return <TooltipProvider><div aria-label="子智能体任务列表" className="scrollbar-thin h-full space-y-8 overflow-y-auto px-5 py-6">
    {!records ? <div className="text-caption text-muted-foreground">{error ? <Button variant="outline" size="sm" onClick={retry}>重新读取子任务</Button> : <span role="status"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin motion-reduce:animate-none" />正在读取…</span>}</div>
      : ([{ id: "active", label: "已开启" }, { id: "completed", label: "完成" }, { id: "ended", label: "未完成" }] as const).map((group) => {
        const tasks = sorted.filter((record) => taskGroup(record) === group.id);
        if (group.id === "ended" && !tasks.length) return null;
        const shown = group.id === "completed" && expandedFor !== session.id ? tasks.slice(0, 10) : tasks;
        return <section key={group.id} aria-label={`${group.label}的子任务`} className="space-y-3">
          <h3 className="text-caption text-muted-foreground">{group.label} · {tasks.length}</h3>
          {!tasks.length && <p className="text-caption text-muted-foreground">{group.id === "active" ? "没有进行中的子任务" : "暂无已完成任务"}</p>}
          <div className="-mx-2 space-y-1">
            {shown.map((record) => <button key={record.id} type="button" aria-label={taskLabel(record)} onClick={() => onSelect(record.childSessionId)} className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-muted/50">
              <SubagentAvatar id={record.childSessionId} className="h-6 w-6" />
              <Tooltip><TooltipTrigger asChild><span className="min-w-0 flex-1 truncate text-ui">{taskLabel(record)}</span></TooltipTrigger><TooltipContent className="max-w-sm break-words">{taskLabel(record)}</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><time dateTime={taskTime(record) || undefined} className="shrink-0 text-caption text-muted-foreground">{group.id === "active" ? taskElapsed(record, currentTime) : taskAge(record)}</time></TooltipTrigger><TooltipContent>{taskTime(record) ? new Date(taskTime(record)).toLocaleString() : ""}</TooltipContent></Tooltip>
            </button>)}
          </div>
          {shown.length < tasks.length && <Button variant="ghost" className="ml-9 h-8 justify-start px-0 text-ui text-muted-foreground" onClick={() => setExpandedFor(session.id)}>再显示 {tasks.length - shown.length} 个</Button>}
        </section>;
      })}
    <SubagentLoadError error={visible ? error : ""} onRetry={retry} />
  </div></TooltipProvider>;
}
