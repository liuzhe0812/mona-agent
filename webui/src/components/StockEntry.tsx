import { lazy, Suspense } from "react";

import type { StockVibeNotificationTarget } from "@/components/stock-vibe/StockVibeSavedResearch";

const VibeStockView = lazy(() => import("@/components/stock-vibe/StockVibeView").then((module) => ({ default: module.StockVibeView })));

export interface StockEntryProps {
  autoRunSymbol?: string | null;
  onConsumeAutoRun?: () => void;
  onOpenSubscribe?: () => void;
  onOpenSettings?: () => void;
  notificationTarget?: StockVibeNotificationTarget | null;
  onConsumeNotification?: () => void;
}

export function StockEntry(props: StockEntryProps) {
  return <Suspense fallback={<p role="status" className="p-5 text-body text-muted-foreground">正在打开股票工作台…</p>}>
    <VibeStockView onOpenSettings={props.onOpenSettings} focusSymbol={props.autoRunSymbol} onConsumeFocusSymbol={props.onConsumeAutoRun}
      notificationTarget={props.notificationTarget} onConsumeNotification={props.onConsumeNotification} />
  </Suspense>;
}
