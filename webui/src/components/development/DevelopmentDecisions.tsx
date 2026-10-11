import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Info, ShieldCheck, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { developmentApi, type DevDecision } from "@/lib/development-api";
import { refreshDevelopmentSession } from "./useDevelopmentSession";

interface DevelopmentDecisionProps {
  decision: DevDecision;
  autoFocus?: boolean;
}

export function DevelopmentDecision({ decision, autoFocus = false }: DevelopmentDecisionProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string>();
  const [submittedAction, setSubmittedAction] = useState<string>();
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const pending = useRef(false);

  const similarCommandPrefix = decision.details.similarCommandPrefix ?? [];
  const submitted = submittedAction !== undefined;
  const locked = busy || submitted;

  useEffect(() => {
    if (!autoFocus) return;
    if (decision.kind === "question") {
      root.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    } else {
      root.current?.focus();
    }
  }, [autoFocus, decision.id, decision.kind]);

  const submit = async (value: string | Record<string, string[]>) => {
    if (pending.current || submitted) return;
    pending.current = true;
    const action = typeof value === "string" ? value : "question";
    setBusy(true);
    setBusyAction(action);
    setError("");
    try {
      await developmentApi.decide(decision.sessionId, decision.id, value);
      setSubmittedAction(action);
      refreshDevelopmentSession(decision.sessionId);
      if (decision.parentSessionId) refreshDevelopmentSession(decision.parentSessionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "确认未送达，请核对当前任务。");
    } finally {
      pending.current = false;
      setBusyAction(undefined);
      setBusy(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      decision.kind !== "permission" || event.target !== event.currentTarget || locked ||
      menuOpen || error || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    ) return;

    if (event.key === "Enter") {
      event.preventDefault();
      void submit("accept");
    } else if (event.key === "Escape") {
      event.preventDefault();
      void submit("decline");
    }
  };

  const allowLabel = submitted
    ? "已提交"
    : busy && busyAction !== "decline" && busyAction !== "question"
      ? "处理中…"
      : "允许一次";
  const rejectLabel = submittedAction === "decline"
    ? "已提交"
    : busyAction === "decline" ? "处理中…" : "拒绝";

  return (
    <section
      ref={root}
      tabIndex={decision.kind === "permission" ? 0 : autoFocus ? -1 : undefined}
      onKeyDown={handleKeyDown}
      aria-label="当前任务确认"
      className={`${decision.kind === "permission" ? "rounded-xl bg-background p-4" : "rounded-lg bg-muted/30 p-3"} border border-border text-ui focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
    >
      {decision.kind === "question" ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4" aria-hidden />需要你的回答</div>
          {decision.taskTitle && <p className="truncate text-caption font-medium" title={decision.taskTitle}>{decision.taskTitle}</p>}
          {decision.details.reason && <p className="text-muted-foreground">{decision.details.reason}</p>}
          {decision.details.cwd && <p className="break-all text-caption text-muted-foreground">{decision.details.cwd}</p>}
          {decision.details.command && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 font-mono text-caption">{decision.details.command}</pre>}
          {(decision.details.questions ?? []).map((question) => (
            <fieldset key={question.id} className="space-y-2" disabled={locked}>
              <legend className="mb-2">{question.question}</legend>
              {!!question.options.length && (
                <div className="flex flex-wrap gap-1">
                  {question.options.map((option) => (
                    <Button key={option.label} type="button" variant="outline" size="sm" onClick={() => setAnswers((old) => ({ ...old, [question.id]: option.label }))}>
                      {option.label}
                    </Button>
                  ))}
                </div>
              )}
              <Textarea value={answers[question.id] ?? ""} aria-label={question.question} onChange={(e) => setAnswers((old) => ({ ...old, [question.id]: e.target.value }))} />
            </fieldset>
          ))}
          <Button
            type="button"
            disabled={locked || !(decision.details.questions ?? []).every((question) => answers[question.id]?.trim())}
            size="sm"
            onClick={() => void submit(Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, [value]])))}
          >
            {busy ? "提交中…" : submitted ? "已提交" : "提交回答"}
          </Button>
        </div>
      ) : (
        <div className="min-w-0 space-y-4">
          <div className="min-w-0 space-y-3">
            <div className="flex items-center gap-1.5 text-caption font-medium text-muted-foreground">
              {decision.details.command
                ? <Terminal className="h-4 w-4" aria-hidden />
                : <ShieldCheck className="h-4 w-4" aria-hidden />}
              {decision.details.command ? "终端" : "操作确认"}
              {decision.taskTitle && <span className="ml-2 truncate">{decision.taskTitle}</span>}
            </div>
            <p className="text-ui font-medium text-foreground">{decision.details.reason || (decision.details.command ? "允许执行这条命令吗？" : "允许本次操作吗？")}</p>
            {decision.details.command && (
              <div aria-label="执行命令" className="scrollbar-thin max-h-20 overflow-auto py-1">
                <pre className="w-max max-w-none whitespace-pre font-mono text-caption text-muted-foreground">{decision.details.command}</pre>
              </div>
            )}
            {decision.details.cwd && <p className="truncate text-caption text-muted-foreground" title={decision.details.cwd}>工作目录：{decision.details.cwd}</p>}
          </div>
          <TooltipProvider delayDuration={300}>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                disabled={locked}
                onClick={() => void submit("decline")}
                aria-label={rejectLabel}
                aria-keyshortcuts="Escape"
              >
                {rejectLabel}<kbd className="ml-1 text-caption font-normal">Esc</kbd>
              </Button>
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <div className="inline-flex">
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    className="rounded-l-full rounded-r-none border-r-0"
                    disabled={locked}
                    onClick={() => void submit("accept")}
                    aria-label={allowLabel}
                    aria-keyshortcuts="Enter"
                  >
                    {allowLabel}<kbd className="ml-1 text-caption font-normal">↵</kbd>
                  </Button>
                  <DropdownMenuTrigger asChild disabled={locked}>
                    <Button type="button" variant="default" size="icon" className="h-8 w-8 rounded-l-none rounded-r-full" aria-label="更多授权选项">
                      <ChevronDown className="h-4 w-4" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                </div>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={locked} onSelect={() => void submit("accept")}>允许一次</DropdownMenuItem>
                  {similarCommandPrefix.length > 0 && (
                    <DropdownMenuItem disabled={locked} onSelect={() => void submit("accept_similar")}>
                      允许类似命令
                      <Tooltip>
                        <TooltipTrigger asChild><Info className="ml-auto h-4 w-4" aria-label="命令前缀范围" /></TooltipTrigger>
                        <TooltipContent className="max-w-72"><p>仅允许以下命令前缀：</p><code className="break-all font-mono">{similarCommandPrefix.join(" ")}</code></TooltipContent>
                      </Tooltip>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={locked} onSelect={() => void submit("cancel")}>取消操作</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </TooltipProvider>
        </div>
      )}
      <Dialog open={Boolean(error)} onOpenChange={(open) => { if (!open) setError(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认请求失败</DialogTitle>
            <DialogDescription>{error}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="interaction" onClick={() => setError("")}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
