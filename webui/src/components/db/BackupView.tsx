import { useState } from "react";
import { Download, Upload, HardDrive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDbStore } from "./store/dbStore";

type BackupTab = "backup" | "restore";

export function BackupView() {
  const selectedConnectionId = useDbStore((s) => s.selectedConnectionId);
  const selectedDatabase = useDbStore((s) => s.selectedDatabase);
  const connectionTree = useDbStore((s) => s.connectionTree);
  const activeConnections = useDbStore((s) => s.activeConnections);
  const [tab, setTab] = useState<BackupTab>("backup");
  const [selectedDb, setSelectedDb] = useState<string | null>(null);
  const [includeDDL, setIncludeDDL] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const conn = activeConnections.find((c) => c.id === selectedConnectionId);
  const isSqlite = conn?.config.db_type === "sqlite";
  const databases = selectedConnectionId
    ? (connectionTree[selectedConnectionId] ?? []).map((db) => db.name)
    : [];
  const targetDb = selectedDb ?? selectedDatabase ?? "";

  const handleBackup = async () => {
    if (!selectedConnectionId || !targetDb) return;
    setWorking(true);
    setMessage(null);

    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const savePath = await save({
        defaultPath: `${targetDb}_backup.sql`,
        title: "保存备份文件",
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (!savePath) {
        setWorking(false);
        return;
      }

      const ipc = await import("./ipc");

      if (isSqlite) {
        await ipc.dbBackupDatabase(selectedConnectionId, targetDb, savePath);
      } else {
        await ipc.dbBackupDatabase(
          selectedConnectionId,
          targetDb,
          savePath,
          includeDDL,
          includeData,
        );
      }

      setMessage({ type: "success", text: `备份成功，文件已保存至: ${savePath}` });
    } catch (e) {
      setMessage({ type: "error", text: String(e) });
    } finally {
      setWorking(false);
    }
  };

  const handleRestore = async () => {
    if (!selectedConnectionId || !targetDb) return;
    setWorking(true);
    setMessage(null);

    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        title: "选择 SQL 备份文件",
        filters: [{ name: "SQL", extensions: ["sql", "txt"] }],
      });
      if (!selected) {
        setWorking(false);
        return;
      }
      const filePath = typeof selected === "string" ? selected : String(selected);

      const ipc = await import("./ipc");
      await ipc.dbRestoreDatabase(selectedConnectionId, targetDb, filePath);

      const refreshTree = useDbStore.getState().refreshTree;
      await refreshTree(selectedConnectionId);

      setMessage({ type: "success", text: "恢复成功，数据库已更新" });
    } catch (e) {
      setMessage({ type: "error", text: String(e) });
    } finally {
      setWorking(false);
    }
  };

  if (!selectedConnectionId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        请先连接一个数据库
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-card px-3.5 py-2">
        <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted p-0.5">
          {(["backup", "restore"] as BackupTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTab(t);
                setMessage(null);
              }}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                tab === t
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "backup" ? "备份" : "恢复"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-5">
        <div className="mx-auto max-w-lg space-y-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
              目标数据库
            </label>
            <select
              value={targetDb}
              onChange={(e) => setSelectedDb(e.target.value)}
              className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-ring"
            >
              <option value="" disabled>
                选择数据库
              </option>
              {databases.map((db) => (
                <option key={db} value={db}>
                  {db}
                </option>
              ))}
            </select>
          </div>

          {tab === "backup" && !isSqlite && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={includeDDL}
                  onChange={(e) => {
                    const next = e.target.checked;
                    if (!next && !includeData) return;
                    setIncludeDDL(next);
                  }}
                  className="rounded border-border"
                />
                表结构
                <span className="text-[10px] text-muted-foreground">
                  — 建表语句，恢复时重建表
                </span>
              </label>
              <label className="flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={includeData}
                  onChange={(e) => {
                    const next = e.target.checked;
                    if (!next && !includeDDL) return;
                    setIncludeData(next);
                  }}
                  className="rounded border-border"
                />
                表数据
                <span className="text-[10px] text-muted-foreground">
                  — 表里的实际内容
                </span>
              </label>
              <p className="text-[10px] text-muted-foreground">
                至少勾选一项。只勾表结构适合迁移空库，只勾表数据适合表已存在时补充数据。
              </p>
            </div>
          )}

          {tab === "backup" && isSqlite && (
            <div className="rounded-lg border border-border/70 bg-muted/25 px-3 py-2">
              <p className="text-[11px] text-muted-foreground">
                SQLite 备份将直接复制数据库文件。
              </p>
            </div>
          )}

          {tab === "restore" && (
            <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 px-3 py-2">
              <p className="text-[11px] text-orange-500">
                ⚠️ 恢复操作将执行 SQL 文件中的所有语句，可能覆盖现有数据。请确认备份文件来源可信。
              </p>
            </div>
          )}

          <Button
            size="sm"
            disabled={!targetDb || working}
            onClick={tab === "backup" ? handleBackup : handleRestore}
          >
            {working ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : tab === "backup" ? (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <Upload className="mr-1.5 h-3.5 w-3.5" />
            )}
            {tab === "backup" ? "导出备份" : "导入恢复"}
          </Button>

          {message && (
            <div
              className={`rounded-lg border px-3 py-2 ${
                message.type === "success"
                  ? "border-green-500/30 bg-green-500/5"
                  : "border-red-500/30 bg-red-500/5"
              }`}
            >
              <p
                className={`text-[11px] ${
                  message.type === "success" ? "text-green-600" : "text-red-500"
                }`}
              >
                {message.type === "success" ? "✅" : "❌"} {message.text}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
