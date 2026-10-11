import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  Circle,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { DevelopmentApiError, type DevProject, type DevSession } from "@/lib/development-api";
import { DevelopmentGitUnavailable } from "./DevelopmentGitUnavailable";
import { DevelopmentGitBranchPicker } from "./DevelopmentGitBranchPicker";
import { EMPTY_GIT_DRAFT, useGitActionDrafts } from "./git-action-drafts";
import { gitActionsApi, type GitAction, type GitCommitPreview, type GitActionKind } from "./git-actions-api";

type CommitChoice = "commit" | "commit_and_push" | "push" | "commit_and_switch";

const actionLabels: Record<CommitChoice, string> = {
  commit: "提交",
  commit_and_push: "提交并推送",
  push: "推送",
  commit_and_switch: "提交并切换",
};
const operationLabels: Partial<Record<GitActionKind, string>> = {
  commit: "提交",
  commit_and_push: "提交并推送",
  commit_and_switch: "提交并切换",
  push: "推送",
};
const operationStatusLabels: Record<GitAction["status"], string> = {
  prepared: "等待确认",
  running: "执行中",
  succeeded: "已完成",
  failed: "未完成",
  unknown: "结果待核对",
  acknowledged: "已人工核对",
};
const phaseLabels: Record<string, string> = {
  checking: "核对仓库状态",
  staging: "暂存更改",
  committing: "创建提交",
  pushing: "推送更改",
  switching: "切换分支",
};

function requestId(): string {
  return `gitreq_${crypto.randomUUID().replaceAll("-", "")}`;
}

function canCommit(preview: GitCommitPreview | null, session: DevSession): boolean {
  return Boolean(preview?.writable && preview.files.length && preview.identity?.name.trim() && preview.identity?.email.trim())
    && !session.readonly && !session.archived;
}

function isRestorable(action: GitAction): boolean {
  return action.status === "running" || action.status === "unknown";
}

function selectedPaths(preview: GitCommitPreview): string[] {
  return Array.from(new Set(preview.files.map((file) => file.path)));
}

