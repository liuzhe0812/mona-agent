import { MarkdownEditor, type EditorMode } from "@/components/common/MarkdownEditor";

import type { MdFileTab } from "./mdReaderStore";

interface MdFileEditorProps {
  tab: MdFileTab;
  onContentChange: (content: string) => void;
  onModeChange: (mode: EditorMode) => void;
}

export function MdFileEditor({ tab, onContentChange, onModeChange }: MdFileEditorProps) {
  if (tab.loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-ui text-muted-foreground">
        正在加载 {tab.fileName}...
      </div>
    );
  }

  if (tab.error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <p className="text-body font-medium text-destructive">加载失败</p>
        <p className="text-caption text-muted-foreground">{tab.error}</p>
      </div>
    );
  }

  return (
    <MarkdownEditor
      content={tab.content}
      mode={tab.mode}
      onModeChange={onModeChange}
      onContentChange={(next) => onContentChange(next.contentMarkdown)}
      placeholder="Markdown 文档内容..."
      showStats
      enableSelectionAi
      getNoteTitle={() => tab.fileName}
      statsExtra={
        tab.dirty ? (
          <span className="text-warning">未保存</span>
        ) : (
          <span>已保存</span>
        )
      }
      className="min-h-0 flex-1"
    />
  );
}
