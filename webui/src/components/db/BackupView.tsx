import { useState } from "react";
import { Download, Upload, HardDrive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { PageToolbar } from "@/components/ui/page-toolbar";
import { Select } from "@/components/ui/select";
import { StatusNotice } from "@/components/ui/status-notice";
import { cn } from "@/lib/utils";
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
      <EmptyState className="h-full" title="请先连接一个数据库" />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageToolbar
        className="h-10 border-b border-border bg-card px-3.5"
        leading={
          <>
            <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
            <div className="flex items-center gap-1 rounded-lg border border-border bg-muted p-0.5">
              {(["backup", "restore"] as BackupTab[]).map((t) => (
                <Button
                  key={t}
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setTab(t);
                    setMessage(null);
                  }}
                  className={cn(
                    "font-medium",
                    tab === t
                      ? "bg-background text-foreground shadow-sm hover:bg-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t === "backup" ? "备份" : "恢复"}
                </Button>
              ))}
            </div>
          </>
        }
      />

      <div className="flex-1 overflow-auto p-5">
        <div className="mx-auto max-w-lg space-y-4">
          <div>
            <label className="mb-1.5 block text-micro font-medium text-muted-foreground">
              目标数据库
            </label>
            <Select
              value={targetDb}
              onValueChange={(v) => setSelectedDb(v)}
              options={databases.map((db) => ({ value: db, label: db }))}
              placeholder="选择数据库"
              className="h-8 text-caption"
            />
          </div>

          {tab === "backup" && !isSqlite && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-caption">
                <Checkbox
                  checked={includeDDL}
                  onCheckedChange={(checked) => {
                    const next = checked === true;
                    if (!next && !includeData) return;
                    setIncludeDDL(next);
                  }}
                />
                表结构
                <span className="text-micro text-muted-foreground">
                  — 建表语句，恢复时重建表
                </span>
              </label>
              <label className="flex items-center gap-2 text-caption">
                <Checkbox
                  checked={includeData}
                  onCheckedChange={(checked) => {
                    const next = checked === true;
                    if (!next && !includeDDL) return;
                    setIncludeData(next);
                  }}
                />
                表数据
                <span className="text-micro text-muted-foreground">
                  — 表里的实际内容
                </span>
              </label>
              <p className="text-micro text-muted-foreground">
                至少勾选一项。只勾表结构适合迁移空库，只勾表数据适合表已存在时补充数据。
              </p>
            </div>
          )}

          {tab === "backup" && isSqlite && (
            <div className="rounded-lg border border-border/70 bg-muted/25 px-3 py-2">
              <p className="text-micro text-muted-foreground">
                SQLite 备份将直接复制数据库文件。
              </p>
            </div>
          )}

          {tab === "restore" && (
            <StatusNotice tone="warning">
              恢复操作将执行 SQL 文件中的所有语句，可能覆盖现有数据。请确认备份文件来源可信。
            </StatusNotice>
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
            <StatusNotice tone={message.type === "success" ? "success" : "danger"}>
              {message.text}
            </StatusNotice>
          )}
        </div>
      </div>
    </div>
  );
}
