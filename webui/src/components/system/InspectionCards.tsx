import { AlertTriangle, CheckCircle2, Clock3, HardDrive, RefreshCw, Rocket } from "lucide-react";

import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import type { InspectionCard } from "./inspectionModel";

const CARD_ICONS: Record<string, typeof AlertTriangle> = {
  diagnostic: AlertTriangle,
  storage: HardDrive,
  software: RefreshCw,
  startup: Rocket,
  boot: Clock3,
  maintenance: CheckCircle2,
  maintained: CheckCircle2,
};

const TONE_CLASSES: Record<InspectionCard["tone"], string> = {
  warning: "bg-warning/10 text-warning",
  info: "bg-info/10 text-info",
  success: "bg-success/10 text-success",
};

function cardIcon(id: string): typeof AlertTriangle {
  const type = id.split(":", 1)[0];
  return CARD_ICONS[type] ?? AlertTriangle;
}

interface InspectionCardsProps {
  cards: InspectionCard[];
  /** 数据源仍在首次加载中时展示骨架 */
  pending: boolean;
  /** 点击卡片动作：goal 非空时交给 planner，否则跳转对应 Tab */
  onAction: (card: InspectionCard) => void;
  disabled?: boolean;
}

export function InspectionCards({ cards, pending, onAction, disabled = false }: InspectionCardsProps) {
  if (pending && cards.length === 0) {
    return (
      <div className="space-y-2" aria-label="巡检数据加载中">
        {[0, 1].map((index) => (
          <div key={index} className="h-[88px] animate-pulse rounded-lg bg-muted/40" />
        ))}
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-border/60 p-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckCircle2 className="h-4 w-4" />
        </span>
        <p className="text-caption text-muted-foreground">系统状态良好，暂无需要处理的事项。</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-caption font-medium text-muted-foreground">巡检发现</p>
      {cards.map((card) => {
        const Icon = cardIcon(card.id);
        return (
          <div key={card.id} data-testid={`inspection-card-${card.id}`} className="rounded-lg border border-border/60 p-3">
            <div className="flex items-start gap-2.5">
              <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", TONE_CLASSES[card.tone])}>
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-ui font-medium">{card.title}</p>
                  <span className="shrink-0 text-body font-semibold">{card.metric}</span>
                </div>
                <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">{card.detail}</p>
              </div>
            </div>
            <div className="mt-2.5 flex justify-end">
              <Button type="button" size="sm" variant="interaction" disabled={disabled} onClick={() => onAction(card)}>
                {card.actionLabel ?? "查看"}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
