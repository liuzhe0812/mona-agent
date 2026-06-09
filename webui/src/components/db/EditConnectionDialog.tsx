import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDbStore } from "./store/dbStore";
import type { DatabaseType, DbConnectionConfig } from "./types";

const DB_TYPE_OPTIONS: { value: DatabaseType; label: string }[] = [
  { value: "mysql", label: "MySQL / MariaDB" },
  { value: "postgresql", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
  { value: "sqlserver", label: "SQL Server" },
  { value: "oracle", label: "Oracle" },
  { value: "mongodb", label: "MongoDB" },
];

export function EditConnectionDialog() {
  const editConfig = useDbStore((s) => s.editConnectionConfig);
  const setEditConfig = useDbStore((s) => s.setEditConnectionConfig);
  const saveConnection = useDbStore((s) => s.saveConnection);
  const connect = useDbStore((s) => s.connect);
  const disconnect = useDbStore((s) => s.disconnect);
  const testConnection = useDbStore((s) => s.testConnection);
  const activeConnections = useDbStore((s) => s.activeConnections);

  const open = editConfig !== null;
  const isConnected = editConfig
    ? activeConnections.some((c) => c.id === editConfig.id)
    : false;

  const [name, setName] = useState("");
  const [dbType, setDbType] = useState<DatabaseType>("mysql");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("3306");
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [useSsl, setUseSsl] = useState(false);
  const [useSshTunnel, setUseSshTunnel] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Populate form when dialog opens
  useEffect(() => {
    if (editConfig) {
      setName(editConfig.name);
      setDbType(editConfig.db_type);
      setHost(editConfig.host);
      setPort(String(editConfig.port));
      setUsername(editConfig.username);
      setPassword(editConfig.password);
      setDatabase(editConfig.database ?? "");
      setUseSsl(editConfig.use_ssl);
      setUseSshTunnel(editConfig.use_ssh_tunnel);
      setTestResult(null);
      setSaving(false);
    }
  }, [editConfig]);

  const buildConfig = (): DbConnectionConfig => ({
    id: editConfig!.id,
    name,
    db_type: dbType,
    host,
    port: parseInt(port, 10) || 0,
    username,
    password,
    database: database || null,
    use_ssl: useSsl,
    use_ssh_tunnel: useSshTunnel,
    ssh_host: editConfig?.ssh_host ?? null,
    ssh_port: editConfig?.ssh_port ?? null,
    ssh_username: editConfig?.ssh_username ?? null,
    ssh_auth: editConfig?.ssh_auth ?? null,
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection(buildConfig());
      setTestResult(`✓ 连接成功: ${result}`);
    } catch (e) {
      setTestResult(`✗ 连接失败: ${e}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!editConfig) return;
    setSaving(true);
    const config = buildConfig();
    await saveConnection(config);

    // If currently connected, reconnect with new config
    if (isConnected) {
      try {
        await disconnect(config.id);
        await connect(config);
      } catch (e) {
        console.error("Failed to reconnect:", e);
      }
    }
    setSaving(false);
    setEditConfig(null);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && setEditConfig(null)}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>编辑连接</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <label className="text-sm font-medium text-muted-foreground">连接名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium text-muted-foreground">数据库类型</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={dbType}
              onChange={(e) => setDbType(e.target.value as DatabaseType)}
            >
              {DB_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          {dbType !== "sqlite" ? (
            <>
              <div className="grid grid-cols-[1fr_100px] gap-3">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-muted-foreground">主机</label>
                  <Input value={host} onChange={(e) => setHost(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-muted-foreground">端口</label>
                  <Input value={port} onChange={(e) => setPort(e.target.value)} />
                </div>
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-muted-foreground">用户名</label>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-muted-foreground">密码</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="grid gap-2">
              <label className="text-sm font-medium text-muted-foreground">数据库文件路径</label>
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="路径或 :memory:"
              />
            </div>
          )}
          <div className="grid gap-2">
            <label className="text-sm font-medium text-muted-foreground">默认数据库</label>
            <Input
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              placeholder="可选，留空则连接后选择"
            />
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={useSshTunnel}
                onChange={(e) => setUseSshTunnel(e.target.checked)}
                className="rounded border-border"
              />
              使用 SSH 隧道
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={useSsl}
                onChange={(e) => setUseSsl(e.target.checked)}
                className="rounded border-border"
              />
              使用 SSL
            </label>
          </div>
          {isConnected && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
              当前连接已激活，保存后将自动断开并重连。
            </div>
          )}
          {testResult && (
            <div
              className={`rounded-md border px-3 py-2 text-sm ${
                testResult.startsWith("✓")
                  ? "border-green-500/30 bg-green-500/10 text-green-500"
                  : "border-destructive/30 bg-destructive/10 text-destructive"
              }`}
            >
              {testResult}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditConfig(null)}>
            取消
          </Button>
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? "测试中..." : "测试连接"}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
