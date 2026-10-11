import { createContext, useContext } from "react";
import type { CodeViewerSource } from "./zcode/tools/codeViewer";
import type { DevCollaboration } from "@/lib/development-api";

export type StreamPreviewSource = Extract<CodeViewerSource, { type: "text" | "patch" | "multi-file-diff" }>;
export const DevelopmentStreamContext = createContext<{
  openCodeViewer: (source: CodeViewerSource) => void;
  openSubagent?: (childId: string) => void;
  subagents?: Partial<DevCollaboration>[];
} | null>(null);
export const useDevelopmentStreamContext = () => useContext(DevelopmentStreamContext);
