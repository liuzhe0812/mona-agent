import { useState } from "react";
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
import { sshConnect } from "../ipc";
import { useTerminalStore } from "../store/terminalStore";
import type { AuthConfig, ConnectionConfig } from "../types/terminal";
import type { HostKeyDialogState } from "../store/terminalStore";

type ConnectionType = "ssh" | "sftp";

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

export function NewConnectionDialog() {
  const open = useTerminalStore((s) => s.newConnectionDialogOpen);
  const setOpen = useTerminalStore((s) => s.setNewConnectionDialogOpen);
  const addSession = useTerminalStore((s) => s.addSession);
  const addConnection = useTerminalStore((s) => s.addConnection);
  const showHostKeyDialog = useTerminalStore((s) => s.showHostKeyDialog);
  const saveConnection = useTerminalStore((s) => s.saveConnection);

  const [connectionType, setConnectionType] = useState<ConnectionType>("ssh");
  const [sshForm, setSshForm] = useState<SshFormState>(defaultSshForm);
  const [connecting, setConnecting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const resetAndClose = () => {
    setConnectionType("ssh");
    setSshForm(defaultSshForm);
    setConnecting(false);
    setErrorMsg("");
    setOpen(false);
  };

  const handleConnect = async () => {
    setConnecting(true);
    setErrorMsg("");

    let config: ConnectionConfig | null = null;

    try {
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
      addConnection(config);

      const sessionId = await sshConnect(config);
      addSession({
        id: sessionId,
        configId,
        type: protocol,
        status: "connected",
        title: sshForm.host,
      });

      if (sshForm.saveSession) {
        await saveConnection(config);
      }
      resetAndClose();
    } catch (err) {
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
          saveSession: sshForm.saveSession,
        };
        showHostKeyDialog(dialogData);
        resetAndClose();
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
          saveSession: sshForm.saveSession,
        };
        showHostKeyDialog(dialogData);
        resetAndClose();
        return;
      }

      setErrorMsg(errMsg.replace(/^Error:\s*/i, ""));
      setConnecting(false);
    }
  };

  const canConnect = sshForm.host.trim() !== "" && sshForm.username.trim() !== "";

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
          </div>

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
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={sshForm.saveSession}
                    onChange={(e) =>
                      setSshForm((f) => ({
                        ...f,
                        saveSession: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span>保存会话</span>
                </label>
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
        </div>

        {errorMsg && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errorMsg}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={resetAndClose}>
            取消
          </Button>
          <Button onClick={handleConnect} disabled={!canConnect || connecting}>
            {connecting ? "连接中…" : "连接"}
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
    <button
      onClick={onClick}
      className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-input bg-background text-muted-foreground hover:bg-accent"
      }`}
    >
      {label}
    </button>
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
