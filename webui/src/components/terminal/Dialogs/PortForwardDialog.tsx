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
import { sshPortForward } from "../ipc";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
}

export function PortForwardDialog({ open, onOpenChange, sessionId }: Props) {
  const [forwardType, setForwardType] = useState<"local" | "remote">("local");
  const [localPort, setLocalPort] = useState("8080");
  const [remoteHost, setRemoteHost] = useState("localhost");
  const [remotePort, setRemotePort] = useState("80");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleForward = async () => {
    setLoading(true);
    setResult(null);
    try {
      const actualPort = await sshPortForward(
        sessionId,
        forwardType,
        parseInt(localPort, 10),
        remoteHost,
        parseInt(remotePort, 10),
      );
      setResult(
        forwardType === "local"
          ? `本地转发已建立: 127.0.0.1:${actualPort} → ${remoteHost}:${remotePort}`
          : `远程转发已建立: 远程:${remotePort} → 127.0.0.1:${localPort}`,
      );
    } catch (err) {
      setResult(`转发失败: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>端口转发</DialogTitle>
          <DialogDescription>
            配置 SSH 端口转发隧道
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={forwardType === "local" ? "default" : "outline"}
              onClick={() => setForwardType("local")}
            >
              本地转发 (-L)
            </Button>
            <Button
              size="sm"
              variant={forwardType === "remote" ? "default" : "outline"}
              onClick={() => setForwardType("remote")}
            >
              远程转发 (-R)
            </Button>
          </div>

          {forwardType === "local" ? (
            <div className="space-y-3">
              <div>
                <label className="text-sm text-muted-foreground">本地端口</label>
                <Input
                  type="number"
                  value={localPort}
                  onChange={(e) => setLocalPort(e.target.value)}
                  placeholder="8080"
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">远程主机</label>
                <Input
                  value={remoteHost}
                  onChange={(e) => setRemoteHost(e.target.value)}
                  placeholder="localhost"
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">远程端口</label>
                <Input
                  type="number"
                  value={remotePort}
                  onChange={(e) => setRemotePort(e.target.value)}
                  placeholder="80"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="text-sm text-muted-foreground">远程端口</label>
                <Input
                  type="number"
                  value={remotePort}
                  onChange={(e) => setRemotePort(e.target.value)}
                  placeholder="8080"
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">本地主机</label>
                <Input
                  value={remoteHost}
                  onChange={(e) => setRemoteHost(e.target.value)}
                  placeholder="127.0.0.1"
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">本地端口</label>
                <Input
                  type="number"
                  value={localPort}
                  onChange={(e) => setLocalPort(e.target.value)}
                  placeholder="80"
                />
              </div>
            </div>
          )}

          {result && (
            <div
              className={`rounded-md p-3 text-sm ${
                result.startsWith("转发失败")
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted"
              }`}
            >
              {result}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button onClick={handleForward} disabled={loading}>
            {loading ? "建立中…" : "建立转发"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
