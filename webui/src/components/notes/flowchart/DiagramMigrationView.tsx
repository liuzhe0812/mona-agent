/**
 * 旧版 diagram 文件迁移引导视图。
 *
 * 规范（见 FLOWCHART_DEVELOPMENT_PLAN.md §10.3 路径 B）：
 * 1. 打开旧图时显示迁移提示，先预览可迁移/不支持摘要；
 * 2. 用户确认后创建新的 flowchart 副本，原 diagram 文件保留并追加"旧版备份"；
 * 3. 存在不支持元素时整体不可迁移，只展示原因，不生成部分结果；
 * 4. 迁移本身不修改原文件内容，只改标题。
 */

import { useMemo, useState } from "react";
import { FileWarning, GitFork, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { OperationNote } from "../notes-data";
import { nowTimestamp } from "../notes-data";
import { createNoteId } from "../notes-storage";
import { parseDiagramMarkdown } from "./diagram-legacy/diagram-serializer";
import { serializeFlowchartMarkdown } from "./flowchart-document";
import { convertDiagramToFlowchart } from "./diagram-to-flowchart";

interface DiagramMigrationViewProps {
  note: OperationNote;
  /** 迁移确认：传入新流程图笔记与标题追加"旧版备份"的旧笔记。 */
  onMigrate: (newNote: OperationNote, updatedOldNote: OperationNote) => void;
}

type PreviewState =
  | { kind: "parse-error"; message: string }
  | { kind: "unsupported"; reasons: string[] }
  | {
      kind: "migratable";
      nodeCount: number;
      edgeCount: number;
      warnings: string[];
      markdown: string;
    };

export function DiagramMigrationView({ note, onMigrate }: DiagramMigrationViewProps) {
  const [migrating, setMigrating] = useState(false);

  const preview = useMemo<PreviewState>(() => {
    const parsed = parseDiagramMarkdown(note.contentMarkdown);
    if (!parsed.ok) return { kind: "parse-error", message: parsed.message };
    const converted = convertDiagramToFlowchart(parsed.document);
    if (!converted.ok) return { kind: "unsupported", reasons: converted.reasons };
    return {
      kind: "migratable",
      nodeCount: converted.document.nodes.length,
      edgeCount: converted.document.edges.length,
      warnings: converted.warnings,
      markdown: serializeFlowchartMarkdown(note.title, converted.document),
    };
  }, [note.contentMarkdown, note.title]);

  const handleMigrate = () => {
    if (preview.kind !== "migratable" || migrating) return;
    setMigrating(true);
    const now = nowTimestamp();
    // 新笔记不继承旧文件的 contentJson/plainText/AI 会话，由流程图编辑器重新生成
    const newNote: OperationNote = {
      ...note,
      id: createNoteId(),
      title: note.title,
      preview: "流程图",
      contentMarkdown: preview.markdown,
      contentJson: undefined,
      plainText: undefined,
      agentChatId: undefined,
      createdAt: now,
      updatedAt: now,
      appliedAgentMessageIds: [],
      type: "flowchart",
    };
    const alreadyMarked = note.title.includes("旧版备份");
    const updatedOldNote: OperationNote = {
      ...note,
      title: alreadyMarked ? note.title : `${note.title}（旧版备份）`,
      updatedAt: now,
    };
    onMigrate(newNote, updatedOldNote);
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 p-8">
      <div className="flex w-full max-w-[420px] flex-col items-center gap-4 rounded-2xl border border-border/60 bg-background p-8 shadow-sm">
        {preview.kind === "migratable" ? (
          <GitFork className="h-8 w-8 text-muted-foreground" />
        ) : (
          <FileWarning className="h-8 w-8 text-muted-foreground" />
        )}
        <div className="text-center">
          <div className="text-[14px] font-medium">旧版图表文件</div>
          <div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            该文件使用已下线的旧版图表格式。迁移后会创建一个新的流程图副本，原文件保留为备份，不会丢失内容。
          </div>
        </div>

        {preview.kind === "parse-error" && (
          <div className="w-full rounded-lg bg-muted/50 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
            文件解析失败：{preview.message}
          </div>
        )}

        {preview.kind === "unsupported" && (
          <div className="w-full rounded-lg bg-muted/50 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
            <div className="mb-1 font-medium text-foreground">该文件包含暂不支持迁移的内容：</div>
            <ul className="list-inside list-disc space-y-0.5">
              {preview.reasons.slice(0, 6).map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
              {preview.reasons.length > 6 && (
                <li>…共 {preview.reasons.length} 项</li>
              )}
            </ul>
            <div className="mt-2">请手动重绘为流程图，原文件可继续以 Markdown 形式查看。</div>
          </div>
        )}

        {preview.kind === "migratable" && (
          <>
            <div className="w-full rounded-lg bg-muted/50 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
              <div>
                可迁移内容：{preview.nodeCount} 个图形、{preview.edgeCount} 条连接
              </div>
              {preview.warnings.length > 0 && (
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {preview.warnings.slice(0, 5).map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                  {preview.warnings.length > 5 && (
                    <li>…共 {preview.warnings.length} 条提示</li>
                  )}
                </ul>
              )}
            </div>
            <Button onClick={handleMigrate} disabled={migrating} className="w-full">
              {migrating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              迁移为流程图
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
