import { createContext } from "react";

export const ConversationBrowserContext = createContext<((url: string) => void) | null>(null);
