import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { sshConnectWithId, vncConnect } from "../ipc";
import { useTerminalStore } from "../store/terminalStore";
import type { AuthConfig, ConnectionConfig } from "../types/terminal";
import type { HostKeyDialogState } from "../store/terminalStore";

type ConnectionType = "ssh" | "sftp" | "vnc";

interface SshFormState {
  host: string;
  port: number;
  username: string;
  authType: "password" | "key" | "agent";
  password: string;
  keyPath: string;
  passphrase: string;
  saveSession: boolean;
  sessionName: string;
}

const defaultSshForm: SshFormState = {
  host: "",
  port: 22,
  username: "",
  authType: "password",
  password: "",
  keyPath: "",
  passphrase: "",
  saveSession: true,
  sessionName: "",
};

interface VncFormState {
  host: string;
  port: number;
  password: string;
  saveSession: boolean;
  sessionName: string;
}

const defaultVncForm: VncFormState = {
  host: "",
  port: 5900,
  password: "",
  saveSession: true,
  sessionName: "",
};

export function NewConnectionDialog() {
  const open = useTerminalStore((s) => s.newConnectionDialogOpen);
  const setOpen = useTerminalStore((s) => s.setNewConnectionDialogOpen);
  const defaultType = useTerminalStore((s) => s.newConnectionDialogDefaultType);
  const addSession = useTerminalStore((s) => s.addSession);
  const addConnection = useTerminalStore((s) => s.addConnection);
  const updateSessionStatus = useTerminalStore((s) => s.updateSessionStatus);
  const showHostKeyDialog = useTerminalStore((s) => s.showHostKeyDialog);
  const saveConnection = useTerminalStore((s) => s.saveConnection);

  const [connectionType, setConnectionType] = useState<ConnectionType>(defaultType);
  const [sshForm, setSshForm] = useState<SshFormState>(defaultSshForm);
  const [vncForm, setVncForm] = useState<VncFormState>(defaultVncForm);

  useEffect(() => {
    if (open) {
      setConnectionType(defaultType);
    }
  }, [open, defaultType]);

  const resetAndClose = () => {
    setSshForm(defaultSshForm);
    setVncForm(defaultVncForm);
    setOpen(false);
  };

  const handleVncConnect = () => {
    const sessionId = crypto.randomUUID();
    const displayName =
      vncForm.sessionName.trim() || `VNC ${vncForm.host}:${vncForm.port}`;

    addSession({
      id: sessionId,
      configId: "",
      type: "vnc",
      status: "connecting",
      title: displayName,
      vncPassword: vncForm.password || undefined,
    });
    resetAndClose();

    vncConnect({
      host: vncForm.host,
      port: vncForm.port,
      password: vncForm.password || undefined,
      name: displayName,
    })
      .then((info) => {
        useTerminalStore.getState().updateSession(sessionId, {
          status: "connected",
          vncWsUrl: info.wsUrl,
          vncWsToken: info.wsToken,
        });
      })
      .catch((err) => {
        updateSessionStatus(sessionId, "error");
        console.error("VNC connect failed:", err);
      });
  };

  const handleConnect = () => {
    if (connectionType === "vnc") {
      handleVncConnect();
      return;
    }

    let config: ConnectionConfig | null = null;

    const configId = crypto.randomUUID();
    const auth = buildAuth(sshForm);
    const protocol = connectionType === "sftp" ? "sftp" : "ssh";
    const displayName =
      sshForm.sessionName.trim() ||
      `${sshForm.username}@${sshForm.host}`;
    config = {
      id: configId,
      name: displayName,
      protocol,
      host: sshForm.host,
      port: sshForm.port,
      username: sshForm.username,
      auth,
    };

    const sessionId = crypto.randomUUID();
    addConnection(config);
    addSession({
      id: sessionId,
      configId,
      type: protocol,
      status: "connecting",
      title: sshForm.host,
    });
    resetAndClose();

    const doConnect = async (connConfig: ConnectionConfig, sid: string) => {
      await sshConnectWithId(sid, connConfig);
      updateSessionStatus(sid, "connected");
    };

    doConnect(config, sessionId)
      .then(async () => {
        if (sshForm.saveSession) {
          await saveConnection(config!);
        }
      })
      .catch((err) => {
        const errMsg = String(err);
        const unknownMatch = errMsg.match(/Host key unknown:\s*(SHA256:\S+)/);
        const changedMatch = errMsg.match(
          /Host key changed: expected\s*(SHA256:\S+),\s*got\s*(SHA256:\S+)/,
        );

        if (unknownMatch && config) {
          const dialogData: Omit<HostKeyDialogState, "open"> = {
            host: sshForm.host,
            port: sshForm.port,
            type: "unknown",
            fingerprint: unknownMatch[1],
            expectedFingerprint: "",
            pendingConfig: config,
            pendingSessionId: sessionId,
            saveSession: sshForm.saveSession,
          };
          showHostKeyDialog(dialogData);
          return;
        }

        if (changedMatch && config) {
          const dialogData: Omit<HostKeyDialogState, "open"> = {
            host: sshForm.host,
            port: sshForm.port,
            type: "changed",
            fingerprint: changedMatch[2],
            expectedFingerprint: changedMatch[1],
            pendingConfig: config,
            pendingSessionId: sessionId,
            saveSession: sshForm.saveSession,
          };
          showHostKeyDialog(dialogData);
          return;
        }

        updateSessionStatus(sessionId, "error");
        console.error("Failed to connect:", errMsg);
      });
  };

  const canConnect =
    connectionType === "vnc"
      ? vncForm.host.trim() !== ""
      : sshForm.host.trim() !== "" && sshForm.username.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建连接</DialogTitle>
          <DialogDescription>选择连接类型并配置参数</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <ConnectionTypeButton
              active={connectionType === "ssh"}
              onClick={() => setConnectionType("ssh")}
              label="SSH"
            />
            <ConnectionTypeButton
              active={connectionType === "sftp"}
              onClick={() => setConnectionType("sftp")}
              label="SFTP"
            />
            <ConnectionTypeButton
              active={connectionType === "vnc"}
              onClick={() => setConnectionType("vnc")}
              label="VNC"
            />
          </div>

          {connectionType === "vnc" ? (
            <div className="space-y-3">
              <div className="grid grid-cols-[1fr_80px] gap-2">
                <Input
                  placeholder="VNC 主机地址"
                  value={vncForm.host}
                  onChange={(e) =>
                    setVncForm((f) => ({ ...f, host: e.target.value }))
                  }
                />
                <Input
                  type="number"
                  placeholder="端口"
                  value={vncForm.port}
                  onChange={(e) =>
                    setVncForm((f) => ({
                      ...f,
                      port: parseInt(e.target.value, 10) || 5900,
                    }))
                  }
                />
              </div>
              <Input
                type="password"
                placeholder="VNC 密码（可选）"
                value={vncForm.password}
                onChange={(e) =>
                  setVncForm((f) => ({ ...f, password: e.target.value }))
                }
              />
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="vnc-save-session"
                    checked={vncForm.saveSession}
                    onCheckedChange={(v) =>
                      setVncForm((f) => ({
                        ...f,
                        saveSession: v === true,
                      }))
                    }
                  />
                  <Label
                    htmlFor="vnc-save-session"
                    className="text-body cursor-pointer select-none"
                  >
                    保存会话
                  </Label>
                </div>
                {vncForm.saveSession && (
                  <Input
                    placeholder={`会话名称（默认：VNC ${vncForm.host || "主机"}）`}
                    value={vncForm.sessionName}
                    onChange={(e) =>
                      setVncForm((f) => ({
                        ...f,
                        sessionName: e.target.value,
                      }))
                    }
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-[1fr_80px] gap-2">
                <Input
                  placeholder="主机地址"
                  value={sshForm.host}
                  onChange={(e) =>
                    setSshForm((f) => ({ ...f, host: e.target.value }))
                  }
                />
                <Input
                  type="number"
                  placeholder="端口"
                  value={sshForm.port}
                  onChange={(e) =>
                    setSshForm((f) => ({
                      ...f,
                      port: parseInt(e.target.value, 10) || 22,
                    }))
                  }
                />
              </div>
              <Input
                placeholder="用户名"
                value={sshForm.username}
                onChange={(e) =>
                  setSshForm((f) => ({ ...f, username: e.target.value }))
                }
              />
              <div className="flex gap-2">
                {(["password", "key", "agent"] as const).map((t) => (
                  <AuthTypeButton
                    key={t}
                    active={sshForm.authType === t}
                    onClick={() =>
                      setSshForm((f) => ({ ...f, authType: t }))
                    }
                    label={authTypeLabel(t)}
                  />
                ))}
              </div>
              {sshForm.authType === "password" && (
                <Input
                  type="password"
                  placeholder="密码"
                  value={sshForm.password}
                  onChange={(e) =>
                    setSshForm((f) => ({ ...f, password: e.target.value }))
                  }
                />
              )}
              {sshForm.authType === "key" && (
                <div className="space-y-2">
                  <Input
                    placeholder="密钥路径"
                    value={sshForm.keyPath}
                    onChange={(e) =>
                      setSshForm((f) => ({ ...f, keyPath: e.target.value }))
                    }
                  />
                  <Input
                    type="password"
                    placeholder="密钥密码（可选）"
                    value={sshForm.passphrase}
                    onChange={(e) =>
                      setSshForm((f) => ({
                        ...f,
                        passphrase: e.target.value,
                      }))
                    }
                  />
                </div>
              )}
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="ssh-save-session"
                    checked={sshForm.saveSession}
                    onCheckedChange={(v) =>
                      setSshForm((f) => ({
                        ...f,
                        saveSession: v === true,
                      }))
                    }
                  />
                  <Label
                    htmlFor="ssh-save-session"
                    className="text-body cursor-pointer select-none"
                  >
                    保存会话
                  </Label>
                </div>
                {sshForm.saveSession && (
                  <Input
                    placeholder={`会话名称（默认：${sshForm.username ? sshForm.username + "@" : ""}${sshForm.host || "主机"}）`}
                    value={sshForm.sessionName}
                    onChange={(e) =>
                      setSshForm((f) => ({
                        ...f,
                        sessionName: e.target.value,
                      }))
                    }
                  />
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={resetAndClose}>
            取消
          </Button>
          <Button onClick={handleConnect} disabled={!canConnect}>
            连接
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionTypeButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className={cn(
        "h-auto flex-1 px-3 py-2 text-body",
        active
          ? "border-primary bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary"
          : "text-muted-foreground",
      )}
    >
      {label}
    </Button>
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
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className={cn(
        "h-auto flex-1 px-2 py-1.5 text-caption",
        active
          ? "border-primary bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary"
          : "text-muted-foreground",
      )}
    >
      {label}
    </Button>
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

function buildAuth(form: SshFormState): AuthConfig {
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
