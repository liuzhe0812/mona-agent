import { useEffect, useState } from "react";
import { isRunActive, type DevRun } from "@/lib/development-api";
import { formatConversationWorkDuration } from "./zcode/conversationWorkDuration";

const durationIntl = { formatMessage: ({ id }: { id: string }) => ({ day: "天", hour: "小时", minute: "分", second: "秒" })[id.split(".").at(-1)!] ?? "" };

export function DevelopmentElapsed({ run }: { run?: DevRun }) {
  const [now, setNow] = useState(Date.now);
  const running = isRunActive(run) && run?.status !== "unknown";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.id, running]);
  if (!run) return null;
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : running ? now : NaN;
  const duration = Number.isFinite(start) && Number.isFinite(end) ? formatConversationWorkDuration(Math.max(0, end - start), durationIntl, "zh-CN") : null;
  const label = run.status === "interrupted" ? "已中断" : run.status === "failed" ? "执行失败" : run.status === "waiting_user" ? "等待确认" : run.status === "waiting_children" ? "等待子任务" : ["unknown", "recovering"].includes(run.status) ? "结果待核对" : running ? "工作中" : "已工作";
  return <span className="tabular-nums text-muted-foreground">{label}{duration ? ` ${duration}` : ""}</span>;
}
