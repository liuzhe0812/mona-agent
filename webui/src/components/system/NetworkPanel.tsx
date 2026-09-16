import { CheckCircle2, Globe, Loader2, RotateCcw, ShieldOff, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  editHosts,
  getDnsStatus,
  listHostsEntries,
  resetDns,
  restoreHostsBackup,
  setDns,
  type DnsPreset,
  type DnsStatusResult,
  type HostsEntry,
  type HostsListResult,
} from "./networkApi";
import { PanelCard, StatusPill } from "./SystemUi";

export function NetworkPanel() {
  return (
    <div className="flex flex-col gap-4">
      <DnsSection />
      <HostsSection />
    </div>
  );
}

// ===== DNS 切换 =====

function DnsSection() {
  const [status, setStatus] = useState<DnsStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getDnsStatus());
      setMessage(null);
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const applyPreset = async (preset: DnsPreset) => {
    setActing(preset.id);
    try {
      const result = await setDns(preset.id);
      setMessage({ text: result.detail, tone: "ok" });
      await refresh();
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setActing(null);
    }
  };

  const handleReset = async () => {
    setActing("reset");
    try {
      const result = await resetDns();
      setMessage({ text: result.detail, tone: "ok" });
      await refresh();
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setActing(null);
    }
  };

  const activePresetId = status?.activePresetId ?? null;

  return (
    <PanelCard
      title="DNS 服务器"
      action={
        <Button type="button" variant="outline" size="sm" onClick={handleReset} disabled={acting === "reset" || !status}>
          {acting === "reset" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          恢复 DHCP
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {loading ? (
          <div className="flex items-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取当前 DNS...</div>
        ) : (
          <>
            <div className="rounded-md bg-muted/30 p-3">
              <p className="text-micro text-muted-foreground">当前 DNS</p>
              {status && status.adapters.length > 0 ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  {status.adapters.map((adapter) => (
                    <div key={adapter.alias} className="flex flex-wrap items-center gap-2 text-caption">
                      <span className="font-medium">{adapter.alias}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-mono text-micro">{adapter.servers.join("、")}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-caption text-muted-foreground">未检测到手动设置的 DNS（DHCP 自动获取）</p>
              )}
            </div>

            <div>
              <p className="mb-2 text-micro text-muted-foreground">选择预设（将对所有在线物理适配器生效，需管理员授权）</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {status?.presets.map((preset) => {
                  const isActive = activePresetId === preset.id;
                  const isActing = acting === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => void applyPreset(preset)}
                      disabled={isActing}
                      className={cn(
                        "flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition",
                        isActive ? "border-info/30 bg-info/[0.05]" : "border-border/70 bg-card hover:bg-accent",
                        isActing && "opacity-60",
                      )}
                    >
                      <div className="flex w-full items-center justify-between">
                        <span className="text-caption font-semibold">{preset.label}</span>
                        {isActing && <Loader2 className="h-3 w-3 animate-spin text-info" />}
                        {isActive && !isActing && <CheckCircle2 className="h-3.5 w-3.5 text-info" />}
                      </div>
                      <span className="font-mono text-micro text-muted-foreground">
                        {preset.primaryV4}{preset.secondaryV4 ? ` / ${preset.secondaryV4}` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {message && (
          <p className={cn("text-caption", message.tone === "ok" ? "text-success" : "text-destructive")}>
            {message.text}
          </p>
        )}
      </div>
    </PanelCard>
  );
}

// ===== HOSTS 编辑器 =====

function HostsSection() {
  const [data, setData] = useState<HostsListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  const [addIp, setAddIp] = useState("");
  const [addDomain, setAddDomain] = useState("");
  const [blockDomain, setBlockDomain] = useState("");
  const [includeWww, setIncludeWww] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await listHostsEntries());
      setMessage(null);
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const runEdit = async (request: Parameters<typeof editHosts>[0], successText: string) => {
    setActing(true);
    try {
      const result = await editHosts(request);
      setMessage({ text: result.detail || successText, tone: "ok" });
      await refresh();
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setActing(false);
    }
  };

  const handleAdd = () => {
    const ip = addIp.trim();
    const domain = addDomain.trim();
    if (!ip || !domain) {
      setMessage({ text: "请填写 IP 和域名", tone: "err" });
      return;
    }
    void runEdit({ add: [{ ip, domain }], includeWww }, "已添加条目");
    setAddIp("");
    setAddDomain("");
  };

  const handleBlock = () => {
    const domain = blockDomain.trim();
    if (!domain) {
      setMessage({ text: "请填写要屏蔽的域名", tone: "err" });
      return;
    }
    void runEdit({ block: [domain], includeWww }, "已屏蔽域名");
    setBlockDomain("");
  };

  const handleRemove = (entry: HostsEntry) => {
    if (entry.blocked && entry.monaManaged) {
      void runEdit({ unblock: entry.domains, includeWww: false }, "已解除屏蔽");
    } else {
      void runEdit({ remove: entry.domains, includeWww: false }, "已删除条目");
    }
  };

  const handleRestore = async (backupPath: string) => {
    setActing(true);
    try {
      const result = await restoreHostsBackup(backupPath);
      setMessage({ text: result.detail, tone: "ok" });
      await refresh();
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setActing(false);
    }
  };

  return (
    <PanelCard title="HOSTS 编辑器">
      <div className="flex flex-col gap-4">
        {/* 添加条目 */}
        <div className="rounded-md bg-muted/30 p-3">
          <p className="mb-2 text-micro text-muted-foreground">添加条目（将域名指向指定 IP）</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-32"
              placeholder="IP 地址"
              value={addIp}
              onChange={(e) => setAddIp(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
            />
            <Input
              className="min-w-[140px] flex-1"
              placeholder="域名"
              value={addDomain}
              onChange={(e) => setAddDomain(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
            />
            <label className="flex items-center gap-1.5 text-micro text-muted-foreground">
              <Checkbox checked={includeWww} onCheckedChange={(v) => setIncludeWww(v === true)} />
              同时添加 www
            </label>
            <Button type="button" variant="interaction" size="sm" onClick={handleAdd} disabled={acting}>
              {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
              添加
            </Button>
          </div>
        </div>

        {/* 屏蔽域名 */}
        <div className="rounded-md bg-muted/30 p-3">
          <p className="mb-2 text-micro text-muted-foreground">屏蔽域名（指向 0.0.0.0，阻止访问）</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-[140px] flex-1"
              placeholder="要屏蔽的域名"
              value={blockDomain}
              onChange={(e) => setBlockDomain(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleBlock(); }}
            />
            <Button type="button" variant="interaction" size="sm" onClick={handleBlock} disabled={acting}>
              {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
              屏蔽
            </Button>
          </div>
        </div>

        {/* 当前条目列表 */}
        <div>
          <p className="mb-2 text-micro text-muted-foreground">
            当前条目{data ? `（${data.entries.length}）` : ""}
          </p>
          {loading ? (
            <div className="flex items-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取...</div>
          ) : data && data.entries.length > 0 ? (
            <div className="max-h-64 overflow-y-auto rounded-lg border border-border/60 scrollbar-hover">
              {data.entries.map((entry, idx) => (
                <div
                  key={`${entry.ip}-${entry.domains.join(",")}-${idx}`}
                  className="flex items-center gap-2 border-b border-border/40 px-3 py-2 text-caption last:border-b-0"
                >
                  <span className="font-mono text-micro text-muted-foreground">{entry.ip}</span>
                  <span className="min-w-0 flex-1 truncate">{entry.domains.join(" ")}</span>
                  {entry.blocked && <StatusPill tone="red">屏蔽</StatusPill>}
                  {entry.monaManaged && <StatusPill tone="blue">Mona</StatusPill>}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="w-6 px-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => handleRemove(entry)}
                    disabled={acting}
                    aria-label={entry.blocked && entry.monaManaged ? "解除屏蔽" : "删除条目"}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-caption text-muted-foreground">HOSTS 文件没有自定义条目</p>
          )}
        </div>

        {/* 备份恢复 */}
        {data && data.backupFiles.length > 0 && (
          <div>
            <p className="mb-2 text-micro text-muted-foreground">自动备份（编辑前自动创建，可恢复）</p>
            <div className="flex flex-col gap-1.5">
              {data.backupFiles.slice(0, 5).map((backup) => {
                const name = backup.split(/[\\/]/).pop() ?? backup;
                return (
                  <div key={backup} className="flex items-center gap-2 text-micro">
                    <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{name}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRestore(backup)}
                      disabled={acting}
                    >
                      <RotateCcw className="h-3 w-3" />
                      恢复
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {message && (
          <p className={cn("text-caption", message.tone === "ok" ? "text-success" : "text-destructive")}>
            {message.text}
          </p>
        )}
      </div>
    </PanelCard>
  );
}
