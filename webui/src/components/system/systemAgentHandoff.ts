export interface SystemAgentHandoffTask {
  id: string;
  title: string;
  action: string;
  target: string;
  arguments: Record<string, unknown>;
  error: string;
}

export function buildSystemAgentHandoffPrompt(task: SystemAgentHandoffTask): string {
  if (task.action === "配置建议") {
    const args = task.arguments as {
      itemId?: string;
      itemTitle?: string;
      status?: string;
      risk?: string;
      impact?: string;
      currentValue?: string;
    };
    return [
      "用户正在查看一项 Windows 系统设置，不确定是否应该启用，请基于以下信息提供是否启用的建议。",
      `设置名称：${args.itemTitle ?? task.target}`,
      `设置 ID：${args.itemId ?? task.target}`,
      `当前状态：${args.status ?? "未知"}`,
      `风险等级：${args.risk ?? "未知"}`,
      `功能影响：${args.impact ?? "未提供"}`,
      `当前值：${args.currentValue ?? "未提供"}`,
      "",
      "请按以下结构回答：",
      "1. 一句话结论（建议启用 / 建议不启用 / 视场景而定）",
      "2. 简要说明这个设置做什么、启用后有什么影响",
      "3. 针对常见使用场景（笔记本/台式机/游戏玩家/办公/开发等）给出差异化建议",
      "4. 如果是高风险项，明确提示风险点",
      "",
      "注意：你只提供建议，不要尝试执行任何系统修改操作。用户会自行决定是否启用。",
    ].join("\n");
  }

  const startupStateOnly = task.action === "禁用启动项" || task.action === "恢复启动项";
  return [
    "系统维护固定操作失败。请直接接管并完成任务，而不是只说明步骤。",
    `操作：${task.action}`,
    `目标：${task.target}`,
    `参数：${JSON.stringify(task.arguments)}`,
    `错误：${task.error}`,
    ...(startupStateOnly ? [
      "启动项安全边界：只允许切换现有启动项的启用状态。",
      "不得删除注册表 Run 值、快捷方式或计划任务；不得卸载软件、删除文件或结束进程。",
      "不得以删除代替禁用；若无法安全切换则停止并说明原因。",
      "禁用后保留原启动项，可通过 enabled=true 恢复；操作后重新读取状态验证。",
    ] : []),
    "完成后复核实际状态，并如实报告执行结果。",
  ].join("\n");
}
