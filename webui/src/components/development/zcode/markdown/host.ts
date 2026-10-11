import { useCallback } from "react";
import { projectRelativePath, useMarkdownContext } from "@/components/markdown/MarkdownContext";
import type { MessageFileLinkTarget } from "./MessageResponse";
import { logger } from "./logger";
import { openExternalUrl } from "@/lib/tauri";
import { useDevelopmentStreamContext } from "../../DevelopmentStreamContext";
import { toast } from "./ui/toast";

export function useZCodeMarkdownHost() {
  const context = useMarkdownContext();
  const streamHost = useDevelopmentStreamContext();
  const onOpenFileLink = useCallback(
    async (target: MessageFileLinkTarget) => {
      if (!context?.openFile) return;
      try {
        await context.openFile(projectRelativePath(target.path, context.rootPath));
      } catch (error) {
        toast(error instanceof Error ? error.message : "无法打开文件。", { variant: "warning" });
        logger.warn("[ZCodeMarkdown] 打开 Markdown 文件失败", {
          path: target.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [context],
  );
  const onOpenExternalUrl = useCallback((url: string) => {
    void openExternalUrl(url).catch((error: unknown) => toast(error instanceof Error ? error.message : "无法打开链接。", { variant: "warning" }));
  }, []);

  return {
    workspacePath: context?.rootPath,
    workspaceIdentity: context?.projectId,
    onOpenFileLink: context?.openFile ? onOpenFileLink : undefined,
    onOpenCodeViewer: streamHost?.openCodeViewer,
    onOpenExternalUrl,
  };
}
