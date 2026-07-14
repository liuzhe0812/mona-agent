export interface SystemAgentHandoffTask {
  id: string;
  title: string;
  action: string;
  target: string;
  arguments: Record<string, unknown>;
  error: string;
}

export function buildSystemAgentHandoffPrompt(task: SystemAgentHandoffTask): string {
  return [
    "系统维护固定操作失败。请直接接管并完成任务，而不是只说明步骤。",
    `操作：${task.action}`,
    `目标：${task.target}`,
    `参数：${JSON.stringify(task.arguments)}`,
    `错误：${task.error}`,
    "完成后复核实际状态，并如实报告执行结果。",
  ].join("\n");
}
