import { createContext } from "react";
import type { PreviewScope } from "./filePreviewStore";

export interface ConversationFileAccess {
  sessionKey: string;
  scope: PreviewScope;
  download: (path: string) => Promise<void>;
  onError: (error: unknown) => void;
}

export const ConversationFileContext = createContext<ConversationFileAccess | null>(null);
