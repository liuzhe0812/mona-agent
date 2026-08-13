import { useState } from "react";
import { ChevronDown, ChevronRight, Sparkles, Reply, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { EmailAnalysis, EmailMessage } from "./lib/types";
import { openComposeWindow } from "./lib/emailApi";

interface Props {
  analysis: EmailAnalysis;
  message: EmailMessage;
  accountId: string;
}

const URGENCY_STYLES: Record<string, string> = {
  high: "bg-destructive/10 text-destructive",
  medium: "bg-warning/10 text-warning",
  low: "bg-info/10 text-info-strong",
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
    <div className="mb-2 overflow-hidden rounded-lg border border-border/70 bg-popover shadow-sm">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setCollapsed((v) => !v)}
        className="flex h-auto w-full items-center justify-between rounded-none border-b border-border/60 px-3 py-2 hover:bg-transparent"
      >
        <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          邮件分析
        </span>
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </Button>

      {!collapsed ? (
        <div className="px-3 py-2.5">
          <p className="mb-2 text-caption leading-5 text-foreground/90">{analysis.summary}</p>

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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleDraftReply()}
              className="h-7 gap-1.5 px-2.5 text-micro font-medium"
            >
              <Reply className="h-3 w-3" />
              草拟回复
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Tag({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={`inline-flex h-5 items-center rounded-md px-1.5 text-micro font-medium ${
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
    <div className="mb-2 rounded-md bg-muted/30 px-2.5 py-1.5">
      <div className="mb-1 flex items-center gap-1 text-micro font-medium text-muted-foreground">
        <FileText className="h-3 w-3" />
        关键信息
      </div>
      <div className="space-y-0.5">
        {items.map((item, idx) => (
          <div key={idx} className="flex gap-1.5 text-micro leading-4">
            <span className="shrink-0 text-muted-foreground">{item.label}:</span>
            <span className="min-w-0 flex-1 text-foreground/85">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
