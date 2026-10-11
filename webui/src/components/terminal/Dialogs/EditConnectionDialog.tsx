import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTerminalStore } from "../store/terminalStore";
import type { AuthConfig, ConnectionConfig } from "../types/terminal";

interface Props {
  config: ConnectionConfig;
  mode: "edit" | "copy";
  onClose: () => void;
}

export function EditConnectionDialog({ config, mode, onClose }: Props) {
  const saveConnection = useTerminalStore((state) => state.saveConnection);
  const [id] = useState(() => mode === "copy" ? crypto.randomUUID() : config.id);
  const [form, setForm] = useState(() => ({
    name: mode === "copy" ? `${config.name || config.host}（副本）` : config.name,
    host: config.host,
    port: String(config.port),
    username: config.username,
    authType: (config.auth.type === "key" ? "key" : "password") as "password" | "key",
    password: "",
    keyPath: config.auth.type === "key" ? config.auth.keyPath : "",
    passphrase: "",
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const port = Number(form.port);
  // Saved credentials are scoped to the target, not the connection's display name or id.
  const sameTarget = form.host.trim() === config.host && port === config.port && form.username.trim() === config.username;
  const savedPassword = sameTarget && config.auth.type === "password" ? config.auth.password : "";
  const savedPassphrase = sameTarget && config.auth.type === "key" && form.keyPath.trim() === config.auth.keyPath
    ? config.auth.passphrase : undefined;
  const canSave = !!form.host.trim() && !!form.username.trim() && Number.isInteger(port) && port > 0 && port <= 65535
    && (form.authType === "password" ? !!(form.password || savedPassword) : !!form.keyPath.trim());

  const close = () => { if (!savingRef.current) onClose(); };
  const save = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const auth: AuthConfig = form.authType === "password"
      ? { type: "password", password: form.password || savedPassword }
      : { type: "key", keyPath: form.keyPath.trim(), passphrase: form.passphrase || savedPassphrase || undefined };
    try {
      await saveConnection({
        ...config, id, name: form.name.trim() || `${form.username.trim()}@${form.host.trim()}`,
        host: form.host.trim(), port, username: form.username.trim(), auth,
      });
      onClose();
    } catch {
      setError("保存连接失败，请重试。原连接未更改。");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{mode === "copy" ? "复制会话" : "编辑会话"}</DialogTitle></DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-4">
          <fieldset disabled={saving} className="min-w-0 space-y-3">
            <Input aria-label="会话名称" placeholder="会话名称" value={form.name}
              onChange={(event) => setForm((old) => ({ ...old, name: event.target.value }))} />
            <div className="grid grid-cols-[1fr_80px] gap-2">
              <Input aria-label="主机地址" placeholder="主机地址" value={form.host}
                onChange={(event) => setForm((old) => ({ ...old, host: event.target.value }))} />
              <Input aria-label="端口" type="number" min={1} max={65535} step={1} placeholder="端口" value={form.port}
                onChange={(event) => setForm((old) => ({ ...old, port: event.target.value }))} />
            </div>
            <Input aria-label="用户名" placeholder="用户名" autoComplete="off" value={form.username}
              onChange={(event) => setForm((old) => ({ ...old, username: event.target.value }))} />
            <div className="flex gap-2" role="group" aria-label="认证方式">
              {(["password", "key"] as const).map((type) => (
                <Button key={type} type="button" variant="outline" aria-pressed={form.authType === type}
                  className={cn("h-8 flex-1", form.authType === type ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground")}
                  onClick={() => setForm((old) => ({ ...old, authType: type }))}>
                  {type === "password" ? "密码" : "密钥"}
                </Button>
              ))}
            </div>
            {form.authType === "password" ? (
              <Input aria-label="密码" type="password" autoComplete="new-password" value={form.password}
                placeholder={savedPassword ? "密码（留空则保持原密码）" : "密码"}
                onChange={(event) => setForm((old) => ({ ...old, password: event.target.value }))} />
            ) : (
              <div className="space-y-2">
                <Input aria-label="密钥路径" placeholder="密钥路径" value={form.keyPath}
                  onChange={(event) => setForm((old) => ({ ...old, keyPath: event.target.value }))} />
                <Input aria-label="密钥密码" type="password" autoComplete="new-password" value={form.passphrase}
                  placeholder={savedPassphrase ? "密钥密码（留空则保持原密码）" : "密钥密码（可选）"}
                  onChange={(event) => setForm((old) => ({ ...old, passphrase: event.target.value }))} />
              </div>
            )}
            {!sameTarget && <p className="text-caption text-muted-foreground">主机、端口或用户名已更改，请填写新目标的认证信息。</p>}
          </fieldset>
          {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={close}>取消</Button>
            <Button type="submit" disabled={!canSave || saving}>{saving ? "保存中…" : mode === "copy" ? "创建副本" : "保存"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
