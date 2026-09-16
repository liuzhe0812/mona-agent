import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useDbStore } from "./store/dbStore";
import { quoteIdentifier } from "./table-sql";
import { dbExecuteQuery } from "./ipc";

export function NewTableDialog({ connectionId, database, onClose, onCreated }: {
  connectionId: string; database: string; onClose: () => void; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const state = useDbStore.getState();
      const connection = state.activeConnections.find((c) => c.id === connectionId);
      if (!connection) throw new Error("连接已断开，请重新连接后创建。");
      const sqlite = connection.config.db_type === "sqlite";
      const target = `${quoteIdentifier(database, sqlite)}.${quoteIdentifier(name.trim(), sqlite)}`;
      const definition = sqlite ? "id INTEGER PRIMARY KEY AUTOINCREMENT" : "id INT AUTO_INCREMENT PRIMARY KEY";
      await dbExecuteQuery(connectionId, `CREATE TABLE ${target} (${definition})`, undefined, database);
      void state.refreshTree(connectionId);
      onCreated(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="max-w-md">
    <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <DialogHeader><DialogTitle>新建表</DialogTitle><DialogDescription>在 {database} 中创建包含自增 id 主键的基础表，后续可编辑结构。</DialogDescription></DialogHeader>
      <label className="my-4 block space-y-2 text-caption">表名<Input autoFocus aria-label="表名" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      {error && <p role="alert" className="mb-3 text-caption text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !name.trim()}>{busy ? "创建中…" : "创建"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
