import { useEffect, useRef, useState } from "react";
import { HardDrive, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { buildStorageAnalysisContext, buildStorageDirectoryAnalysisContext, buildStorageFileAnalysisContext, requestStorageAnalysis, type StorageAnalysisContext, type StorageAssessment, type SystemAnalysisRequest } from "./systemAgentApi";
import { formatStorage, type CleanupItem, type DirectorySize, type StorageScanResult, type useStorageScan } from "./useSystemData";

interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  assessment?: StorageAssessment;
  scanId?: string;
  drive?: string;
  consumed?: boolean;
  labels?: Record<string, string>;
  directories?: Record<string, string>;
  scopeId?: string;
  fileId?: string;
  directoryId?: string;
}

function findDirectoryById(directories: DirectorySize[], id: string): DirectorySize | null {
  for (const directory of directories) {
    if (directory.id === id) return directory;
    const child = findDirectoryById(directory.children ?? [], id);
    if (child) return child;
  }
  return null;
}

export function StorageConversation({ storage, selection, analysisRequest, onFileAnalysisChange }: {
  storage: ReturnType<typeof useStorageScan>;
  selection: DirectorySize | null;
  analysisRequest?: SystemAnalysisRequest | null;
  onFileAnalysisChange?: (fileId: string | null) => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [stage, setStage] = useState("");
  const [confirmation, setConfirmation] = useState<{ turnId: string; targets: CleanupItem[]; drive: string; scanId: string } | null>(null);
  const [failure, setFailure] = useState<{ title: string; detail: string } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const scanningRef = useRef(false);
  const analysisNonce = useRef<number | null>(null);
  const targetContextRef = useRef<{ context: StorageAnalysisContext; scanId: string; drive: string; fileId?: string; directoryId?: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    requestRef.current?.abort();
    onFileAnalysisChange?.(null);
  }, [onFileAnalysisChange]);
  useEffect(() => { bottomRef.current?.scrollIntoView?.({ block: "nearest" }); }, [turns, pending]);

  const reply = (content: string, extra: Partial<Turn> = {}) => setTurns((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content, ...extra }]);
  const send = async (goal: string, requested?: SystemAnalysisRequest) => {
    if (!goal.trim() || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(true);
    try {
      let snapshot: StorageScanResult | null = storage.result;
      let targetContext = targetContextRef.current;
      if (requested?.fileId) {
        const file = snapshot && snapshot.scanId === requested.scanId ? snapshot.topFiles?.find((item) => item.id === requested.fileId) : undefined;
        if (!snapshot || !file) throw new Error("这个文件的扫描结果已更新，请从当前列表重新分析。");
        targetContext = { context: buildStorageFileAnalysisContext(snapshot, file), scanId: snapshot.scanId, drive: storage.selectedDrive, fileId: file.id };
        targetContextRef.current = targetContext;
      } else if (requested?.directoryId) {
        const directory = snapshot && snapshot.scanId === requested.scanId ? findDirectoryById(snapshot.directories, requested.directoryId) : null;
        if (!snapshot || !directory) throw new Error("这个目录的扫描结果已更新，请从当前目录重新分析。");
        targetContext = { context: buildStorageDirectoryAnalysisContext(snapshot, directory), scanId: snapshot.scanId, drive: storage.selectedDrive, directoryId: directory.id };
        targetContextRef.current = targetContext;
      } else if (requested) {
        targetContext = null;
        targetContextRef.current = null;
      }
      onFileAnalysisChange?.(targetContext?.fileId ?? null);
      const history = (requested ? [] : turns.filter((turn) => turn.fileId === targetContext?.fileId && turn.directoryId === targetContext?.directoryId && (!targetContext || turn.scanId === targetContext.scanId)))
        .map(({ role, content }) => ({ role, content }));
      setTurns((current) => [...current, {
        id: crypto.randomUUID(), role: "user",
        content: requested?.fileId ? `分析文件「${targetContext!.context.scopeName}」的用途及是否可以清理` : requested?.directoryId ? `分析目录「${targetContext!.context.evidence.selectedDirectory!.name}」的作用、占用和清理办法` : goal,
        ...(targetContext ? { fileId: targetContext.fileId, directoryId: targetContext.directoryId, scanId: targetContext.scanId, drive: targetContext.drive } : {}),
      }]);
      if (!snapshot && !targetContext) {
        if (storage.status === "scanning") {
          reply("当前磁盘正在扫描，完成后可以结合实际占用继续提问。");
          return;
        }
        setStage("正在扫描磁盘");
        scanningRef.current = true;
        snapshot = await storage.start();
        scanningRef.current = false;
        controller.signal.throwIfAborted();
        if (!snapshot) throw new Error("本次扫描未完成，请重新扫描后再试。");
      }
      setStage("正在回答");
      const context = targetContext?.context ?? buildStorageAnalysisContext(snapshot!, selection);
      const scanId = targetContext?.scanId ?? snapshot!.scanId;
      const assessment = await requestStorageAnalysis(goal, context.evidence, controller.signal, history);
      controller.signal.throwIfAborted();
      if (assessment.scanId !== scanId) throw new Error("扫描结果已更新，请重新提问。");
      const content = [assessment.summary, ...assessment.findings.map((finding) => finding.detail).filter((text) => text !== assessment.summary), ...assessment.cautions].join("\n\n");
      const localDirectories = targetContext ? [] : [...snapshot!.directories, ...(selection?.children ?? []), ...(selection ? [selection] : [])];
      reply(content, {
        assessment: targetContext ? undefined : assessment, scanId, drive: targetContext?.drive ?? storage.selectedDrive,
        fileId: targetContext?.fileId,
        directoryId: targetContext?.directoryId,
        labels: context.labels,
        scopeId: context.evidence.scope.id,
        directories: Object.fromEntries(localDirectories.map((directory) => [directory.id, directory.path])),
      });
    } catch (error) {
      if (!controller.signal.aborted) setFailure({ title: "暂时无法回答这个问题", detail: error instanceof Error ? error.message : String(error) });
    } finally {
      if (requestRef.current === controller) {
        scanningRef.current = false;
        requestRef.current = null;
        setPending(false);
        setStage("");
        onFileAnalysisChange?.(null);
      }
    }
  };

  useEffect(() => {
    if (!analysisRequest || analysisNonce.current === analysisRequest.nonce) return;
    analysisNonce.current = analysisRequest.nonce;
    stop();
    void send(analysisRequest.goal, analysisRequest);
  }, [analysisRequest]); // 请求的 nonce 表示一次用户发起的提问。

  const stop = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    if (scanningRef.current) void storage.cancel();
    scanningRef.current = false;
    setPending(false);
    setStage("");
    onFileAnalysisChange?.(null);
  };

  const clean = async () => {
    if (!confirmation) return;
    const { turnId, targets } = confirmation;
    setConfirmation(null);
    if (confirmation.drive !== storage.selectedDrive || confirmation.scanId !== storage.result?.scanId) {
      setFailure({ title: "清理内容已变化", detail: "请查看当前清理项目后重新确认。" });
      return;
    }
    setTurns((current) => current.map((turn) => turn.id === turnId ? { ...turn, consumed: true } : turn));
    try {
      const result = await storage.clean(targets.map((item) => item.id));
      if (result.failures.length) setFailure({ title: "部分内容未能清理", detail: `实际释放 ${formatStorage(result.freedGb)}。\n${result.failures.join("\n")}` });
      else reply(`${confirmation.drive} ${targets.map((item) => item.name).join("、")}清理完成，实际释放 ${formatStorage(result.freedGb)}。`);
    } catch (error) { setFailure({ title: "无法确认清理结果", detail: `请重新扫描确认剩余内容后再重试。\n${String(error)}` }); }
  };

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 scrollbar-hover">
      {!turns.length && <p className="py-3 text-caption leading-relaxed text-muted-foreground">可以问 Mona 空间用在哪里，或直接告诉我想清理什么。</p>}
      <div role="log" aria-label="存储空间对话" className="space-y-5">
        {turns.map((turn) => {
          const displayContent = Object.entries(turn.labels ?? {}).reduce((text, [id, label]) => text.replaceAll(id, label), turn.content);
          const directoryId = turn.assessment?.findings.find((finding) => finding.action === "inspect_directory")?.targetIds.find((id) => turn.directories?.[id]);
          const targets = (storage.result?.cleanupItems ?? []).filter((item) => item.id !== "trash" && item.cleanable && item.sizeGb > 0 && turn.assessment?.findings.some((finding) => finding.action === "plan_cleanup" && finding.targetIds.includes(item.id)));
          const eligible = turn.scanId === storage.result?.scanId && turn.drive === storage.selectedDrive && (turn.fileId || turn.directoryId || turn.scopeId === (selection?.id ?? `storage-root-${storage.result?.scanId}`));
          const busy = targets.some((item) => storage.cleaningIds.has(item.id));
          return <div key={turn.id} className={turn.role === "user" ? "ml-8 rounded-lg bg-muted/50 px-3 py-2 text-caption" : "text-caption leading-relaxed"}>
            {turn.role === "assistant" && <p className="mb-1 font-medium">Mona</p>}
            {turn.scanId && !eligible && <p className="mb-1 text-micro text-muted-foreground">以下回答基于 {turn.drive} 的先前扫描范围。</p>}
            <p className="whitespace-pre-wrap break-words">{displayContent}</p>
            {directoryId && <Button variant="text" size="sm" className="mt-2 px-0" disabled={!eligible} onClick={() => void invoke("system_open_in_explorer", { path: turn.directories![directoryId] }).catch((error) => setFailure({ title: "无法打开目录", detail: String(error) }))}>打开{turn.labels?.[directoryId] ?? "目录"}</Button>}
            {targets.length > 0 && <Button variant="text" size="sm" className="mt-2 px-0" disabled={!eligible || busy || turn.consumed} aria-busy={busy} onClick={() => setConfirmation({ turnId: turn.id, targets, drive: turn.drive!, scanId: turn.scanId! })}>{busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}{busy ? "清理中" : turn.consumed ? "已发起清理" : `清理${targets.map((item) => item.name).join("、")}`}</Button>}
            {turn.assessment?.findings.some((finding) => finding.action === "review_files") && <Button variant="text" size="sm" className="mt-2 px-0" disabled={!eligible} onClick={() => document.getElementById("storage-large-files")?.click()}>查看大文件</Button>}
            {turn.assessment?.findings.some((finding) => finding.action === "plan_cleanup" && finding.targetIds.includes("trash")) && <Button variant="text" size="sm" className="mt-2 px-0" disabled={!eligible} onClick={() => void invoke("system_open_in_explorer", { path: "shell:RecycleBinFolder" }).catch((error) => setFailure({ title: "无法打开回收站", detail: String(error) }))}>查看回收站内容</Button>}
          </div>;
        })}
        {pending && <p role="status" className="flex items-center gap-2 text-caption text-muted-foreground">{scanningRef.current ? <HardDrive className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin text-info" />}{stage}</p>}
        <div ref={bottomRef} />
      </div>
    </div>
    <div className="shrink-0 p-3"><ThreadComposer onSend={(content) => send(content)} placeholder="继续提问，或告诉 Mona 接下来做什么…" inputLabel="存储空间问题" sendLabel="发送给 Mona" stopLabel="停止任务" isStreaming={pending} sendDisabled={pending} onStop={stop} attachmentsEnabled={false} /></div>
    <AlertDialog open={confirmation !== null} onOpenChange={(open) => { if (!open) setConfirmation(null); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认清理</AlertDialogTitle><AlertDialogDescription>将直接删除{confirmation?.targets.map((item) => item.name).join("、")}，预计释放 {formatStorage(confirmation?.targets.reduce((sum, item) => sum + item.sizeGb, 0) ?? 0)}，不经过回收站。正在使用的文件会自动跳过。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><Button variant="destructive" onClick={() => void clean()}>确认清理</Button></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={failure !== null} onOpenChange={(open) => { if (!open) setFailure(null); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{failure?.title}</AlertDialogTitle><AlertDialogDescription>可以继续提问，或查看左侧内容后重试。</AlertDialogDescription></AlertDialogHeader><details className="text-caption"><summary>查看详情</summary><pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{failure?.detail}</pre></details><AlertDialogFooter><AlertDialogCancel>关闭</AlertDialogCancel></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </div>;
}
