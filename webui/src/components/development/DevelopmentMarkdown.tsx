import { useMemo, type ReactNode } from "react";
import { MarkdownContext, projectRelativePath } from "@/components/markdown/MarkdownContext";
import { developmentApi, type DevProject } from "@/lib/development-api";
import { fileKey, useDevelopmentStore } from "./store";
import { DevelopmentStreamContext } from "./DevelopmentStreamContext";
import type { CodeViewerSource } from "./zcode/tools/codeViewer";
import { toast } from "./zcode/markdown/ui/toast";

export function DevelopmentMarkdown({ project, sessionId, children }: {
  project?: DevProject; sessionId: string | null; children: ReactNode;
}) {
  const context = useMemo(() => ({
    projectId: project?.id,
    rootPath: project?.rootPath,
    readMedia: project ? (path: string) => developmentApi.media(project.id, path) : undefined,
    openFile: project && sessionId ? async (path: string) => {
      if (!useDevelopmentStore.getState().files[fileKey(sessionId, path)]) {
        const file = await developmentApi.file(project.id, path);
        if (!useDevelopmentStore.getState().files[fileKey(sessionId, path)]) useDevelopmentStore.getState().loadFile(sessionId, file);
      }
      useDevelopmentStore.setState((state) => ({ selectedFiles: { ...state.selectedFiles, [sessionId]: path } }));
      useDevelopmentStore.getState().setStreamPreview(sessionId, null);
      useDevelopmentStore.getState().setSide(sessionId, { tab: "workspace", expanded: true });
    } : undefined,
  }), [project?.id, project?.rootPath, sessionId]);
  const streamHost = useMemo(() => project && sessionId ? {
    openSubagent: (childId: string) => useDevelopmentStore.getState().setSide(sessionId, { tab: "agent", expanded: true, agentSessionId: childId }),
    openCodeViewer: (source: CodeViewerSource) => {
      if (source.type === "patch" || source.type === "multi-file-diff" || source.type === "text") {
        useDevelopmentStore.getState().setStreamPreview(sessionId, source);
        useDevelopmentStore.getState().setSide(sessionId, { tab: "workspace", expanded: true });
        return;
      }
      void (async () => {
        try { await context.openFile?.(projectRelativePath(source.path, project.rootPath)); }
        catch (cause) { toast(cause instanceof Error ? cause.message : "无法打开预览。", { variant: "warning" }); }
      })();
    },
  } : null, [project, sessionId, context]);
  return <MarkdownContext.Provider value={context}><DevelopmentStreamContext.Provider value={streamHost}>{children}</DevelopmentStreamContext.Provider></MarkdownContext.Provider>;
}
