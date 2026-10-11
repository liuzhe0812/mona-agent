import { LoaderCircle, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { DevSession } from "@/lib/development-api";
import { recentTasks, SubagentAvatar, SubagentLoadError, taskGroup, taskLabel, useSubagentTasks } from "./subagent-tasks";

export function DevelopmentCollaboration({ session, visible, onConfigure, onOpenTasks }: {
  session: DevSession; visible: boolean; onConfigure: () => void; onOpenTasks: () => void;
}) {
  const { records, error, retry } = useSubagentTasks(session.id, visible && !session.parentSessionId);
  if (session.parentSessionId) return null;
  const completed = recentTasks((records ?? []).filter((record) => taskGroup(record) === "completed"));
  const active = (records ?? []).filter((record) => taskGroup(record) === "active");
  const ended = (records ?? []).filter((record) => taskGroup(record) === "ended");
  const running = active.filter((record) => record.latestRun?.status === "running");
  const avatars = running.length ? running : active.length ? active : completed.length ? completed : ended;
  const label = running.length ? `${running.length} 个运行中` : active.length ? `${active.length} 已开启`
    : completed.length ? `${completed.length} 完成` : `${ended.length} 未完成`;
  const secondary = [active.length && completed.length && `${completed.length} 完成`,
    (active.length || completed.length) && ended.length && `${ended.length} 未完成`].filter(Boolean).join(" · ");
  return <TooltipProvider><section className="space-y-3" aria-label="开发子智能体">
    <div className="flex items-center justify-between gap-2"><h3 className="text-caption text-muted-foreground">子智能体</h3>
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" aria-label="子智能体配置" onClick={onConfigure}><Settings2 className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>子智能体配置</TooltipContent></Tooltip></div>
    <button type="button" aria-label="查看子智能体任务" onClick={onOpenTasks} className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-ui hover:bg-muted/50">
      {!records ? <span className="text-caption text-muted-foreground">{error ? "查看子任务" : <><LoaderCircle className="mr-2 inline h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />正在读取…</>}</span>
        : !records.length ? <span className="text-caption text-muted-foreground">暂无子任务</span>
        : <><span className="flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 items-center gap-1">{recentTasks(avatars).slice(0, 4).map((record) => <Tooltip key={record.id}><TooltipTrigger asChild><span role="img" aria-label={taskLabel(record)}><SubagentAvatar id={record.childSessionId} /></span></TooltipTrigger><TooltipContent>{taskLabel(record)}</TooltipContent></Tooltip>)}</span>
          <span className={active.length ? "truncate" : "truncate text-caption text-muted-foreground"}>{label}</span>
        </span>{secondary && <span className="shrink-0 text-caption text-muted-foreground">{secondary}</span>}</>}
    </button>
    <SubagentLoadError error={error} onRetry={retry} />
  </section></TooltipProvider>;
}
