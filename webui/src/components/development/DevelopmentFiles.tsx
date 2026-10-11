import { useEffect, useRef, useState } from "react";
import { ArrowLeft, FileCode2, Folder, Link2, RefreshCw, Save, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { developmentApi, type DevProject, type DirectoryEntry } from "@/lib/development-api";
import { fileKey, useDevelopmentStore } from "./store";

export function DevelopmentFiles({ project, sessionId }: { project: DevProject; sessionId: string }) {
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const generation = useRef(0);
  const fileGeneration = useRef(0);
  const selected = useDevelopmentStore((s) => s.selectedFiles[sessionId]);
  const buffer = useDevelopmentStore((s) => selected ? s.files[fileKey(sessionId, selected)] : undefined);
  const dirty = !!buffer && buffer.file.content !== buffer.draft;
  const relatedTasks = (buffer?.file.fileActivity?.tasks ?? []).filter((task) => task.sessionId !== sessionId);
  const loadDirectory = async (path: string, offset = 0) => {
    const request = ++generation.current;
    setBusy(true); setError("");
    try {
      const page = await developmentApi.directory(project.id, path, offset);
      if (request === generation.current) {
        setDirectory(path); setEntries((old) => offset ? [...old, ...page.entries] : page.entries); setNext(page.nextOffset);
      }
    } catch (e) { if (request === generation.current) setError(e instanceof Error ? e.message : "目录读取失败"); }
    finally { if (request === generation.current) setBusy(false); }
  };
  useEffect(() => {
    void loadDirectory("");
    return () => { generation.current += 1; fileGeneration.current += 1; };
  }, [project.id, sessionId]);
  const openFile = async (path: string, reload = false) => {
    setError("");
    const request = ++fileGeneration.current;
    const store = useDevelopmentStore.getState();
    if (!reload && store.files[fileKey(sessionId, path)]) {
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
  const save = async () => {
    if (!buffer || saving) return;
    const { file, draft } = buffer;
    setSaving(true); setError("");
    try {
      const result = await developmentApi.saveFile(project.id, file, draft);
      const state = useDevelopmentStore.getState();
      const newer = state.files[fileKey(sessionId, file.path)]?.draft;
      useDevelopmentStore.setState({ files: { ...state.files, [fileKey(sessionId, file.path)]: {
        file: result, draft: newer !== undefined && newer !== draft ? newer : result.content,
      } } });
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败，编辑草稿仍保留"); }
    finally { setSaving(false); }
  };
  return <div className="flex h-full min-h-0 flex-col bg-background">
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="上一级目录" disabled={!directory || busy}
        onClick={() => void loadDirectory(directory.split("/").slice(0, -1).join("/"))}><ArrowLeft className="h-3.5 w-3.5" /></Button>
      <span className="min-w-0 flex-1 truncate text-caption" title={directory || project.rootPath}>{directory || project.displayName}</span>
      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="刷新文件目录" disabled={busy} onClick={() => void loadDirectory(directory)}><RefreshCw className="h-3.5 w-3.5" /></Button>
    </div>
    {error && <p role="alert" className="shrink-0 px-3 py-2 text-caption text-destructive">{error}</p>}
    <div className="max-h-48 min-h-20 shrink-0 overflow-auto border-b border-border/60 py-1">
      {!entries.length && !error && <p className="px-3 py-2 text-caption text-muted-foreground">{busy ? "正在读取…" : "此目录为空"}</p>}
      {entries.map((entry) => <button key={entry.path} type="button" title={entry.path}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui hover:bg-muted/50 disabled:opacity-60"
        disabled={entry.kind === "link"}
        onClick={() => entry.kind === "directory" ? void loadDirectory(entry.path) : void openFile(entry.path)}>
        {entry.kind === "directory" ? <Folder className="h-3.5 w-3.5 shrink-0" /> : entry.kind === "link" ? <Link2 className="h-3.5 w-3.5 shrink-0" /> : <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <span className="truncate">{entry.name}</span>{entry.kind === "link" && <span className="ml-auto text-micro text-muted-foreground">链接</span>}
      </button>)}
      {next !== null && <Button variant="ghost" size="sm" className="w-full" disabled={busy} onClick={() => void loadDirectory(directory, next)}>加载更多目录项</Button>}
    </div>
    {buffer ? <>
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-caption" title={selected}>{dirty ? "● " : ""}{selected}</span>
        {!!relatedTasks.length && <span className="flex h-7 w-7 shrink-0 items-center justify-center text-warning" role="img" aria-label="此文件有并行修改活动"
          title={`读取时，其他未结束任务也涉及此文件：${relatedTasks.map((task) => task.title).join("、")}。保存时仍会核对实际文件版本。`}><TriangleAlert className="h-3.5 w-3.5" /></span>}
        <Button variant="ghost" size="sm" className="h-7" onClick={() => useDevelopmentStore.getState().appendDraft(sessionId, `请参考项目文件：${selected}`)}>引用</Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="重新读取文件" onClick={() => dirty ? setReloadConfirm(true) : void openFile(buffer.file.path, true)}><RefreshCw className="h-3.5 w-3.5" /></Button>
        <Button variant="outline" size="sm" className="h-7 gap-1" disabled={!dirty || saving} onClick={() => void save()}><Save className="h-3 w-3" />{saving ? "保存中" : "保存"}</Button>
      </div>
      <Textarea aria-label="项目文件编辑器" value={buffer.draft} spellCheck={false}
        onChange={(e) => useDevelopmentStore.getState().editFile(sessionId, buffer.file.path, e.target.value)}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); void save(); } }}
        className="min-h-0 flex-1 resize-none rounded-none border-0 bg-editor-surface font-mono text-ui focus-visible:ring-inset" />
    </> : <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-ui text-muted-foreground">选择文件以查看或编辑。文件修改不会改变开发会话。</div>}
    <Dialog open={reloadConfirm} onOpenChange={setReloadConfirm}>
      <DialogContent><DialogHeader><DialogTitle>重新读取文件？</DialogTitle><DialogDescription>这会替换当前文件尚未保存的编辑草稿，不影响磁盘文件和其他任务。</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setReloadConfirm(false)}>保留草稿</Button><Button onClick={() => { setReloadConfirm(false); if (selected) void openFile(selected, true); }}>重新读取</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
