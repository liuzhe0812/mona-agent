import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTerminalStore } from "../store/terminalStore";

export function SshPasswordDialog() {
  const dialog = useTerminalStore((s) => s.sshPasswordDialog);
  const closeSshPasswordDialog = useTerminalStore(
    (s) => s.closeSshPasswordDialog,
  );
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  const handleClose = () => {
    dialog.onCancel();
    closeSshPasswordDialog();
    setPassword("");
    setError("");
    setConnecting(false);
  };

  const handleConfirm = async () => {
    if (!password) return;
    setConnecting(true);
    setError("");
    try {
      await dialog.onConfirm(password);
      closeSshPasswordDialog();
      setPassword("");
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/i, ""));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Dialog open={dialog.open} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>SSH 密码认证</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-body text-muted-foreground">
            连接到{" "}
            <span className="font-mono text-foreground">
              {dialog.username}@{dialog.host}
            </span>
            {dialog.port !== 22 && (
              <span className="font-mono text-foreground">
                :{dialog.port}
              </span>
            )}
          </div>
          <Input
            type="password"
            placeholder="输入密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && password && !connecting) {
                handleConfirm();
              }
            }}
            autoFocus
          />
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-caption text-destructive">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={connecting}>
            取消
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!password || connecting}
          >
            {connecting ? "连接中…" : "连接"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
