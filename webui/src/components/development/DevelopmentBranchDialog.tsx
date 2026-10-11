import { useEffect, useRef, useState } from "react";
import { GitBranch, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DevelopmentApiError, type DevSession } from "@/lib/development-api";
import { gitActionsApi, type GitAction, type GitBranchContext } from "./git-actions-api";

const kindLabels = { create_branch: "创建分支", switch_branch: "切换分支" } as const;
const statusLabels = { prepared: "等待确认", running: "正在执行", succeeded: "已完成", failed: "未完成", unknown: "结果待核对", acknowledged: "已核对" } as const;

export function DevelopmentBranchDialog({ session, mode, open, onOpenChange, onChanged }: {
  session: DevSession; mode: "create" | "switch"; open: boolean; onOpenChange: (open: boolean) => void; onChanged: () => void;
}) {
  const [context, setContext] = useState<GitBranchContext | null>(null);
  const [operation, setOperation] = useState<GitAction | null>(null);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const generation = useRef(0);
  const request = useRef<{ target: string; id: string } | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  useEffect(() => {
    if (!open) return;
    const current = ++generation.current;
    setContext(null); setOperation(null); setError(""); setAcknowledged(false); setBranch(""); request.current = null;
    void gitActionsApi.branches(session.id).then((value) => {
      if (current !== generation.current) return;
      setContext(value);
      const pending = value.pendingAction;
      if (pending) setOperation(pending);
    }).catch(() => {
      if (current === generation.current) setError("无法读取当前分支，请稍后重试。");
    });
    return () => { generation.current += 1; };
  }, [open, session.id, mode]);

  useEffect(() => {
    if (!open || operation?.status !== "running") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await gitActionsApi.get(operation.sessionId, operation.id);
        if (!stopped) { setOperation(value); setError(""); }
      } catch {
        if (!stopped) setError("暂时无法确认分支操作状态；系统不会重复执行。");
      } finally {
        if (!stopped) timer = setTimeout(poll, 1200);
      }
    };
    timer = setTimeout(poll, 900);
    return () => { stopped = true; clearTimeout(timer); };
  }, [open, session.id, operation?.sessionId, operation?.id, operation?.status]);

  useEffect(() => {
    if (open && (operation?.status === "succeeded" || operation?.status === "acknowledged")) {
      changed.current();
      onOpenChange(false);
    }
  }, [open, operation?.status, onOpenChange]);

  useEffect(() => {
    if (!open || operation?.status !== "unknown") return;
    let active = true;
    setContext(null);
    void gitActionsApi.branches(session.id).then((value) => { if (active) setContext(value); })
      .catch(() => { if (active) setError("无法读取当前分支，请在项目终端核对。") });
    return () => { active = false; };
  }, [open, operation?.status, session.id]);

  const readonly = session.readonly || session.archived;
  const target = branch.trim();
  const canPrepare = !!context && !busy && !readonly && !operation
    && !!target && (mode === "create" ? !context.branches.includes(target) : context.branches.includes(target) && target !== context.branch);

  const prepare = async () => {
    if (!canPrepare) return;
    const kind = mode === "create" ? "create_branch" : "switch_branch";
    const key = `${kind}:${target}`;
    if (request.current?.target !== key) request.current = { target: key, id: `gitreq_${crypto.randomUUID().replaceAll("-", "")}` };
    const current = generation.current;
    setBusy(true); setError("");
    let prepared: GitAction | undefined;
    try {
      const value = await gitActionsApi.prepare(session.id, { requestId: request.current.id, kind, paths: [], message: "", remote: "", branch: target });
      if (current !== generation.current) return;
      if (mode !== "create" || value.status !== "prepared") {
        setOperation(value);
        return;
      }
      prepared = value;
      const result = await gitActionsApi.execute(session.id, prepared.id);
      if (current === generation.current) setOperation(result);
    } catch (cause) {
      if (current !== generation.current) return;
      setError(cause instanceof DevelopmentApiError ? cause.message : "无法确认分支操作结果；系统不会重复执行。");
      if (prepared) {
        try {
          const latest = await gitActionsApi.get(session.id, prepared.id);
          if (current === generation.current) setOperation(latest);
        } catch { /* Preserve the error and avoid replaying an uncertain operation. */ }
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const execute = async () => {
    if (!operation || operation.sessionId !== session.id || busy || readonly || operation.status !== "prepared") return;
    const current = generation.current;
    setBusy(true); setError("");
    try {
      const value = await gitActionsApi.execute(session.id, operation.id);
      if (current === generation.current) setOperation(value);
    } catch (cause) {
      if (current !== generation.current) return;
      setError(cause instanceof DevelopmentApiError ? cause.message : "无法确认分支操作结果；系统不会重复执行。");
      try {
        const value = await gitActionsApi.get(operation.sessionId, operation.id);
        if (current === generation.current) setOperation(value);
      } catch { /* Keep the operation identity visible for safe follow-up. */ }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const acknowledge = async () => {
    if (!operation || !acknowledged || busy || operation.status !== "unknown") return;
    const current = generation.current;
    setBusy(true); setError("");
    try {
      const value = await gitActionsApi.acknowledge(operation.sessionId, operation.id);
      if (current === generation.current) setOperation(value);
    } catch {
      if (current === generation.current) setError("无法保存核对结果，请稍后重试。");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const refresh = () => {
    const current = generation.current;
    if (operation?.status === "failed") request.current = null;
    setContext(null); setOperation(null); setAcknowledged(false); setError(""); setBusy(true);
    void gitActionsApi.branches(session.id).then((value) => {
      if (current === generation.current) { setContext(value); setOperation(value.pendingAction); setBranch(""); }
    }).catch(() => {
      if (current === generation.current) setError("无法读取当前分支，请稍后重试。");
    }).finally(() => {
      if (current === generation.current) setBusy(false);
    });
  };

  const actionTarget = operation?.targetBranch || operation?.branch || "";
  const operationKind = operation?.kind === "create_branch" || operation?.kind === "switch_branch" ? operation.kind : null;

  return <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}><DialogContent>
    <DialogHeader>
      <DialogTitle className="flex items-center gap-2"><GitBranch className="h-5 w-5" />{mode === "create" ? "创建分支" : "切换分支"}</DialogTitle>
      <DialogDescription className={mode === "create" ? "sr-only" : undefined}>{mode === "create" ? "创建并切换到新的本地分支。" : "切换到项目中已有的本地分支。"}</DialogDescription>
    </DialogHeader>
    <div className="space-y-4">
      {error && <p role="alert" className="text-ui text-destructive">{error}</p>}
      {readonly && <p className="text-ui text-muted-foreground">此任务为只读或已归档，不能修改分支。</p>}
      {!context && !error && <p role="status" className="flex items-center gap-2 text-ui text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />正在读取分支…</p>}
      {context && !operation && !readonly && (mode === "create" ? <label className="grid gap-2 text-ui">新分支名称
        <Input aria-label="新分支名称" value={branch} onChange={(event) => setBranch(event.target.value)} disabled={busy} autoComplete="off" />
      </label> : <label className="grid gap-2 text-ui">本地分支
        <select aria-label="选择本地分支" className="h-9 rounded-md border border-input bg-background px-3 text-ui" value={branch} onChange={(event) => setBranch(event.target.value)} disabled={busy}>
          <option value="">选择分支</option>{context.branches.map((item) => <option key={item} value={item} disabled={item === context.branch}>{item}{item === context.branch ? "（当前）" : ""}</option>)}
        </select>
      </label>)}
      {mode === "switch" && context && !operation && !readonly && <p className="text-caption text-muted-foreground">当前分支：{context.branch}</p>}
      {operation && <section aria-label="分支操作状态" className="space-y-3">
        <h3 className="text-body font-medium">{operationKind ? kindLabels[operationKind] : "分支操作"} · {statusLabels[operation.status]}</h3>
        <p className="text-ui">目标分支：{actionTarget}</p>
        {context && <p className="text-caption text-muted-foreground">当前分支：{context.branch || "未检测到分支"}</p>}
        {operation.sessionId !== session.id && <p className="text-caption text-muted-foreground">此操作来自另一个开发任务。请核对当前分支和本地改动后，再结束待处理状态。</p>}
        {operation.status === "prepared" && <p className="text-caption leading-relaxed text-muted-foreground">确认后将{operationKind === "create_branch" ? "创建" : "切换到"}此分支。</p>}
        {operation.status === "running" && <p role="status" className="text-caption text-muted-foreground">正在处理，关闭窗口后操作仍会继续；系统不会重复执行。</p>}
        {operation.status === "failed" && <p role="alert" className="text-ui text-destructive">{operation.reason || "分支操作未完成。请检查项目状态后再试。"}</p>}
        {operation.status === "unknown" && <div className="space-y-3">
          <p className="text-ui text-warning">{operation.reason || "系统无法确认操作结果。请检查当前分支和本地改动，确认状态后再结束此记录。"}</p>
          <label className="flex items-start gap-2 text-ui"><Checkbox aria-label="确认已核对当前分支" checked={acknowledged} onCheckedChange={(value) => setAcknowledged(value === true)} />我已核对当前分支和本地改动</label>
        </div>}
      </section>}
    </div>
    <DialogFooter>
      <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{operation?.status === "running" ? "关闭并继续" : "取消"}</Button>
      {error && !context && <Button variant="outline" disabled={busy} onClick={refresh}>重试读取</Button>}
      {context && !operation && !readonly && <Button disabled={!canPrepare} onClick={() => void prepare()}>{busy ? "正在创建并切换…" : mode === "create" ? "创建并切换" : "继续"}</Button>}
      {operation?.status === "prepared" && <Button disabled={busy || readonly || operation.sessionId !== session.id} onClick={() => void execute()}>{busy ? "正在执行…" : operationKind === "create_branch" ? "确认创建" : "确认切换"}</Button>}
      {operation?.status === "unknown" && <Button disabled={busy || !acknowledged} onClick={() => void acknowledge()}>已核对当前分支</Button>}
      {operation?.status === "failed" && <Button disabled={busy} onClick={refresh}>返回分支选择</Button>}
    </DialogFooter>
  </DialogContent></Dialog>;
}
