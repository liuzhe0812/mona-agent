import { useState } from "react";
import { Check, Copy, ClipboardPaste, FileText, Replace } from "lucide-react";

interface Props {
  sql: string;
  onInsert: (sql: string) => void;
  onReplace: (sql: string) => void;
  onDismiss: () => void;
}

export function SqlResultCard({ sql, onInsert, onReplace, onDismiss }: Props) {
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState<"insert" | "replace" | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const handleInsert = () => {
    onInsert(sql);
    setApplied("insert");
    setTimeout(onDismiss, 800);
  };

  const handleReplace = () => {
    onReplace(sql);
    setApplied("replace");
    setTimeout(onDismiss, 800);
  };

  return (
    <div className="mx-0 mb-2 overflow-hidden rounded-xl border border-border/70 bg-popover shadow-sm">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-foreground">
          <FileText className="h-3.5 w-3.5 text-amber-500/80" />
          NL2SQL 结果
        </span>
        {applied ? (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-[#1f9d7a]">
            <Check className="h-3 w-3" />
            {applied === "insert" ? "已插入" : "已替换"}
          </span>
        ) : null}
      </div>
      <div className="max-h-[200px] overflow-y-auto scrollbar-thin bg-muted/30 px-3 py-2">
        <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-5 text-foreground">
          {sql}
        </pre>
      </div>
      {!applied ? (
        <div className="flex items-center gap-1.5 border-t border-border/60 px-2.5 py-2">
          <CardButton label="插入编辑器" icon={<ClipboardPaste className="h-3 w-3" />} onClick={handleInsert} />
          <CardButton label="替换当前" icon={<Replace className="h-3 w-3" />} onClick={handleReplace} />
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
