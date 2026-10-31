import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Copy, Link2, MessageSquarePlus, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileSystemIcon } from "@/components/ui/file-system-icon";
import { developmentApi, type DevProject, type DirectoryEntry } from "@/lib/development-api";
import { isTauri } from "@/lib/tauri";
import { DevelopmentFileEditor } from "./DevelopmentFileEditor";
import { fileKey, useDevelopmentStore } from "./store";
import { joinFilePath } from "./zcode/tools/path";

export function DevelopmentFiles({ project, sessionId }: { project: DevProject; sessionId: string }) {
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const fileGeneration = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const selected = useDevelopmentStore((s) => s.selectedFiles[sessionId]);
  const buffer = useDevelopmentStore((s) => selected ? s.files[fileKey(sessionId, selected)] : undefined);
  const editing = !!buffer;
  const dirty = !!buffer && buffer.file.content !== buffer.draft;
  const relatedTasks = (buffer?.file.fileActivity?.tasks ?? []).filter((task) => task.sessionId !== sessionId);
  const loadDirectory = async (path: string, offset = 0) => {
    if (!offset && path !== directory) fileGeneration.current += 1;
    const request = ++generation.current;
    setBusy(true); setError("");
    try {
      const page = await developmentApi.directory(project.id, path, offset);
      if (request === generation.current) {
        if (path !== directory) listScroll.current = 0;
        setDirectory(path); setEntries((old) => offset ? [...old, ...page.entries] : page.entries); setNext(page.nextOffset);
      }
    } catch (e) { if (request === generation.current) setError(e instanceof Error ? e.message : "目录读取失败"); }
    finally { if (request === generation.current) setBusy(false); }
  };
  useEffect(() => {
    void loadDirectory("");
    return () => { generation.current += 1; fileGeneration.current += 1; };
  }, [project.id, sessionId]);
  useLayoutEffect(() => {
    if (!editing && list.current) list.current.scrollTop = listScroll.current;
  }, [editing, directory]);
  const openFile = async (path: string) => {
    setError("");
    const request = ++fileGeneration.current;
    const store = useDevelopmentStore.getState();
    if (store.files[fileKey(sessionId, path)]) {
      useDevelopmentStore.setState({ selectedFiles: { ...store.selectedFiles, [sessionId]: path } });
      return;
    }
    const beforeDraft = store.files[fileKey(sessionId, path)]?.draft;
    try {
      const file = await developmentApi.file(project.id, path);
      if (request !== fileGeneration.current) return;
      const latest = useDevelopmentStore.getState().files[fileKey(sessionId, path)]?.draft;
      if (latest !== beforeDraft) { setError("读取期间编辑草稿已变化，未替换你的新修改。"); return; }
      store.loadFile(sessionId, file);
    }
    catch (e) { if (request === fileGeneration.current) setError(e instanceof Error ? e.message : "文件读取失败"); }
  };
  const returnToFiles = () => {
    fileGeneration.current += 1;
    setError("");
    useDevelopmentStore.setState((state) => {
      const selectedFiles = { ...state.selectedFiles };
      delete selectedFiles[sessionId];
      return { selectedFiles };
    });
  };
  const absolutePath = (path: string) => joinFilePath(project.rootPath,
    project.rootPath.includes("\\") ? path.replace(/\//g, "\\") : path);
  const copyPath = async (path: string) => {
    try { await navigator.clipboard.writeText(path); }
    catch { setActionError("路径复制失败，请重试。"); }
  };
  const revealEntry = async (entry: DirectoryEntry) => {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(absolutePath(entry.path));
    } catch { setActionError("无法在资源管理器中显示该文件或目录，请确认它仍然存在且可以访问。"); }
  };
  const openWithSystemApp = async (entry: DirectoryEntry) => {
    try {
      const path = absolutePath(entry.path);
      const { openPath } = await import("@tauri-apps/plugin-opener");
      try { await openPath(path); }
      catch {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("system_open_in_explorer", { path });
      }
    } catch { setActionError("无法使用系统应用打开该文件，请确认文件仍然存在且已设置默认打开应用。"); }
  };
  const save = async () => {
    if (!buffer || !dirty || saving) return;
    const { file, draft } = buffer;
    setSaving(true); setError("");
    try {
      let result;
      try {
        result = await developmentApi.saveFile(project.id, file, draft);
      } catch (cause) {
        // A lost write acknowledgement is resolved by reading, never by replaying the save.
        try { result = await developmentApi.file(project.id, file.path); }
        catch { throw new Error("保存结果暂未确认，编辑草稿仍保留。请稍后重新读取文件核对。"); }
        if (result.content !== draft || result.bom !== file.bom) throw cause;
      }
      const state = useDevelopmentStore.getState();
      const newer = state.files[fileKey(sessionId, file.path)]?.draft;
      useDevelopmentStore.setState({ files: { ...state.files, [fileKey(sessionId, file.path)]: {
        file: result, draft: newer !== undefined && newer !== draft ? newer : result.content,
      } } });
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败，编辑草稿仍保留"); }
    finally { setSaving(false); }
  };
  return <div className="flex h-full min-h-0 flex-col bg-background">
    {buffer && <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1">
      <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" aria-label="返回文件列表" onClick={returnToFiles}><ArrowLeft className="h-3.5 w-3.5" />返回</Button>
      <span className="min-w-0 flex-1 truncate text-caption" title={`${selected} · ${saving ? "保存中" : "Ctrl/Cmd+S 保存"}`}>{dirty ? "● " : ""}{selected}</span>
      {!!relatedTasks.length && <span className="flex h-7 w-7 shrink-0 items-center justify-center text-warning" role="img" aria-label="此文件有并行修改活动"
        title={`读取时，其他未结束任务也涉及此文件：${relatedTasks.map((task) => task.title).join("、")}。保存时仍会核对实际文件版本。`}><TriangleAlert className="h-3.5 w-3.5" /></span>}
      <Button variant="ghost" size="sm" className="h-7" onClick={() => useDevelopmentStore.getState().appendDraft(sessionId, `请参考项目文件：${selected}`)}>引用</Button>
    </div>}
    {error && <p role="alert" className="shrink-0 px-3 py-2 text-caption text-destructive">{error}</p>}
    {buffer ? <DevelopmentFileEditor key={fileKey(sessionId, buffer.file.path)} path={buffer.file.path} value={buffer.draft}
      onChange={(value) => useDevelopmentStore.getState().editFile(sessionId, buffer.file.path, value)}
      onSave={() => void save()} />
    : <div ref={list} role="region" aria-label="项目文件列表" className="min-h-0 flex-1 overflow-auto py-1"
      onScroll={(event) => { listScroll.current = event.currentTarget.scrollTop; }}>
      {!!directory && <button type="button" aria-label="上一级目录" disabled={busy}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-muted-foreground hover:bg-muted/50 disabled:opacity-60"
        onClick={() => void loadDirectory(directory.split("/").slice(0, -1).join("/"))}><ArrowLeft className="h-4 w-4 shrink-0" />返回上一级</button>}
      {!entries.length && !error && <p className="px-3 py-2 text-caption text-muted-foreground">{busy ? "正在读取…" : "此目录为空"}</p>}
      {entries.map((entry) => <ContextMenu key={entry.path}>
        <ContextMenuTrigger asChild><button type="button" title={entry.path} aria-disabled={entry.kind === "link"}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui hover:bg-muted/50 aria-disabled:opacity-60 data-[state=open]:bg-muted/50"
          onClick={() => { if (entry.kind === "directory") void loadDirectory(entry.path); else if (entry.kind === "file") void openFile(entry.path); }}>
          {entry.kind === "link" ? <Link2 className="h-4 w-4 shrink-0" /> : <FileSystemIcon name={entry.name} isDirectory={entry.kind === "directory"} />}
          <span className="truncate">{entry.name}</span>{entry.kind === "link" && <span className="ml-auto text-micro text-muted-foreground">链接</span>}
        </button></ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem disabled={entry.kind === "link"} onSelect={() => entry.kind === "directory" ? void loadDirectory(entry.path) : void openFile(entry.path)}>
            <FileSystemIcon name={entry.name} isDirectory={entry.kind === "directory"} />打开
          </ContextMenuItem>
          {entry.kind === "file" && <ContextMenuItem disabled={!isTauri()} onSelect={() => void openWithSystemApp(entry)}><FileSystemIcon name={entry.name} />使用系统应用打开</ContextMenuItem>}
          {entry.kind === "file" && <ContextMenuItem onSelect={() => useDevelopmentStore.getState().appendDraft(sessionId, `请参考项目文件：${entry.path}`)}><MessageSquarePlus className="h-4 w-4" />引用到当前会话</ContextMenuItem>}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void copyPath(entry.path)}><Copy className="h-4 w-4" />复制相对路径</ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyPath(absolutePath(entry.path))}><Copy className="h-4 w-4" />复制完整路径</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!isTauri() || entry.kind === "link"} onSelect={() => void revealEntry(entry)}><FileSystemIcon name="" isDirectory />在资源管理器中显示</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>)}
      {next !== null && <Button variant="ghost" size="sm" className="w-full" disabled={busy} onClick={() => void loadDirectory(directory, next)}>加载更多目录项</Button>}
    </div>}
    <Dialog open={!!actionError} onOpenChange={(open) => { if (!open) setActionError(""); }}><DialogContent>
      <DialogHeader><DialogTitle>操作未完成</DialogTitle><DialogDescription>{actionError}</DialogDescription></DialogHeader>
      <DialogFooter><Button onClick={() => setActionError("")}>知道了</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
