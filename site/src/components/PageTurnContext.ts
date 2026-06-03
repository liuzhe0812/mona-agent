import { createContext, useContext } from "react";

export interface PageTurnContextValue {
  goToHref: (href: string) => void;
}

export const PageTurnContext = createContext<PageTurnContextValue | null>(null);

export function usePageTurn() {
  return useContext(PageTurnContext);
}
