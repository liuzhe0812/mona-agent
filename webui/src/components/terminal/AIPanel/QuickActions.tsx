import { useState } from "react";
import {
  Heart,
  Search,
  Zap,
  FileText,
  CheckCircle,
  ShieldCheck,
} from "lucide-react";
import {
  HealthCheckConfig,
  FaultDiagnosisConfig,
  PerformanceConfig,
  LogAnalysisConfig,
  DeployVerifyConfig,
  SecurityAuditConfig,
} from "./ActionConfig";
import type { ActionConfirmResult } from "./ActionConfig";

interface Props {
  onAction: (result: ActionConfirmResult) => void;
}

type ActionId =
  | "health"
  | "fault"
  | "performance"
  | "log"
  | "deploy"
  | "security"
  | null;

const ACTIONS = [
  {
    id: "health" as const,
    icon: Heart,
    label: "健康巡检",
  },
  {
    id: "fault" as const,
    icon: Search,
    label: "故障诊断",
  },
  {
    id: "performance" as const,
    icon: Zap,
    label: "性能分析",
  },
  {
    id: "log" as const,
    icon: FileText,
    label: "日志分析",
  },
  {
    id: "deploy" as const,
    icon: CheckCircle,
    label: "部署验证",
  },
  {
    id: "security" as const,
    icon: ShieldCheck,
    label: "安全巡检",
  },
];

export function QuickActions({ onAction }: Props) {
  const [activeId, setActiveId] = useState<ActionId>(null);

  const handleCancel = () => setActiveId(null);
  const handleConfirm = (result: ActionConfirmResult) => {
    setActiveId(null);
    onAction(result);
  };

  if (activeId) {
    return (
      <div className="px-1 py-0.5">
        {activeId === "health" && (
          <HealthCheckConfig onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
        {activeId === "fault" && (
          <FaultDiagnosisConfig onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
        {activeId === "performance" && (
          <PerformanceConfig onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
        {activeId === "log" && (
          <LogAnalysisConfig onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
        {activeId === "deploy" && (
          <DeployVerifyConfig onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
        {activeId === "security" && (
          <SecurityAuditConfig onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-1.5">
      {ACTIONS.map((action) => (
        <button
          key={action.id}
          onClick={() => setActiveId(action.id)}
          className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground"
        >
          <action.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{action.label}</span>
        </button>
      ))}
    </div>
  );
}
