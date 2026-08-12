export type SystemTab =
  | "overview"
  | "storage"
  | "software"
  | "startup"
  | "optimization"
  | "maintenance";

export interface SystemTabDefinition {
  id: SystemTab;
  label: string;
}

export const systemTabs: SystemTabDefinition[] = [
  { id: "overview", label: "概览" },
  { id: "storage", label: "存储空间" },
  { id: "software", label: "软件管理" },
  { id: "startup", label: "启动项" },
  { id: "optimization", label: "系统优化" },
  { id: "maintenance", label: "维护记录" },
];
