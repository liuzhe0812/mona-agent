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
import { sshTrustHostKey, sshConnect } from "../ipc";
import { useTerminalStore } from "../store/terminalStore";
import type { ConnectionConfig } from "../types/terminal";

export function HostKeyConfirmDialog() {
  const dialog = useTerminalStore((s) => s.hostKeyDialog);
  const closeHostKeyDialog = useTerminalStore((s) => s.closeHostKeyDialog);
  const addSession = useTerminalStore((s) => s.addSession);
  const addConnection = useTerminalStore((s) => s.addConnection);
  const saveConnection = useTerminalStore((s) => s.saveConnection);
  const showSshPasswordDialog = useTerminalStore((s) => s.showSshPasswordDialog);
  const [trusting, setTrusting] = useState(false);
  const [error, setError] = useState("");

  if (!dialog.pendingConfig) return null;

  const isChanged = dialog.type === "changed";

  const handleTrust = async () => {
    const config = dialog.pendingConfig;
    if (!config) return;

    setTrusting(true);
    setError("");
    try {
      await sshTrustHostKey(dialog.host, dialog.port);

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
        if (dialog.saveSession) {
          await saveConnection(connConfig);
        }
        closeHostKeyDialog();
      };

      try {
        await tryConnect(config);
      } catch (err) {
        const errMsg = String(err);
        const keyringMatch = errMsg.match(/keyring/i);
        const authFailedMatch = errMsg.match(/authentication failed/i);

        if (keyringMatch || authFailedMatch) {
          closeHostKeyDialog();
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
            },
            onCancel: () => {},
          });
          return;
        }
        setError(errMsg.replace(/^Error:\s*/i, ""));
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/i, ""));
    } finally {
      setTrusting(false);
    }
  };

  return (
    <Dialog open={dialog.open} onOpenChange={(open) => !open && closeHostKeyDialog()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isChanged ? "主机密钥已变更" : "未知主机密钥"}
          </DialogTitle>
          <DialogDescription>
            {isChanged
              ? "远程服务器的主机密钥与之前记录的不同，可能存在中间人攻击风险。"
              : "这是首次连接到该服务器，请验证主机密钥指纹。"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-md bg-muted p-3 space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">主机</span>
              <span className="font-mono">
                {dialog.host}:{dialog.port}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">密钥指纹</span>
              <span className="font-mono text-xs break-all">
                {dialog.fingerprint}
              </span>
            </div>
            {isChanged && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">原指纹</span>
                <span className="font-mono text-xs break-all">
                  {dialog.expectedFingerprint}
                </span>
              </div>
            )}
          </div>

          {isChanged && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive">
              ⚠️ 密钥变更可能意味着服务器被替换或存在安全风险。请仅在确认安全的情况下继续。
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={closeHostKeyDialog}>
            取消
          </Button>
          <Button
            variant={isChanged ? "destructive" : "default"}
            onClick={handleTrust}
            disabled={trusting}
          >
            {trusting ? "确认中…" : isChanged ? "信任新密钥" : "信任并连接"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
