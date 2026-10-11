import { useMemo } from "react";
import { cn } from "@/lib/utils";

export function diffLines(source: string) {
  let before: number | null = null, after: number | null = null;
  return source.split("\n").map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { before = Number(hunk[1]); after = Number(hunk[2]); }
    const header = hunk || /^(diff |index |--- |\+\+\+ |new file |deleted file |rename |similarity )/.test(text);
    const kind = header ? "header" : before == null ? "meta" : text.startsWith("+") ? "add" : text.startsWith("-") ? "remove" : text.startsWith(" ") ? "context" : "meta";
    const left = (kind === "remove" || kind === "context") && before != null ? before++ : null;
    const right = (kind === "add" || kind === "context") && after != null ? after++ : null;
    return { text, kind, left, right };
  });
}

export function DevelopmentDiff({ value }: { value: string }) {
  const lines = useMemo(() => diffLines(value), [value]);
  return <div className="min-h-0 flex-1 overflow-auto bg-editor-surface" aria-label="代码差异">
    <div className="min-w-full w-max py-2 font-mono text-caption">{lines.map((line, index) => <div key={index} className={cn("flex min-h-5", line.kind === "add" && "bg-success/10", line.kind === "remove" && "bg-destructive/10", line.kind === "header" && "bg-muted/60 text-muted-foreground")}>
      <span aria-hidden className="sticky left-0 w-12 shrink-0 select-none bg-editor-surface px-2 text-right text-muted-foreground/70">{line.left}</span>
      <span aria-hidden className="sticky left-12 w-12 shrink-0 select-none bg-editor-surface px-2 text-right text-muted-foreground/70">{line.right}</span>
      <pre className="m-0 whitespace-pre px-3">{line.text}</pre>
    </div>)}</div>
  </div>;
}
