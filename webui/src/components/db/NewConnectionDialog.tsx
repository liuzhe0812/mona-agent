import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { StatusNotice } from "@/components/ui/status-notice";
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

export function NewConnectionDialog() {
  const open = useDbStore((s) => s.newConnectionDialogOpen);
  const setOpen = useDbStore((s) => s.setNewConnectionDialogOpen);
  const saveConnection = useDbStore((s) => s.saveConnection);
  const connect = useDbStore((s) => s.connect);
  const testConnection = useDbStore((s) => s.testConnection);

  const [name, setName] = useState("新建 MySQL 连接");
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

  useEffect(() => {
    if (open) {
      setTestResult(null);
    }
  }, [open]);

  const handleDbTypeChange = (type: DatabaseType) => {
    setDbType(type);
    if (type === "sqlite") {
      setName("新建 SQLite 连接");
      setHost("mona_data.db");
      setPort("0");
      setUsername("");
    } else if (type === "mysql") {
      setName("新建 MySQL 连接");
      setHost("127.0.0.1");
      setPort("3306");
      setUsername("root");
    } else if (type === "postgresql") {
      setName("新建 PostgreSQL 连接");
      setHost("127.0.0.1");
      setPort("5432");
      setUsername("postgres");
    } else if (type === "sqlserver") {
      setName("新建 SQL Server 连接");
      setHost("127.0.0.1");
      setPort("1433");
      setUsername("sa");
    } else if (type === "oracle") {
      setName("新建 Oracle 连接");
      setHost("127.0.0.1");
      setPort("1521");
      setUsername("system");
    } else if (type === "mongodb") {
      setName("新建 MongoDB 连接");
      setHost("127.0.0.1");
      setPort("27017");
      setUsername("admin");
    }
  };

  const buildConfig = (): DbConnectionConfig => ({
    id: crypto.randomUUID(),
    name,
    db_type: dbType,
    host,
    port: parseInt(port, 10) || 0,
    username,
    password,
    database: database || null,
    use_ssl: useSsl,
    use_ssh_tunnel: useSshTunnel,
    ssh_host: null,
    ssh_port: null,
    ssh_username: null,
    ssh_auth: null,
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

  const handleConnect = async () => {
    const config = buildConfig();
    await saveConnection(config);
    try {
      await connect(config);
    } catch (e) {
      console.error("Failed to connect:", e);
    }
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>新建连接</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <label className="text-body font-medium text-muted-foreground">连接名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <label className="text-body font-medium text-muted-foreground">数据库类型</label>
            <Select
              value={dbType}
              onValueChange={(v) => handleDbTypeChange(v as DatabaseType)}
              options={DB_TYPE_OPTIONS}
            />
          </div>
          {dbType !== "sqlite" && (
            <>
              <div className="grid grid-cols-[1fr_100px] gap-3">
                <div className="grid gap-2">
                  <label className="text-body font-medium text-muted-foreground">主机</label>
                  <Input value={host} onChange={(e) => setHost(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <label className="text-body font-medium text-muted-foreground">端口</label>
                  <Input value={port} onChange={(e) => setPort(e.target.value)} />
                </div>
              </div>
              <div className="grid gap-2">
                <label className="text-body font-medium text-muted-foreground">用户名</label>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <label className="text-body font-medium text-muted-foreground">密码</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </>
          )}
          {dbType === "sqlite" && (
            <div className="grid gap-2">
              <label className="text-body font-medium text-muted-foreground">数据库文件路径</label>
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="路径或 :memory:"
              />
            </div>
          )}
          <div className="grid gap-2">
            <label className="text-body font-medium text-muted-foreground">默认数据库</label>
            <Input
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              placeholder="可选，留空则连接后选择"
            />
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-body">
              <Checkbox
                checked={useSshTunnel}
                onCheckedChange={(checked) => setUseSshTunnel(checked === true)}
              />
              使用 SSH 隧道
            </label>
            <label className="flex items-center gap-2 text-body">
              <Checkbox
                checked={useSsl}
                onCheckedChange={(checked) => setUseSsl(checked === true)}
              />
              使用 SSL
            </label>
          </div>
          {testResult && (
            <StatusNotice tone={testResult.startsWith("✓") ? "success" : "danger"}>
              {testResult}
            </StatusNotice>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? "测试中..." : "测试连接"}
          </Button>
          <Button onClick={handleConnect}>连接</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
