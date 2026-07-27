import { useState } from "react";
import { ChevronDown, ChevronRight, Sparkles, Reply, FileText } from "lucide-react";
import type { EmailAnalysis, EmailMessage } from "./lib/types";
import { openComposeWindow } from "./lib/emailApi";

interface Props {
  analysis: EmailAnalysis;
  message: EmailMessage;
  accountId: string;
}

const URGENCY_STYLES: Record<string, string> = {
  high: "bg-red-500/10 text-red-600 dark:text-red-400",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  low: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  default: "bg-muted text-muted-foreground",
};

function urgencyClass(urgency: string): string {
  const key = urgency.toLowerCase().trim();
  return URGENCY_STYLES[key] ?? URGENCY_STYLES.default;
}

export function EmailAnalysisCard({ analysis, message, accountId }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const handleDraftReply = async () => {
    try {
      await openComposeWindow({
        mode: "reply",
        accountId,
        baseMessage: message,
      });
    } catch {}
  };

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border/70 bg-popover shadow-sm">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between border-b border-border/60 px-3 py-2"
      >
        <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-violet-500" />
          邮件分析
        </span>
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>

      {!collapsed ? (
        <div className="px-3 py-2.5">
          <p className="mb-2 text-[11.5px] leading-5 text-foreground/90">{analysis.summary}</p>

          <div className="mb-2 flex flex-wrap gap-1.5">
            {analysis.category ? (
              <Tag label={analysis.category} />
            ) : null}
            {analysis.intent ? (
              <Tag label={analysis.intent} />
            ) : null}
            {analysis.urgency ? (
              <Tag label={analysis.urgency} className={urgencyClass(analysis.urgency)} />
            ) : null}
          </div>

          {analysis.keyInfo ? (
            <KeyInfoDisplay keyInfo={analysis.keyInfo} />
          ) : null}

          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={() => void handleDraftReply()}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border/70 bg-background px-2.5 text-[11px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Reply className="h-3 w-3" />
              草拟回复
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Tag({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={`inline-flex h-5 items-center rounded-md px-1.5 text-[10px] font-medium ${
        className ?? "bg-muted text-muted-foreground"
      }`}
    >
      {label}
    </span>
  );
}

function KeyInfoDisplay({ keyInfo }: { keyInfo: string }) {
  let items: Array<{ label: string; value: string }> = [];
  try {
    const parsed = JSON.parse(keyInfo);
    if (Array.isArray(parsed)) {
      items = parsed.slice(0, 5).map((item: any) => ({
        label: String(item.label ?? item.key ?? ""),
        value: String(item.value ?? ""),
      }));
    } else if (typeof parsed === "object" && parsed !== null) {
      items = Object.entries(parsed)
        .slice(0, 5)
        .map(([label, value]) => ({ label, value: String(value) }));
    }
  } catch {
    return null;
  }
  if (items.length === 0) return null;

  return (
    <div className="mb-2 rounded-lg bg-muted/30 px-2.5 py-1.5">
      <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
        <FileText className="h-3 w-3" />
        关键信息
      </div>
      <div className="space-y-0.5">
        {items.map((item, idx) => (
          <div key={idx} className="flex gap-1.5 text-[10.5px] leading-4">
            <span className="shrink-0 text-muted-foreground">{item.label}:</span>
            <span className="min-w-0 flex-1 text-foreground/85">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
