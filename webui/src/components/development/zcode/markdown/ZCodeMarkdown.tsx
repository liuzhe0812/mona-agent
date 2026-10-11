import { cn } from "@/components/development/zcode/utils";
import { useThemeValue } from "@/hooks/useTheme";
import { MessageResponse } from "./MessageResponse";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "./lib/codePreviewSettings";
import { useZCodeMarkdownHost } from "./host";

export interface ZCodeMarkdownProps {
  children: string;
  streaming?: boolean;
  className?: string;
}

export function ZCodeMarkdown({ children, streaming = false, className }: ZCodeMarkdownProps) {
  const host = useZCodeMarkdownHost();
  const theme = useThemeValue();

  return (
    <MessageResponse
      className={cn("zcode-stream select-text", className)}
      renderZCodeFileCitations
      streaming={streaming}
      workspacePath={host.workspacePath}
      workspaceIdentity={host.workspaceIdentity}
      theme={theme}
      codePreviewSettings={DEFAULT_CODE_PREVIEW_SETTINGS}
      onOpenFileLink={host.onOpenFileLink}
      onOpenCodeViewer={host.onOpenCodeViewer}
      onOpenExternalUrl={host.onOpenExternalUrl}
    >
      {children}
    </MessageResponse>
  );
}
