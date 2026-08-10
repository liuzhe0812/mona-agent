import { useState } from "react";
import { Check, Copy, ClipboardPaste, Replace, FileText, Play } from "lucide-react";
import type { DbSqlDraft, DbAiOperationClass } from "./types";

interface Props {
  draft: DbSqlDraft;
  onInsert: (sql: string) => void;
  onReplace: (sql: string) => void;
  onDismiss: () => void;
  /** Optional: run a read-only SQL via the editor. */
  onRun?: (sql: string) => void;
}

const OP_CLASS_LABEL: Record<DbAiOperationClass, string> = {
  read: "只读",
  transactional_dml: "可回滚变更",
  non_transactional_change: "高风险草稿",
  blocked: "已阻断",
};

const OP_CLASS_STYLE: Record<DbAiOperationClass, string> = {
  read: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  transactional_dml:
    "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  non_transactional_change:
    "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  blocked:
    "border-zinc-500/40 bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
};

export function SqlResultCard({ draft, onInsert, onReplace, onDismiss, onRun }: Props) {
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState<"insert" | "replace" | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(draft.sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const handleInsert = () => {
    onInsert(draft.sql);
    setApplied("insert");
    setTimeout(onDismiss, 800);
  };

  const handleReplace = () => {
    onReplace(draft.sql);
    setApplied("replace");
    setTimeout(onDismiss, 800);
  };

  const canRun = draft.operationClass === "read" && onRun;

  return (
    <div className="mx-0 mb-2 overflow-hidden rounded-xl border border-border/70 bg-popover shadow-sm">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-foreground">
          <FileText className="h-3.5 w-3.5 text-amber-500/80" />
          SQL 草稿
        </span>
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${OP_CLASS_STYLE[draft.operationClass]}`}
          >
            {OP_CLASS_LABEL[draft.operationClass]}
          </span>
          {applied ? (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-[#1f9d7a]">
              <Check className="h-3 w-3" />
              {applied === "insert" ? "已插入" : "已替换"}
            </span>
          ) : null}
        </div>
      </div>

      {(draft.statementType || draft.targetObjects.length > 0) && (
        <div className="border-b border-border/40 bg-muted/20 px-3 py-1.5 text-[10.5px] text-muted-foreground">
          {draft.statementType ? <span className="font-medium">{draft.statementType}</span> : null}
          {draft.targetObjects.length > 0 ? (
            <span> · 目标: {draft.targetObjects.join(", ")}</span>
          ) : null}
        </div>
      )}

      {draft.explanation ? (
        <div className="border-b border-border/40 px-3 py-1.5 text-[11px] leading-relaxed text-foreground/70">
          {draft.explanation}
        </div>
      ) : null}

      <div className="max-h-[200px] overflow-y-auto scrollbar-thin bg-muted/30 px-3 py-2">
        <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-5 text-foreground">
          {draft.sql}
        </pre>
      </div>

      {draft.operationClass === "blocked" && (
        <div className="border-t border-border/60 bg-rose-500/5 px-3 py-1.5 text-[10.5px] text-rose-600 dark:text-rose-400">
          该 SQL 被安全策略阻断，无法执行。
        </div>
      )}

      {!applied ? (
        <div className="flex items-center gap-1.5 border-t border-border/60 px-2.5 py-2">
          <CardButton label="插入编辑器" icon={<ClipboardPaste className="h-3 w-3" />} onClick={handleInsert} />
          <CardButton label="替换当前" icon={<Replace className="h-3 w-3" />} onClick={handleReplace} />
          {canRun ? (
            <CardButton label="安全运行" icon={<Play className="h-3 w-3" />} onClick={() => onRun!(draft.sql)} />
          ) : null}
          <CardButton
            label={copied ? "已复制" : "复制"}
            icon={<Copy className="h-3 w-3" />}
            onClick={() => void handleCopy()}
          />
        </div>
      ) : null}
    </div>
  );
}

function CardButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-6 items-center gap-1 rounded-md border border-border/70 bg-background px-2 text-[10.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground"
    >
      {icon}
      {label}
    </button>
  );
}