export function DevelopmentGitActions({
  project,
  session,
  open,
  onOpenChange,
  onChanged,
  switchAfterCommit,
}: {
  project: DevProject;
  session: DevSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  switchAfterCommit?: string;
}) {
  const draft = useGitActionDrafts((state) => state.drafts[session.id] ?? EMPTY_GIT_DRAFT);
  const updateDraft = useCallback(
    (message: string) => useGitActionDrafts.getState().update(session.id, { message }),
    [session.id],
  );
  const [preview, setPreview] = useState<GitCommitPreview | null>(null);
  const [dirtyFileCount, setDirtyFileCount] = useState(0);
  const [operation, setOperation] = useState<GitAction | null>(null);
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generationPending, setGenerationPending] = useState(false);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [missingGit, setMissingGit] = useState(false);
  const [selectedAction, setSelectedAction] = useState<CommitChoice>(switchAfterCommit ? "commit_and_switch" : "commit");
  const [pushConfirmOpen, setPushConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const lifecycle = useRef(0);
  const previewRequest = useRef(0);
  const operationRequest = useRef<string | null>(null);
  const messageTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageInputFocusedOnOpen = useRef(false);
  const writePending = useRef(false);
  const generationPendingRef = useRef(false);
  const generationSequence = useRef(0);
  const openRef = useRef(open);
  const sessionIdRef = useRef(session.id);
  openRef.current = open;
  sessionIdRef.current = session.id;
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const actionBusy = loading || previewLoading || busy || generationPending;

  const loadPreview = useCallback(async (include: boolean, life = lifecycle.current) => {
    const request = ++previewRequest.current;
    setPreviewLoading(true);
    setError("");
    try {
      let value = await gitActionsApi.preview(session.id, include);
      let fullFileCount = new Set(value.files.map((file) => file.path)).size;
      if (include && value.unstagedCount === 0) value = await gitActionsApi.preview(session.id, false);
      if (!include) fullFileCount = new Set((await gitActionsApi.preview(session.id, true)).files.map((file) => file.path)).size;
      if (life !== lifecycle.current || request !== previewRequest.current) return false;
      setPreview(value);
      setDirtyFileCount(fullFileCount);
      setIncludeUnstaged(value.includeUnstaged);
      setMissingGit(false);
      return true;
    } catch (cause) {
      if (life !== lifecycle.current || request !== previewRequest.current) return false;
      if (cause instanceof DevelopmentApiError && cause.code === "git_unavailable") {
        setMissingGit(true);
        setPreview(null);
      } else {
        setPreview(null);
        setError(cause instanceof Error ? cause.message : "无法读取 Git 更改。请重试。" );
      }
      return false;
    } finally {
      if (life === lifecycle.current && request === previewRequest.current) setPreviewLoading(false);
    }
  }, [session.id]);

  const load = useCallback(async (life: number, refresh = false) => {
    setLoading(true);
    setHistoryError("");
    setError("");
    setPreview(null);
    setOperation(null);
    setAcknowledged(false);
    const previewPromise = gitActionsApi.preview(session.id, true).then(async (value) =>
      value.unstagedCount > 0 ? value : gitActionsApi.preview(session.id, false),
    );
    const [previewResult, recentResult] = await Promise.allSettled([
      previewPromise,
      gitActionsApi.recent(session.id),
    ]);
    if (life !== lifecycle.current) return;

    if (previewResult.status === "fulfilled") {
      setPreview(previewResult.value);
      setDirtyFileCount(new Set(previewResult.value.files.map((file) => file.path)).size);
      setIncludeUnstaged(previewResult.value.includeUnstaged);
      setMissingGit(false);
    } else if (previewResult.reason instanceof DevelopmentApiError && previewResult.reason.code === "git_unavailable") {
      setMissingGit(true);
      setPreview(null);
    } else {
      setPreview(null);
      setError(previewResult.reason instanceof Error ? previewResult.reason.message : "无法读取 Git 更改。请重试。");
    }

    if (recentResult.status === "fulfilled") {
      const active = recentResult.value.find(isRestorable) ?? null;
      setOperation(active);
      if (active) operationRequest.current = active.id;
      else if (!refresh && previewResult.status === "fulfilled" && !previewResult.value.files.length && previewResult.value.canPush) setPushConfirmOpen(true);
    } else {
      setHistoryError("操作记录读取失败，请刷新核对；没有重新执行。");
    }

    if (refresh && previewResult.status === "fulfilled") changed.current();
    setLoading(false);
  }, [session.id]);

  const finishOperation = useCallback((value: GitAction, life: number) => {
    if (life !== lifecycle.current) return;
    if (value.status === "succeeded") {
      if (value.kind !== "push") updateDraft("");
      changed.current();
      setOperation(null);
      setPushConfirmOpen(false);
      onOpenChange(false);
      return;
    }
    if (value.status === "failed") {
      setOperation(null);
      operationRequest.current = null;
      setError(value.reason || "Git 操作未完成，请重试。");
      if (value.commit) {
        updateDraft(""); changed.current();
      }
      void loadPreview(includeUnstaged, life).then(() => {
        if (life === lifecycle.current) setError(value.reason || "Git 操作未完成，请重试。");
      });
      return;
    }
    setOperation(value);
    if (value.commit) {
      updateDraft("");
      changed.current();
      void loadPreview(includeUnstaged, life);
    }
  }, [includeUnstaged, loadPreview, onOpenChange, updateDraft]);

  useEffect(() => {
    if (!open) return;
    const life = ++lifecycle.current;
    setSelectedAction(switchAfterCommit ? "commit_and_switch" : "commit");
    void load(life);
    return () => {
      if (lifecycle.current === life) lifecycle.current += 1;
      previewRequest.current += 1;
    };
  }, [load, open, switchAfterCommit]);

  useEffect(() => {
    if (!open) {
      messageInputFocusedOnOpen.current = false;
      setLoading(false);
      setPreviewLoading(false);
      if (!writePending.current) setBusy(false);
      generationSequence.current += 1;
      generationPendingRef.current = false;
      setGenerationPending(false);
      setPushConfirmOpen(false);
      return;
    }
    if (loading || !preview || actionBusy || messageInputFocusedOnOpen.current) return;
    const frame = window.requestAnimationFrame(() => {
      messageTextareaRef.current?.focus();
      messageInputFocusedOnOpen.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [actionBusy, loading, open, preview]);

  useEffect(() => {
    if (!open || operation?.status !== "running") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await gitActionsApi.get(session.id, operation.id);
        if (stopped) return;
        setError("");
        if (value.status !== "running") finishOperation(value, lifecycle.current);
        else setOperation(value);
      } catch {
        if (!stopped) setError("暂时无法读取 Git 操作结果；不会重复执行。正在重新核对状态。");
      } finally {
        if (!stopped) timer = setTimeout(poll, 1000);
      }
    };
    timer = setTimeout(poll, 500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [finishOperation, open, operation?.id, operation?.status, session.id]);

  const refreshPreview = useCallback(() => {
    changed.current();
    void loadPreview(includeUnstaged);
  }, [includeUnstaged, loadPreview]);

  const switchEnabled = Boolean(switchAfterCommit && preview?.writable && !session.readonly && !session.archived);
  const commitEnabled = canCommit(preview, session);
  const pushEnabled = Boolean(preview?.canPush && preview.defaultRemote && preview.writable && !session.readonly && !session.archived);
  const actionChoices: CommitChoice[] = switchAfterCommit ? ["commit_and_switch"] : ["commit", "commit_and_push", "push"];
  const enabledChoices = actionChoices.filter((choice) => {
    if (choice === "push") return pushEnabled;
    if (choice === "commit_and_switch") return switchEnabled && commitEnabled;
    return commitEnabled;
  });
  const selectedChoice = enabledChoices.includes(selectedAction) ? selectedAction : enabledChoices[0];

  useEffect(() => {
    if (selectedChoice && selectedChoice !== selectedAction) setSelectedAction(selectedChoice);
  }, [selectedAction, selectedChoice]);

  const generateMessage = useCallback(async (state: GitCommitPreview, include: boolean) => {
    if (generationPendingRef.current) return null;
    if (!state.identity?.name.trim() || !state.identity?.email.trim()) {
      setError("请先配置 Git 用户名和邮箱，再生成提交信息。");
      return null;
    }
    const generation = ++generationSequence.current;
    generationPendingRef.current = true;
    setGenerationPending(true);
    setError("");
    const life = lifecycle.current;
    try {
      const result = await gitActionsApi.generateMessage(session.id, include, state.contextToken);
      if (life !== lifecycle.current) return null;
      if (!result.message.trim()) {
        setError("没有生成提交信息。请填写提交信息后重试。");
        return null;
      }
      updateDraft(result.message);
      return result.message.trim();
    } catch (cause) {
      if (life === lifecycle.current) setError(cause instanceof Error ? cause.message : "生成提交信息失败，请手动填写。");
      return null;
    } finally {
      if (generationSequence.current === generation) {
        generationPendingRef.current = false;
        setGenerationPending(false);
      }
    }
  }, [session.id, updateDraft]);

  const executePrepared = useCallback(async (prepared: GitAction, life: number) => {
    operationRequest.current = prepared.id;
    setOperation(prepared);
    setBusy(true);
    setError("");
    try {
      const result = await gitActionsApi.execute(session.id, prepared.id);
      if (life !== lifecycle.current) {
        if (sessionIdRef.current === session.id && (result.status === "succeeded" || result.commit)) {
          if (result.kind !== "push") updateDraft("");
          changed.current();
        }
        return;
      }
      if (result.status !== "running") finishOperation(result, life);
      else setOperation(result);
    } catch (cause) {
      if (life !== lifecycle.current) return;
      setError(cause instanceof Error ? cause.message : "无法确认 Git 操作结果；没有自动重试。");
      try {
        const result = await gitActionsApi.get(session.id, prepared.id);
        if (life === lifecycle.current) {
          if (result.status !== "running") finishOperation(result, life);
          else setOperation(result);
        }
      } catch {
        if (life === lifecycle.current) setOperation({ ...prepared, reason: "无法读取此操作的结果。没有自动重试，请重新读取状态。" });
      }
    } finally {
      if (life === lifecycle.current) setBusy(false);
    }
  }, [finishOperation, session.id, updateDraft]);

  const submitCommit = useCallback(async (kind: "commit" | "commit_and_push" | "commit_and_switch") => {
    if (!preview || !commitEnabled || busy || generationPending || previewLoading || writePending.current) return;
    if (!preview.identity?.name.trim() || !preview.identity?.email.trim()) {
      setError("请先配置 Git 用户名和邮箱，再提交更改。");
      return;
    }
    const paths = selectedPaths(preview);
    if (!paths.length) return;
    const life = lifecycle.current;
    writePending.current = true;
    setBusy(true);
    setError("");
    try {
      let message = draft.message.trim();
      if (!message) {
        const generated = await generateMessage(preview, includeUnstaged);
        if (!generated || life !== lifecycle.current) return;
        message = generated;
      }
      const targetBranch = kind === "commit_and_switch" ? switchAfterCommit! : kind === "commit_and_push" ? preview.defaultBranch || preview.branch : "";
      const request: Parameters<typeof gitActionsApi.prepare>[1] = {
        requestId: requestId(),
        kind,
        paths,
        message,
        remote: kind === "commit_and_push" ? preview.defaultRemote : "",
        branch: targetBranch,
        includeUnstaged,
        contextToken: preview.contextToken,
      };
      const prepared = await gitActionsApi.prepare(session.id, request);
      if (life !== lifecycle.current) return;
      if (kind === "commit_and_push") setPushConfirmOpen(false);
      await executePrepared(prepared, life);
    } catch (cause) {
      if (life === lifecycle.current) setError(cause instanceof Error ? cause.message : "无法准备 Git 操作；没有执行更改。");
    } finally {
      writePending.current = false;
      setBusy(false);
      if (life !== lifecycle.current && openRef.current && sessionIdRef.current === session.id) void load(lifecycle.current);
    }
  }, [busy, commitEnabled, draft.message, executePrepared, generateMessage, includeUnstaged, load, preview, previewLoading, session.id, switchAfterCommit]);

  const openPushConfirmation = useCallback(() => {
    if (!pushEnabled || actionBusy) return;
    setError("");
    setPushConfirmOpen(true);
  }, [actionBusy, pushEnabled]);

  const submitPush = useCallback(async () => {
    if (!preview || !pushEnabled || busy || writePending.current) return;
    const life = lifecycle.current;
    writePending.current = true;
    setBusy(true);
    setError("");
    try {
      const prepared = await gitActionsApi.prepare(session.id, {
        requestId: requestId(),
        kind: "push",
        paths: [],
        message: "",
        remote: preview.defaultRemote,
        branch: preview.defaultBranch || preview.branch,
        includeUnstaged,
        contextToken: preview.contextToken,
      });
      if (life !== lifecycle.current) return;
      setPushConfirmOpen(false);
      await executePrepared(prepared, life);
    } catch (cause) {
      if (life === lifecycle.current) setError(cause instanceof Error ? cause.message : "无法准备推送；没有执行更改。");
    } finally {
      writePending.current = false;
      setBusy(false);
      if (life !== lifecycle.current && openRef.current && sessionIdRef.current === session.id) void load(lifecycle.current);
    }
  }, [busy, executePrepared, includeUnstaged, load, preview, pushEnabled, session.id]);

  const acknowledge = useCallback(async () => {
    if (!operation || operation.status !== "unknown" || !acknowledged || busy) return;
    setBusy(true);
    setError("");
    const life = lifecycle.current;
    try {
      const result = await gitActionsApi.acknowledge(session.id, operation.id);
      if (life === lifecycle.current) {
        setOperation(result);
        setAcknowledged(false);
      }
    } catch (cause) {
      if (life === lifecycle.current) setError(cause instanceof Error ? cause.message : "保存核对结果失败。");
    } finally {
      if (life === lifecycle.current) setBusy(false);
    }
  }, [acknowledged, busy, operation, session.id]);

  const inspectOperation = useCallback(async () => {
    const id = operationRequest.current;
    if (!id || busy) return;
    setBusy(true);
    setError("");
    try {
      setOperation(await gitActionsApi.get(session.id, id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取 Git 操作结果；没有重新执行。");
    } finally {
      setBusy(false);
    }
  }, [busy, session.id]);

  const triggerAction = useCallback((choice: CommitChoice | undefined) => {
    if (!choice || actionBusy) return;
    if (choice === "push") openPushConfirmation();
    else void submitCommit(choice);
  }, [actionBusy, openPushConfirmation, submitCommit]);

  const moveSelection = useCallback((direction: 1 | -1) => {
    if (!enabledChoices.length) return;
    const index = selectedChoice ? enabledChoices.indexOf(selectedChoice) : -1;
    const next = (index + direction + enabledChoices.length) % enabledChoices.length;
    setSelectedAction(enabledChoices[next] ?? enabledChoices[0] ?? "commit");
  }, [enabledChoices, selectedChoice]);

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && event.target instanceof HTMLButtonElement && event.target.closest('[aria-label="Git 操作"]')) {
      event.preventDefault(); event.stopPropagation(); triggerAction(selectedChoice); return;
    }
    if ((event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLButtonElement) && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      event.stopPropagation();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      triggerAction(selectedChoice);
    }
  };

  const count = preview?.files.length ?? 0;
  const remote = preview?.defaultRemote ?? "";
  const targetBranch = preview?.defaultBranch || preview?.branch || "";
  const destination = remote && targetBranch ? `${remote}/${targetBranch}` : "未配置推送目标";
  const changeReady = Boolean(preview?.files.length);

  return (
    <>
      <Dialog open={open && !pushConfirmOpen} onOpenChange={(next) => {
        if (!next) {
          lifecycle.current += 1;
          setPushConfirmOpen(false);
        }
        onOpenChange(next);
      }}>
        <DialogContent
          showCloseButton={false}
          className="max-w-md gap-0 overflow-hidden border-border bg-popover p-0 shadow-lg"
          onKeyDownCapture={onDialogKeyDown}
          onOpenAutoFocus={(event) => {
            if (!loading && preview && !actionBusy) event.preventDefault();
          }}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{project.displayName} Git 操作</DialogTitle>
            <DialogDescription>查看更改并提交，或将当前分支推送到远程。</DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex h-56 items-center justify-center text-muted-foreground" aria-label="正在读取 Git 更改">
              <LoaderCircle className="h-5 w-5 animate-spin" />
            </div>
          ) : missingGit ? (
            <div className="p-6">
              <DevelopmentGitUnavailable reasonCode="git_unavailable" checking={busy} onRecheck={() => void load(lifecycle.current, true)} />
            </div>
          ) : operation ? (
            <section className="space-y-5 p-6" aria-label="Git 操作结果">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  {operation.status === "succeeded" ? <CheckCircle2 className="h-5 w-5 text-success" /> : operation.status === "running" ? <LoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" /> : <AlertTriangle className="h-5 w-5 text-warning" />}
                  <h2 className="truncate text-lg font-medium">{operationLabels[operation.kind] ?? "Git 操作"} · {operationStatusLabels[operation.status]}</h2>
                </div>
                <span className="max-w-56 truncate text-sm text-muted-foreground">{operation.branch}</span>
              </div>
              {!!operation.steps.length && <ol className="space-y-3" aria-label="Git 操作进度">
                {operation.steps.map((step) => <li key={step.phase} className="flex items-center gap-3 text-sm">
                  {step.status === "completed" ? <CheckCircle2 className="h-4 w-4 text-success" /> : step.status === "running" && operation.status === "running" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
                  <span className="flex-1">{phaseLabels[step.phase] ?? step.phase}</span>
                </li>)}
              </ol>}
              {operation.message && <p className="whitespace-pre-wrap text-sm">{operation.message}</p>}
              {operation.reason && <p role="status" className={cn("text-sm", operation.status === "failed" ? "text-destructive" : operation.status === "unknown" ? "text-warning" : "text-muted-foreground")}>{operation.reason}</p>}
              {operation.commit && <p className="break-all font-mono text-xs text-muted-foreground">{operation.commit}</p>}
              {operation.status === "unknown" && <div className="space-y-3 rounded-lg bg-warning/10 p-3">
                <p className="text-sm text-warning">请先核对本地提交和远程分支。保存核对结果不会再次执行 Git 操作。</p>
                <label className="flex items-center gap-2 text-sm"><Checkbox aria-label="确认已人工核对 Git 状态" checked={acknowledged} onCheckedChange={(value) => setAcknowledged(value === true)} />我已完成核对</label>
              </div>}
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <DialogFooter className="gap-2">
                {operation.status === "unknown" && <Button disabled={!acknowledged || busy} onClick={() => void acknowledge()}>保存核对结果</Button>}
                {operation.status === "prepared" && <Button disabled={busy} onClick={() => void inspectOperation()}>读取操作状态</Button>}
                <Button variant="outline" onClick={() => onOpenChange(false)}>{operation.status === "running" ? "关闭并继续运行" : "关闭"}</Button>
              </DialogFooter>
            </section>
          ) : (
            <div className="flex max-h-[90vh] flex-col" onKeyDownCapture={onDialogKeyDown}>
              <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
                {preview && <DevelopmentGitBranchPicker
                  session={session}
                  project={project}
                  branch={preview.branch}
                  dirtyCount={dirtyFileCount}
                  disabled={actionBusy || !preview.writable || session.readonly || session.archived}
                  onChanged={refreshPreview}
                  triggerClassName="h-7 max-w-64 justify-start rounded-lg px-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground [&>span]:max-w-48"
                  popoverSide="bottom"
                  popoverClassName="w-80"
                  showFooterActions={false}
                />}
                <div className="flex shrink-0 items-center gap-1.5 font-mono text-body">
                  <span className="text-success">+{(preview?.additions ?? 0).toLocaleString()}</span>
                  <span className="text-destructive">-{(preview?.deletions ?? 0).toLocaleString()}</span>
                </div>
              </div>

              <div className="relative min-h-36 px-4 pb-2">
                <Textarea
                  ref={messageTextareaRef}
                  aria-label="提交信息"
                  value={draft.message}
                  disabled={actionBusy || Boolean(operation)}
                  maxLength={4000}
                  placeholder="提交信息（留空将自动生成）"
                  onChange={(event) => { updateDraft(event.target.value); setError(""); }}
                  className="min-h-28 resize-none rounded-none border-0 bg-transparent px-0 py-2 pr-8 text-body font-medium shadow-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0 md:text-body"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={draft.message.trim() ? "重新生成提交信息" : "生成提交信息"}
                  title={draft.message.trim() ? "重新生成提交信息" : "生成提交信息"}
                  disabled={actionBusy || !changeReady || !preview?.identity?.name.trim() || !preview.identity.email.trim()}
                  onClick={() => { if (preview) void generateMessage(preview, includeUnstaged); }}
                  className="absolute right-4 top-2 h-8 w-8 text-muted-foreground"
                >
                  {generationPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                </Button>
              </div>

              <div className="px-2.5 pb-2">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={includeUnstaged}
                  aria-label="包含未暂存的更改"
                  disabled={actionBusy || !preview?.unstagedCount}
                  onClick={() => { void loadPreview(!includeUnstaged); }}
                  className={cn("flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-body font-medium transition-colors", actionBusy || !preview?.unstagedCount ? "cursor-default text-muted-foreground" : "cursor-pointer text-foreground hover:bg-muted/60")}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                    <span className={cn("flex h-4 w-4 items-center justify-center rounded-sm border", includeUnstaged ? "border-foreground bg-foreground text-background" : "border-input bg-background text-transparent")}><Check className="h-3.5 w-3.5" /></span>
                  </span>
                  <span className="min-w-0 flex-1 truncate">包含未暂存的更改</span>
                  <span className="shrink-0 text-body font-normal text-muted-foreground">{count.toLocaleString()} 个文件</span>
                </button>
              </div>

              {preview && (!preview.identity?.name.trim() || !preview.identity.email.trim()) && <p className="mx-4 mb-2 text-body text-warning">请先配置 Git 用户名和邮箱，再提交更改。</p>}
              {error && !pushConfirmOpen && <p role="alert" className="mx-4 mb-2 text-body text-destructive">{error}</p>}
              {historyError && <p role="alert" className="mx-4 mb-2 text-body text-destructive">{historyError}</p>}

              <div role="listbox" aria-label="Git 操作" className="border-t border-border/50 px-2.5 py-2">
                {actionChoices.map((choice) => {
                  const disabled = !enabledChoices.includes(choice) || actionBusy;
                  const selected = choice === selectedChoice;
                  const Icon = choice === "commit" || choice === "commit_and_switch" ? GitCommitHorizontal : choice === "push" ? UploadCloud : UploadCloud;
                  return <button
                    key={choice}
                    data-testid={`git-action-${choice}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={disabled}
                    onFocus={() => setSelectedAction(choice)}
                    onMouseEnter={() => { if (!disabled) setSelectedAction(choice); }}
                    onClick={() => { setSelectedAction(choice); triggerAction(choice); }}
                    className={cn("flex h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-body font-medium transition-colors", selected && !disabled ? "bg-muted" : "bg-transparent", disabled ? "cursor-default text-muted-foreground/60" : "hover:bg-muted/70")}
                  >
                    {busy && selected ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4 shrink-0" />}
                    <span className="min-w-0 flex-1 truncate">{actionLabels[choice]}</span>
                    {selected && !disabled && <kbd className="shrink-0 font-mono text-caption text-muted-foreground">{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+↵</kbd>}
                  </button>;
                })}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={open && pushConfirmOpen} onOpenChange={(next) => { if (!busy) { setPushConfirmOpen(next); if (!next) { setError(""); onOpenChange(false); } } }}>
        <DialogContent className="max-w-lg gap-0 overflow-hidden rounded-2xl p-0">
          <DialogHeader className="px-6 pb-0 pt-6">
            <DialogTitle>推送更改</DialogTitle>
            <DialogDescription className="sr-only">确认当前分支、跟踪分支和推送目标。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <div className="rounded-xl bg-muted/30 p-4">
              <div className="flex items-center justify-between gap-4 py-2 text-sm">
                <span className="text-muted-foreground">当前分支</span>
                <span className="flex min-w-0 items-center gap-2 font-medium"><GitBranch className="h-4 w-4 shrink-0" /><span className="truncate">{preview?.branch || "—"}</span></span>
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-border/70 py-3 text-sm">
                <span className="text-muted-foreground">跟踪分支</span>
                <span className="truncate">{preview?.trackingBranch || "未设置"}</span>
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-border/70 py-3 text-sm">
                <span className="text-muted-foreground">本地领先 / 落后</span>
                <span><span className="text-success">{preview?.ahead ?? 0}</span> / <span className="text-destructive">{preview?.behind ?? 0}</span></span>
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-border/70 pt-3 text-sm">
                <span className="text-muted-foreground">推送目标</span>
                <span className="max-w-[65%] truncate font-medium">{destination}</span>
              </div>
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter className="gap-2 border-t border-border/70 px-6 py-4">
            <Button variant="outline" disabled={busy} onClick={() => { setPushConfirmOpen(false); onOpenChange(false); }}>取消</Button>
            <Button disabled={!pushEnabled || busy} onClick={() => void submitPush()}>
              {busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="mr-2 h-4 w-4" />}
              推送
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
