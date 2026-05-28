import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Shield, Trash2, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useDbStore } from "./store/dbStore";
import { displayCellValue } from "./types";

export function UsersView() {
  const selectedConnectionId = useDbStore((s) => s.selectedConnectionId);
  const users = useDbStore((s) => s.users);
  const refreshUsers = useDbStore((s) => s.refreshUsers);

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    username: string;
    host: string;
  } | null>(null);
  const [grantsTarget, setGrantsTarget] = useState<{
    username: string;
    host: string;
  } | null>(null);
  const [grants, setGrants] = useState<string[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedConnectionId) {
      refreshUsers(selectedConnectionId);
    }
  }, [selectedConnectionId, refreshUsers]);

  const handleShowGrants = useCallback(
    async (username: string, host: string) => {
      if (!selectedConnectionId) return;
      setGrantsTarget({ username, host });
      setGrantsLoading(true);
      setGrants([]);
      try {
        const ipc = await import("./ipc");
        const result = await ipc.dbExecuteQuery(
          selectedConnectionId,
          `SHOW GRANTS FOR \`${username}\`@\`${host}\``,
        );
        const lines: string[] = [];
        for (const row of result.rows) {
          for (const cell of row) {
            const val = displayCellValue(cell);
            if (val && val !== "NULL") lines.push(val);
          }
        }
        setGrants(lines);
      } catch (e) {
        setGrants([`获取权限失败: ${String(e)}`]);
      } finally {
        setGrantsLoading(false);
      }
    },
    [selectedConnectionId],
  );

  const handleDeleteUser = useCallback(
    async (username: string, host: string) => {
      if (!selectedConnectionId) return;
      setActionLoading(true);
      setActionError(null);
      try {
        const ipc = await import("./ipc");
        await ipc.dbExecuteQuery(
          selectedConnectionId,
          `DROP USER \`${username}\`@\`${host}\``,
        );
        setDeleteTarget(null);
        await refreshUsers(selectedConnectionId);
      } catch (e) {
        setActionError(String(e));
      } finally {
        setActionLoading(false);
      }
    },
    [selectedConnectionId, refreshUsers],
  );

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
        <Button variant="ghost" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          新建用户
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refreshUsers(selectedConnectionId)}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          刷新
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              {["用户名", "主机", "密码过期", "账户锁定", "操作"].map((h) => (
                <th
                  key={h}
                  className="sticky top-0 z-10 bg-muted px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr
                key={`${user.username}@${user.host}`}
                className="border-b border-border/50 hover:bg-accent"
              >
                <td className="px-2.5 py-1 font-medium">{user.username}</td>
                <td className="px-2.5 py-1 text-muted-foreground">{user.host}</td>
                <td className="px-2.5 py-1">
                  <span
                    className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                      user.password_expired
                        ? "bg-orange-500/15 text-orange-500"
                        : "bg-green-500/15 text-green-500"
                    }`}
                  >
                    {user.password_expired ? "是" : "否"}
                  </span>
                </td>
                <td className="px-2.5 py-1">
                  <span
                    className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                      user.account_locked
                        ? "bg-red-500/15 text-red-500"
                        : "bg-green-500/15 text-green-500"
                    }`}
                  >
                    {user.account_locked ? "是" : "否"}
                  </span>
                </td>
                <td className="px-2.5 py-1">
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs"
                      onClick={() => handleShowGrants(user.username, user.host)}
                    >
                      <Eye className="mr-1 h-3 w-3" />
                      权限
                    </Button>
                    {user.username !== "root" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-destructive hover:text-destructive"
                        onClick={() =>
                          setDeleteTarget({
                            username: user.username,
                            host: user.host,
                          })
                        }
                      >
                        <Trash2 className="mr-1 h-3 w-3" />
                        删除
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <div className="p-5 text-sm text-muted-foreground">暂无用户数据</div>
        )}
      </div>

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        connectionId={selectedConnectionId}
        onCreated={() => refreshUsers(selectedConnectionId)}
      />

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setActionError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>删除用户</DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            确定要删除用户{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[12px]">
              {deleteTarget?.username}@{deleteTarget?.host}
            </code>{" "}
            吗？此操作不可撤销。
          </p>
          {actionError && (
            <p className="text-sm text-destructive">{actionError}</p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDeleteTarget(null);
                setActionError(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={actionLoading}
              onClick={() => {
                if (deleteTarget) {
                  handleDeleteUser(deleteTarget.username, deleteTarget.host);
                }
              }}
            >
              {actionLoading ? "删除中..." : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!grantsTarget}
        onOpenChange={(open) => {
          if (!open) setGrantsTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>
              <Shield className="mr-2 inline h-4 w-4" />
              {grantsTarget?.username}@{grantsTarget?.host} 的权限
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[400px] overflow-auto">
            {grantsLoading ? (
              <p className="text-sm text-muted-foreground">加载中...</p>
            ) : (
              <div className="space-y-2">
                {grants.map((g, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-border/70 bg-muted/25 px-3 py-2 font-mono text-[11px] leading-5"
                  >
                    {g}
                  </div>
                ))}
                {grants.length === 0 && (
                  <p className="text-sm text-muted-foreground">无权限信息</p>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
  connectionId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  onCreated: () => void;
}) {
  const [username, setUsername] = useState("");
  const [host, setHost] = useState("%");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!username.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const ipc = await import("./ipc");
      const safeUser = username.trim();
      const safeHost = host.trim() || "%";
      const sql = password
        ? `CREATE USER \`${safeUser}\`@\`${safeHost}\` IDENTIFIED BY '${password.replace(/'/g, "''")}'`
        : `CREATE USER \`${safeUser}\`@\`${safeHost}\``;
      await ipc.dbExecuteQuery(connectionId, sql);
      setUsername("");
      setHost("%");
      setPassword("");
      onOpenChange(false);
      onCreated();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>新建用户</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
              用户名
            </label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-ring"
              placeholder="username"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
              主机
            </label>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-ring"
              placeholder="% 表示任意主机"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
              密码
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-ring"
              placeholder="可选"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            size="sm"
            disabled={!username.trim() || loading}
            onClick={handleCreate}
          >
            {loading ? "创建中..." : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
