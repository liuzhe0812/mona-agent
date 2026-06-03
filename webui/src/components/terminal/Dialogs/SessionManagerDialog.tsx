import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Copy,
  Pencil,
  Trash2,
  AlertTriangle,
  Search,
} from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { sshConnect } from "../ipc";
import type { ConnectionConfig, AuthConfig } from "../types/terminal";
import type { HostKeyDialogState } from "../store/terminalStore";

interface SessionManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type EditMode = "none" | "edit" | "copy";

interface EditForm {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key" | "agent";
  password: string;
  keyPath: string;
  passphrase: string;
}

function configToForm(config: ConnectionConfig): EditForm {
  const auth = config.auth;
  if (auth.type === "password") {
    return {
      name: config.name,
      host: config.host,
      port: config.port,
      username: config.username,
      authType: "password",
      password: "",
      keyPath: "",
      passphrase: "",
    };
  }
  if (auth.type === "key") {
    return {
      name: config.name,
      host: config.host,
      port: config.port,
      username: config.username,
      authType: "key",
      password: "",
      keyPath: auth.keyPath,
      passphrase: auth.passphrase || "",
    };
  }
  return {
    name: config.name,
    host: config.host,
    port: config.port,
    username: config.username,
    authType: "agent",
    password: "",
    keyPath: "",
    passphrase: "",
  };
}

function formToAuth(form: EditForm): AuthConfig {
  switch (form.authType) {
    case "password":
      return { type: "password", password: form.password };
    case "key":
      return {
        type: "key",
        keyPath: form.keyPath,
        passphrase: form.passphrase || undefined,
      };
    case "agent":
      return { type: "agent" };
  }
}

function mergeAuth(original: AuthConfig, form: EditForm): AuthConfig {
  if (form.authType === "password") {
    return {
      type: "password",
      password: form.password || (original.type === "password" ? original.password : ""),
    };
  }
  if (form.authType === "key") {
    return {
      type: "key",
      keyPath: form.keyPath,
      passphrase: form.passphrase || (original.type === "key" ? original.passphrase : undefined),
    };
  }
  return { type: "agent" };
}

