export type SystemTab =
  | "overview"
  | "storage"
  | "software"
  | "startup"
  | "optimization"
  | "network"
  | "advanced"
  | "tools"
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
  { id: "network", label: "网络" },
  { id: "advanced", label: "高级优化" },
  { id: "tools", label: "系统工具" },
  { id: "maintenance", label: "维护记录" },
];

