export interface TemplateVariable {
  token: string;
  label: string;
  description: string;
}

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  { token: "{{title}}", label: "标题", description: "新笔记的标题" },
  { token: "{{date}}", label: "日期", description: "当前日期 YYYY-MM-DD" },
  { token: "{{time}}", label: "时间", description: "当前时间 HH:mm" },
  { token: "{{datetime}}", label: "日期时间", description: "当前日期时间 YYYY-MM-DD HH:mm" },
  { token: "{{notebook}}", label: "笔记本", description: "目标笔记本名称" },
  { token: "{{year}}", label: "年", description: "当前年份" },
  { token: "{{month}}", label: "月", description: "当前月份 01-12" },
  { token: "{{day}}", label: "日", description: "当前日期 01-31" },
  { token: "{{weekday}}", label: "星期", description: "当前星期" },
];

export function formatWeekday(d: Date): string {
  const names = ["日", "一", "二", "三", "四", "五", "六"];
  return `星期${names[d.getDay()] ?? ""}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export interface TemplateContext {
  title: string;
  notebookName: string;
}

export function applyTemplate(content: string, ctx: TemplateContext): string {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const datetimeStr = `${dateStr} ${timeStr}`;

  return content
    .replace(/\{\{title\}\}/g, ctx.title)
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{time\}\}/g, timeStr)
    .replace(/\{\{datetime\}\}/g, datetimeStr)
    .replace(/\{\{notebook\}\}/g, ctx.notebookName)
    .replace(/\{\{year\}\}/g, String(now.getFullYear()))
    .replace(/\{\{month\}\}/g, pad2(now.getMonth() + 1))
    .replace(/\{\{day\}\}/g, pad2(now.getDate()))
    .replace(/\{\{weekday\}\}/g, formatWeekday(now));
}
