import { useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import { useThemeValue } from "@/hooks/useTheme";
import { Button } from "./zcode/primitives/button";
import { CodeViewer } from "./zcode/markdown/ui/code-viewer";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "./zcode/markdown/lib/codePreviewSettings";
import { PatchFallbackContent } from "./zcode/preview/PatchFallbackContent";
import { DiffViewer } from "./zcode/preview/diff-viewer";
import type { StreamPreviewSource } from "./DevelopmentStreamContext";
import { useDevelopmentStore } from "./store";
import { ZCodeSurface } from "./zcode/Surface";

// Mona owns the right pane; the preview bodies are ZCode's original components.
export function DevelopmentStreamPreview({ source, sessionId }: { source: StreamPreviewSource; sessionId: string }) {
  const theme = useThemeValue();
  const resolvedTheme = theme;
  const settings = DEFAULT_CODE_PREVIEW_SETTINGS;
  const files = useMemo(() => source.type === "multi-file-diff" ? {
    oldFile: { name: source.path ?? source.title, contents: source.beforeContent,
      cacheKey: `old:${source.path ?? source.title}:${source.beforeContent.length}:${source.beforeContent.slice(0, 100)}:${source.beforeContent.slice(-100)}` },
    newFile: { name: source.path ?? source.title, contents: source.afterContent,
      cacheKey: `new:${source.path ?? source.title}:${source.afterContent.length}:${source.afterContent.slice(0, 100)}:${source.afterContent.slice(-100)}` },
  } : null, [source]);
  return <ZCodeSurface className="h-full min-h-0"><div className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
      <Button variant="ghost" size="icon-sm" aria-label="返回项目文件" onClick={() => useDevelopmentStore.getState().setStreamPreview(sessionId, null)}><ArrowLeft className="size-4" /></Button>
      <span className="min-w-0 truncate text-ui-base" title={source.title}>{source.title}</span>
    </header><div className="min-h-0 flex-1">
      {source.type === "patch" ? <PatchFallbackContent patch={source.patch} codePreviewSettings={settings} resolvedTheme={resolvedTheme} sourcePath={source.path} sourceTitle={source.title} />
        : files ? <DiffViewer oldFile={files.oldFile} newFile={files.newFile} diffClassName="block" fontSizePx={settings.fontSizePx} lightTheme={settings.lightTheme} darkTheme={settings.darkTheme} themeType={resolvedTheme} />
          : source.type === "text" ? <CodeViewer code={source.content} language={source.language} showLineNumbers={settings.showLineNumbers} wrapLongLines={settings.wrapLongLines} fontSizePx={settings.fontSizePx} theme={resolvedTheme === "dark" ? settings.darkTheme : settings.lightTheme} /> : null}
    </div>
  </div></ZCodeSurface>;
}
