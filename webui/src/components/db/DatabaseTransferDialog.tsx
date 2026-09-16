import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { StatusNotice } from "@/components/ui/status-notice";
import { dbBackupDatabase, dbRestoreDatabase } from "./ipc";
import { useDbStore } from "./store/dbStore";
import { hasPendingEdits } from "./table-sql";

export type DatabaseExportMode = "all" | "structure" | "data";

export function DatabaseTransferDialog({ connectionId, database, mode, exportMode = "all", onClose }: {
  connectionId: string; database: string; mode: "export" | "import"; exportMode?: DatabaseExportMode; onClose: () => void;
}) {
  const connection = useDbStore((s) => s.activeConnections.find((c) => c.id === connectionId));
  const [file, setFile] = useState<string | null>(null);
  const [includeDdl, setIncludeDdl] = useState(exportMode !== "data");
  const [includeData, setIncludeData] = useState(exportMode !== "structure");
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const pending = useRef(false);
  const sqlite = connection?.config.db_type === "sqlite";
  const importing = mode === "import";
  async function chooseFile() {
    setChoosing(true); setError(null);
    try {
      const dialog = await import("@tauri-apps/plugin-dialog");
      const selected = importing
        ? await dialog.open({ multiple: false, title: "选择 SQL 文件", filters: [{ name: "SQL", extensions: ["sql"] }] })
        : await dialog.save({ title: "导出数据库", defaultPath: `${database}${exportMode === "all" ? "" : `_${exportMode}`}.${sqlite ? "db" : "sql"}`, filters: [{ name: sqlite ? "SQLite" : "SQL", extensions: [sqlite ? "db" : "sql"] }] });
      if (typeof selected === "string") setFile(selected);
    } catch (reason) { setError(String(reason)); }
    finally { setChoosing(false); }
  }
  async function run() {
    if (!file || pending.current || (!importing && !includeDdl && !includeData)) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const state = useDbStore.getState();
      if (!state.activeConnections.some((c) => c.id === connectionId)) throw new Error("连接已断开，请重新连接后重试。");
      if (importing && state.queryTabs.some((tab) => tab.connectionId === connectionId && tab.database === database && (tab.isExecuting || tab.isSaving || hasPendingEdits(tab)))) {
        throw new Error("该数据库仍有正在执行的操作或未保存的修改，请先处理后再导入。");
      }
      if (importing) {
        await dbRestoreDatabase(connectionId, database, file);
        await state.refreshTree(connectionId);
      } else await dbBackupDatabase(connectionId, database, file, includeDdl, includeData);
      setDone(true);
    } catch (reason) { setError(String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy && !choosing) onClose(); }}><DialogContent className="max-w-lg">
    <DialogHeader><DialogTitle>{importing ? "导入 SQL 文件" : "导出数据库"}</DialogTitle><DialogDescription>{connection?.config.name ?? "连接已断开"} / {database}</DialogDescription></DialogHeader>
    <div className="space-y-3">
      {!importing && !sqlite && <div className="flex gap-5 text-caption">
        <label className="flex items-center gap-2"><Checkbox checked={includeDdl} disabled={busy || done} onCheckedChange={(checked) => setIncludeDdl(checked === true)} />表结构</label>
        <label className="flex items-center gap-2"><Checkbox checked={includeData} disabled={busy || done} onCheckedChange={(checked) => setIncludeData(checked === true)} />表数据</label>
      </div>}
      {!importing && sqlite && <p className="text-caption text-muted-foreground">导出 SQLite 数据库文件。</p>}
      {importing && <StatusNotice tone="warning">将以 {database} 为默认数据库执行文件中的 SQL，可能覆盖现有数据。SQL 中显式指定的库名仍以文件为准。</StatusNotice>}
      <div className="flex items-start gap-2"><p className="min-w-0 flex-1 select-text break-all rounded-md border border-border px-3 py-2 text-caption">{file ?? (importing ? "尚未选择 SQL 文件" : "尚未选择保存位置")}</p>
        <Button variant="outline" disabled={busy || choosing || done} onClick={() => { void chooseFile(); }}>{choosing ? "选择中…" : "选择文件"}</Button></div>
      {error && <p role="alert" className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-caption text-destructive">{error}</p>}
      {done && <p role="status" className="text-caption text-success">{importing ? "导入完成，数据库列表已刷新。" : "导出完成。"}</p>}
    </div>
    <DialogFooter><Button variant="ghost" disabled={busy || choosing} onClick={onClose}>{done ? "关闭" : "取消"}</Button>
      {!done && <Button disabled={!connection || busy || choosing || !file || (!importing && !includeDdl && !includeData)} onClick={() => { void run(); }}>{busy ? (importing ? "导入中…" : "导出中…") : importing ? "导入" : "导出"}</Button>}
    </DialogFooter>
  </DialogContent></Dialog>;
}
