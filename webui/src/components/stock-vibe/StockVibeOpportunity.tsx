import type { OpportunityMode } from "@/lib/stock-vibe-opportunity-api";
import type { StockVibeNativeResearchContext } from "./StockVibeNativeResearch";
import type { StockVibeLibraryStrategyDetail, StockVibeStrategyContext } from "@/lib/stock-vibe-strategy-library-api";
import { StockVibeStrategyLibrary } from "./StockVibeStrategyLibrary";
import "./stock-vibe-opportunity.css";

export interface StockVibeOpportunityProps {
  catalogRevision?: number;
  onSaveStrategy?: (context: StockVibeNativeResearchContext) => void;
  mode: OpportunityMode; symbols: string[]; enabled: boolean; modelAvailable: boolean;
  onAdd: (symbol: string) => void; onMarket: (symbol: string, context?: StockVibeNativeResearchContext) => void;
  onResearch: (symbol: string, context?: StockVibeNativeResearchContext) => void;
  onReuseStrategy?: (strategyId: string) => void;
  focusStrategyId?: string | null;
  onCreateStrategy?: () => void;
  onModifyStrategy?: (strategy: StockVibeLibraryStrategyDetail) => void;
  onStrategyMarket?: (symbol: string, context?: StockVibeStrategyContext) => void;
  onStrategyResearch?: (symbol: string, context?: StockVibeStrategyContext) => void;
  onOpenDataSettings?: () => void;
  onOpenWorkbench?: () => void;
  onOpenModel: () => void; onError: (message: string) => void;
}

export function StockVibeOpportunity(props: StockVibeOpportunityProps) {
  return <StockVibeStrategyLibrary symbols={props.symbols} enabled={props.enabled} mode={props.mode} catalogRevision={props.catalogRevision}
    focusStrategyId={props.focusStrategyId} onError={props.onError} onAdd={props.onAdd}
    onMarket={props.onStrategyMarket ?? ((symbol) => props.onMarket(symbol))} onResearch={props.onStrategyResearch ?? ((symbol) => props.onResearch(symbol))}
    onCreateStrategy={props.onCreateStrategy} onModifyStrategy={props.onModifyStrategy} onOpenDataSettings={props.onOpenDataSettings} onOpenWorkbench={props.onOpenWorkbench} />;
}
