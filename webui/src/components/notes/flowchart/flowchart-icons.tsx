import type { LucideIcon } from "lucide-react";
import {
  Bot,
  CheckCircle2,
  Chrome,
  Cloud,
  Code2,
  Cpu,
  Database,
  FileText,
  Folder,
  Globe2,
  Lock,
  Mail,
  MessageSquare,
  Network,
  Search,
  Server,
  Settings,
  Smartphone,
  User,
  Users,
  TriangleAlert,
} from "lucide-react";

import type { FlowchartIconName } from "./flowchart-document";

const ICONS: Record<FlowchartIconName, LucideIcon> = {
  user: User,
  users: Users,
  browser: Chrome,
  mobile: Smartphone,
  server: Server,
  database: Database,
  file: FileText,
  folder: Folder,
  cloud: Cloud,
  network: Network,
  message: MessageSquare,
  mail: Mail,
  search: Search,
  lock: Lock,
  check: CheckCircle2,
  warning: TriangleAlert,
  settings: Settings,
  code: Code2,
  cpu: Cpu,
  ai: Bot,
};

export function FlowchartNodeIcon({ name }: { name: FlowchartIconName }) {
  const Icon = ICONS[name] ?? Globe2;
  return <Icon aria-hidden className="h-[1.15em] w-[1.15em] shrink-0" strokeWidth={1.8} />;
}