export function SessionManagerDialog({
  open,
  onOpenChange,
}: SessionManagerDialogProps) {
  const savedConnections = useTerminalStore((s) => s.savedConnections);
  const loadSavedConnections = useTerminalStore((s) => s.loadSavedConnections);
  const saveConnection = useTerminalStore((s) => s.saveConnection);
  const deleteConnection = useTerminalStore((s) => s.deleteConnection);
  const addSession = useTerminalStore((s) => s.addSession);
  const addConnection = useTerminalStore((s) => s.addConnection);
  const showHostKeyDialog = useTerminalStore((s) => s.showHostKeyDialog);
  const showSshPasswordDialog = useTerminalStore((s) => s.showSshPasswordDialog);

  useEffect(() => {
    if (open) {
      loadSavedConnections();
    }
  }, [open, loadSavedConnections]);

  const [editMode, setEditMode] = useState<EditMode>("none");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditForm>({
    name: "",
    host: "",
    port: 22,
    username: "",
    authType: "password",
    password: "",
    keyPath: "",
    passphrase: "",
  });
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const startEdit = (config: ConnectionConfig, mode: EditMode) => {
    setEditMode(mode);
    setEditingId(mode === "edit" ? config.id : null);
    setForm(configToForm(config));
  };

  const cancelEdit = () => {
    setEditMode("none");
    setEditingId(null);
    setSearchQuery("");
    setForm({
      name: "",
      host: "",
      port: 22,
      username: "",
      authType: "password",
      password: "",
      keyPath: "",
      passphrase: "",
    });
  };

  const handleSaveEdit = async () => {
    if (!form.host.trim() || !form.username.trim()) return;

    let auth: AuthConfig;
    if (editMode === "edit" && editingId) {
      const original = savedConnections.find((c) => c.id === editingId);
      if (original) {
        auth = mergeAuth(original.auth, form);
      } else {
        auth = formToAuth(form);
      }
    } else {
      auth = formToAuth(form);
    }

    const newConfig: ConnectionConfig = {
      id: editMode === "edit" && editingId ? editingId : crypto.randomUUID(),
      name: form.name.trim() || `${form.username}@${form.host}`,
      protocol: "ssh",
      host: form.host.trim(),
      port: form.port,
      username: form.username.trim(),
      auth,
    };

    await saveConnection(newConfig);
    await loadSavedConnections();
    cancelEdit();
  };

  const handleDelete = async (id: string) => {
    await deleteConnection(id);
    await loadSavedConnections();
    setDeleteConfirmId(null);
  };

  const handleConnect = async (config: ConnectionConfig) => {
    setConnectingId(config.id);

    const tryConnect = async (connConfig: ConnectionConfig) => {
      addConnection(connConfig);
      const sessionId = await sshConnect(connConfig);
      addSession({
        id: sessionId,
        configId: connConfig.id,
        type: connConfig.protocol === "sftp" ? "sftp" : "ssh",
        status: "connected",
        title: connConfig.host,
      });
    };

    try {
      await tryConnect(config);
      onOpenChange(false);
    } catch (err) {
      const errMsg = String(err);
      const unknownMatch = errMsg.match(/Host key unknown:\s*(SHA256:\S+)/);
      const changedMatch = errMsg.match(
        /Host key changed: expected\s*(SHA256:\S+),\s*got\s*(SHA256:\S+)/,
      );
      const keyringMatch = errMsg.match(/keyring/i);
      const authFailedMatch = errMsg.match(/authentication failed/i);
      const storageUpgradeMatch = errMsg.match(/storage format|re-enter the password/i);

      if (unknownMatch) {
        const dialogData: Omit<HostKeyDialogState, "open"> = {
          host: config.host,
          port: config.port,
          type: "unknown",
          fingerprint: unknownMatch[1],
          expectedFingerprint: "",
          pendingConfig: config,
          saveSession: true,
        };
        showHostKeyDialog(dialogData);
        onOpenChange(false);
        return;
      }

      if (changedMatch) {
        const dialogData: Omit<HostKeyDialogState, "open"> = {
          host: config.host,
          port: config.port,
          type: "changed",
          fingerprint: changedMatch[2],
          expectedFingerprint: changedMatch[1],
          pendingConfig: config,
          saveSession: true,
        };
        showHostKeyDialog(dialogData);
        onOpenChange(false);
        return;
      }

      if (keyringMatch || authFailedMatch || storageUpgradeMatch) {
        showSshPasswordDialog({
          host: config.host,
          port: config.port,
          username: config.username,
          onConfirm: async (password: string) => {
            const newConfig: ConnectionConfig = {
              ...config,
              auth: { type: "password", password },
            };
            await tryConnect(newConfig);
            await saveConnection(newConfig);
          },
          onCancel: () => {},
        });
        return;
      }

      console.error("Failed to open saved connection:", errMsg);
    } finally {
      setConnectingId(null);
    }
  };

  const filteredConnections = searchQuery.trim()
    ? savedConnections.filter((c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase().trim()) ||
        c.host.toLowerCase().includes(searchQuery.toLowerCase().trim()) ||
        c.username.toLowerCase().includes(searchQuery.toLowerCase().trim()),
      )
    : savedConnections;

  const canSave = form.host.trim() !== "" && form.username.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editMode === "none"
              ? "会话管理"
              : editMode === "edit"
                ? "编辑会话"
                : "复制会话"}
          </DialogTitle>
        </DialogHeader>

        {editMode === "none" ? (
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="搜索会话..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
            <div className="space-y-1 max-h-[360px] overflow-y-auto pr-1">
              {filteredConnections.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  {searchQuery ? "未找到匹配的会话" : "暂无已保存的会话"}
                </div>
              ) : (
                filteredConnections.map((conn) => (
                  <div
                    key={conn.id}
                    className="group flex items-center gap-1 rounded-md border px-2 py-1.5 hover:bg-accent/50 transition-colors cursor-pointer"
                    onClick={() => {
                      if (connectingId !== conn.id && !deleteConfirmId) {
                        handleConnect(conn);
                      }
                    }}
                  >
                    <span className="min-w-0 flex-1 text-sm truncate">
                      {conn.name}
                    </span>
                    <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        title="复制"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit(conn, "copy");
                        }}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        title="编辑"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit(conn, "edit");
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      {deleteConfirmId === conn.id ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                            title="确认删除"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(conn.id);
                            }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            title="取消"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteConfirmId(null);
                            }}
                          >
                            <span className="text-[10px]">取消</span>
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirmId(conn.id);
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
            <Input
              placeholder="会话名称"
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
            />
            <div className="grid grid-cols-[1fr_80px] gap-2">
              <Input
                placeholder="主机地址"
                value={form.host}
                onChange={(e) =>
                  setForm((f) => ({ ...f, host: e.target.value }))
                }
              />
              <Input
                type="number"
                placeholder="端口"
                value={form.port}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    port: parseInt(e.target.value, 10) || 22,
                  }))
                }
              />
            </div>
            <Input
              placeholder="用户名"
              value={form.username}
              onChange={(e) =>
                setForm((f) => ({ ...f, username: e.target.value }))
              }
            />
            <div className="flex gap-2">
              {(["password", "key", "agent"] as const).map((t) => (
                <AuthTypeButton
                  key={t}
                  active={form.authType === t}
                  onClick={() => setForm((f) => ({ ...f, authType: t }))}
                  label={authTypeLabel(t)}
                />
              ))}
            </div>
            {form.authType === "password" && (
              <Input
                type="password"
                placeholder="密码（留空则保持原密码）"
                value={form.password}
                onChange={(e) =>
                  setForm((f) => ({ ...f, password: e.target.value }))
                }
              />
            )}
            {form.authType === "key" && (
              <div className="space-y-2">
                <Input
                  placeholder="密钥路径"
                  value={form.keyPath}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, keyPath: e.target.value }))
                  }
                />
                <Input
                  type="password"
                  placeholder="密钥密码（可选）"
                  value={form.passphrase}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, passphrase: e.target.value }))
                  }
                />
              </div>
            )}
          </div>
        )}

        {editMode === "none" && deleteConfirmId && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>点击垃圾桶图标确认删除，或点击取消</span>
          </div>
        )}

        <DialogFooter>
          {editMode === "none" ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={cancelEdit}>
                取消
              </Button>
              <Button onClick={handleSaveEdit} disabled={!canSave}>
                {editMode === "edit" ? "保存" : "创建副本"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AuthTypeButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md border px-2 py-1.5 text-xs transition-colors ${
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-input bg-background text-muted-foreground hover:bg-accent"
      }`}
    >
      {label}
    </button>
  );
}

function authTypeLabel(type: "password" | "key" | "agent"): string {
  switch (type) {
    case "password":
      return "密码";
    case "key":
      return "密钥";
    case "agent":
      return "Agent";
  }
}
