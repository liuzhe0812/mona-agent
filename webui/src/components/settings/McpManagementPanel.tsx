import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Loader2,
  Pencil,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useClientOptional } from "@/providers/ClientProvider";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SubsectionLabel } from "@/components/ui/page-header";
import { DeleteConfirm } from "@/components/DeleteConfirm";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServerTools,
  listMcpServers,
  reloadMcpServers,
  restartMcpServer,
  updateMcpServer,
  type McpServerConfig,
  type McpServerStatus,
  type McpToolInfo,
  type McpTransport,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const MASK = "****";

type Transport = "stdio" | "sse" | "streamableHttp";

function detectTransport(cfg: Partial<McpServerConfig>): Transport {
  if (cfg.type === "stdio" || cfg.type === "sse" || cfg.type === "streamableHttp") {
    return cfg.type;
  }
  if (cfg.command && cfg.command.trim()) return "stdio";
  if (cfg.url && cfg.url.trim()) {
    return cfg.url.replace(/\/+$/, "").endsWith("/sse")
      ? "sse"
      : "streamableHttp";
  }
  return "stdio";
}

function parseStringList(value: string): string[] {
  return value
    .split(/\n|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface DraftConfig {
  name: string; // 仅新建时编辑；编辑已有 server 时忽略（名称不可改）
  transport: Transport;
  command: string;
  args: string; // newline-separated for editing
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  toolTimeout: number;
  enabledTools: string; // newline-separated
}

function configToDraft(cfg?: McpServerConfig): DraftConfig {
  const transport = cfg ? detectTransport(cfg) : "stdio";
  return {
    name: "",
    transport,
    command: cfg?.command ?? "",
    args: (cfg?.args ?? []).join("\n"),
    env: cfg?.env ?? {},
    url: cfg?.url ?? "",
    headers: cfg?.headers ?? {},
    toolTimeout: cfg?.toolTimeout ?? 30,
    enabledTools: (cfg?.enabledTools ?? ["*"]).join("\n"),
  };
}

function draftToConfig(
  draft: DraftConfig,
  existing?: McpServerConfig,
): Partial<McpServerConfig> {
  const args = parseStringList(draft.args);
  const enabledTools = parseStringList(draft.enabledTools);
  const enabledFinal = enabledTools.length === 0 ? ["*"] : enabledTools;

  // Build env / headers, preserving masked values
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft.env)) {
    if (v === MASK) {
      if (existing?.env && k in existing.env) env[k] = existing.env[k];
      // else: drop
    } else if (v === "") {
      // explicit clear: drop
      continue;
    } else {
      env[k] = v;
    }
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft.headers)) {
    if (v === MASK) {
      if (existing?.headers && k in existing.headers) headers[k] = existing.headers[k];
    } else if (v === "") {
      continue;
    } else {
      headers[k] = v;
    }
  }

  return {
    type: draft.transport,
    command: draft.transport === "stdio" ? draft.command : "",
    args: draft.transport === "stdio" ? args : [],
    env,
    url: draft.transport === "stdio" ? "" : draft.url,
    headers: draft.transport === "stdio" ? {} : headers,
    toolTimeout: draft.toolTimeout,
    enabledTools: enabledFinal,
  };
}

export function McpManagementPanel() {
  const { t } = useTranslation();
  const tx = (
    key: string,
    fallback: string,
    options?: Record<string, unknown>,
  ) => t(key, { defaultValue: fallback, ...(options ?? {}) });
  const { token } = useClientOptional();

  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<Record<string, McpToolInfo[]>>({});
  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set());
  const [showEditor, setShowEditor] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setRefreshing(true);
    setError(null);
    try {
      const res = await listMcpServers(token);
      setServers(res.servers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totals = useMemo(() => {
    const total = servers.length;
    const connected = servers.filter((s) => s.connected).length;
    const toolCount = servers.reduce((sum, s) => sum + (s.toolCount || 0), 0);
    return { total, connected, toolCount };
  }, [servers]);

  const toggleExpand = async (name: string) => {
    if (expandedSet.has(name)) {
      const next = new Set(expandedSet);
      next.delete(name);
      setExpandedSet(next);
      return;
    }
    if (!token) return;
    if (!expandedTools[name]) {
      try {
        const res = await listMcpServerTools(token, name);
        setExpandedTools((prev) => ({ ...prev, [name]: res.tools }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setExpandedSet((prev) => new Set(prev).add(name));
  };

  const handleRestart = async (name: string) => {
    if (!token || busyName) return;
    setBusyName(name);
    setError(null);
    try {
      const res = await restartMcpServer(token, name);
      if (!res.ok) {
        setError(res.error ?? tx("settings.mcp.restart.failed", "重启失败"));
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyName(null);
    }
  };

  const handleDelete = (name: string) => {
    if (busyName) return;
    setPendingDelete(name);
  };

  const executeDelete = async (name: string) => {
    if (!token) return;
    setBusyName(name);
    setError(null);
    try {
      const res = await deleteMcpServer(token, name);
      if (!res.ok) {
        setError(res.error ?? tx("settings.mcp.delete.failed", "删除失败"));
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyName(null);
    }
  };

  const handleReloadAll = async () => {
    if (!token || reloadBusy) return;
    setReloadBusy(true);
    setError(null);
    try {
      const res = await reloadMcpServers(token);
      if (!res.ok) {
        setError(
          res.error ?? tx("settings.mcp.reload.failed", "全量重载失败"),
        );
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReloadBusy(false);
    }
  };

  const openCreate = () => {
    setEditingName(null);
    setDraft(configToDraft(undefined));
    setShowEditor(true);
  };

  const openEdit = (server: McpServerStatus) => {
    setEditingName(server.name);
    setDraft(configToDraft(server.config));
    setShowEditor(true);
  };

  const closeEditor = () => {
    setShowEditor(false);
    setEditingName(null);
    setDraft(null);
  };

  const handleSave = async () => {
    if (!token || !draft || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (editingName) {
        const existing = servers.find((s) => s.name === editingName)?.config;
        const cfg = draftToConfig(draft, existing);
        const res = await updateMcpServer(token, editingName, cfg);
        if (!res.ok) {
          setError(res.error ?? tx("settings.mcp.save.failed", "保存失败"));
          return;
        }
      } else {
        const name = draft.name.trim();
        if (!name) {
          setError(tx("settings.mcp.editor.nameRequired", "请输入 server 名称"));
          return;
        }
        if (servers.some((s) => s.name === name)) {
          setError(
            tx("settings.mcp.editor.nameConflict", "已存在同名 server：{{name}}", { name }),
          );
          return;
        }
        const cfg = draftToConfig(draft);
        const res = await createMcpServer(token, name, cfg);
        if (!res.ok) {
          setError(res.error ?? tx("settings.mcp.save.failed", "保存失败"));
          return;
        }
      }
      closeEditor();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!token) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-border/60 bg-card text-body text-muted-foreground">
        {tx("settings.mcp.unavailable", "需要登录后才能管理 MCP server。")}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-border/60 bg-card text-body text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {tx("settings.status.loading", "Loading…")}
      </div>
    );
  }

  return (
    <div className="space-y-7">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-caption text-destructive">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 break-words">{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setError(null)}
            className="h-5 w-5 text-destructive/70 hover:bg-transparent hover:text-destructive"
          >
            ×
          </Button>
        </div>
      ) : null}

      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.mcp.overview.title", "概览")}</SubsectionLabel>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatCard
            label={tx("settings.mcp.overview.total", "已配置")}
            value={totals.total}
            hint={tx("settings.mcp.overview.total.hint", "config.json 中的数量")}
          />
          <StatCard
            label={tx("settings.mcp.overview.connected", "已连接")}
            value={totals.connected}
            hint={tx("settings.mcp.overview.connected.hint", "运行时实际连接")}
          />
          <StatCard
            label={tx("settings.mcp.overview.tools", "已注册工具")}
            value={totals.toolCount}
            hint={tx("settings.mcp.overview.tools.hint", "工具 + 资源 + prompts")}
          />
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between px-1">
          <SubsectionLabel>
            {tx("settings.mcp.list.title", "Server 列表")}
          </SubsectionLabel>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              {refreshing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {tx("settings.mcp.list.refresh", "刷新")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleReloadAll()}
              disabled={reloadBusy}
            >
              {reloadBusy ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlugZap className="mr-1.5 h-3.5 w-3.5" />
              )}
              {tx("settings.mcp.list.reloadAll", "全部重连")}
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {tx("settings.mcp.list.add", "新增")}
            </Button>
          </div>
        </div>

        {servers.length === 0 ? (
          <div className="rounded-lg border border-border/60 bg-card">
            <EmptyState
              className="py-8"
              title={tx(
                "settings.mcp.list.empty",
                "尚未配置任何 MCP server。点击右上角「新增」开始添加。",
              )}
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
            <div className="divide-y divide-border/50">
              {servers.map((server) => (
                <McpServerRow
                  key={server.name}
                  server={server}
                  busy={busyName === server.name}
                  expanded={expandedSet.has(server.name)}
                  tools={expandedTools[server.name]}
                  onToggleExpand={() => void toggleExpand(server.name)}
                  onRestart={() => void handleRestart(server.name)}
                  onEdit={() => openEdit(server)}
                  onDelete={() => handleDelete(server.name)}
                  tx={tx}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {showEditor && draft ? (
        <McpServerEditor
          draft={draft}
          onChange={setDraft}
          editingName={editingName}
          saving={saving}
          onSave={() => void handleSave()}
          onCancel={closeEditor}
          tx={tx}
        />
      ) : null}

      <DeleteConfirm
        open={pendingDelete !== null}
        title={pendingDelete ?? ""}
        titleText={tx("settings.mcp.delete.confirmTitle", "删除这个 server？")}
        descriptionText={tx(
          "settings.mcp.delete.confirmDesc",
          "将从配置中移除该 server 并断开连接。",
        )}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const name = pendingDelete;
          setPendingDelete(null);
          if (name) void executeDelete(name);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card px-3 py-3">
      <div className="text-micro text-muted-foreground">{label}</div>
      <div className="mt-1 text-title-sm leading-none text-foreground">
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-micro text-muted-foreground/80">{hint}</div>
      ) : null}
    </div>
  );
}

function transportLabel(t: McpTransport): string {
  if (t === "stdio") return "stdio";
  if (t === "sse") return "SSE";
  if (t === "streamableHttp") return "HTTP";
  return "unknown";
}

function McpServerRow({
  server,
  busy,
  expanded,
  tools,
  onToggleExpand,
  onRestart,
  onEdit,
  onDelete,
  tx,
}: {
  server: McpServerStatus;
  busy: boolean;
  expanded: boolean;
  tools?: McpToolInfo[];
  onToggleExpand: () => void;
  onRestart: () => void;
  onEdit: () => void;
  onDelete: () => void;
  tx: (key: string, fallback: string, options?: Record<string, unknown>) => string;
}) {
  const transportStyle =
    server.transport === "stdio"
      ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
      : server.transport === "sse"
        ? "bg-violet-500/10 text-violet-600 dark:text-violet-400"
        : server.transport === "streamableHttp"
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-muted text-muted-foreground";

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={onToggleExpand}
          className="h-auto min-w-0 flex-1 items-center justify-start gap-2 whitespace-normal rounded-none px-0 py-0 text-left font-normal hover:bg-transparent"
        >
          {server.toolCount > 0 ? (
            expanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-ui font-medium text-foreground">
            {server.name}
          </span>
          <span
            className={cn(
              "shrink-0 rounded-md px-1.5 py-0.5 text-micro font-medium",
              transportStyle,
            )}
          >
            {transportLabel(server.transport)}
          </span>
          {server.connected ? (
            <span className="flex shrink-0 items-center gap-0.5 text-micro text-emerald-600 dark:text-emerald-400">
              <CircleCheck className="h-3 w-3" />
              {tx("settings.mcp.row.connected", "已连接")}
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-0.5 text-micro text-muted-foreground">
              <CircleX className="h-3 w-3" />
              {tx("settings.mcp.row.disconnected", "未连接")}
            </span>
          )}
          <span className="hidden shrink-0 items-center gap-0.5 text-micro text-muted-foreground sm:flex">
            <Wrench className="h-3 w-3" />
            {server.toolCount}
          </span>
        </Button>

        <div className="flex shrink-0 items-center gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={onRestart}
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {tx("settings.mcp.row.restart", "重连此 server")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={onEdit}
                  disabled={busy}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {tx("settings.mcp.row.edit", "编辑")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={onDelete}
                  disabled={busy}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {tx("settings.mcp.row.delete", "删除")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div className="mt-1 pl-7 text-micro text-muted-foreground">
        {server.transport === "stdio" && server.config ? (
          <span className="font-mono">
            {server.config.command} {server.config.args.join(" ")}
          </span>
        ) : server.config ? (
          <span className="font-mono">{server.config.url}</span>
        ) : null}
        <span className="ml-3">
          {tx("settings.mcp.row.timeout", "超时")}
          <span className="ml-1 text-foreground/80">{server.toolTimeout}s</span>
        </span>
      </div>

      {expanded && tools ? (
        <div className="mt-2 pl-7">
          {tools.length === 0 ? (
            <div className="text-caption text-muted-foreground">
              {tx("settings.mcp.row.noTools", "此 server 未注册任何工具。")}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {tools.map((tool) => (
                <TooltipProvider key={tool.name}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-micro text-foreground/80">
                        {tool.kind === "tool" ? (
                          <Wrench className="h-2.5 w-2.5 text-muted-foreground" />
                        ) : tool.kind === "resource" ? (
                          <Plug className="h-2.5 w-2.5 text-muted-foreground" />
                        ) : (
                          <Server className="h-2.5 w-2.5 text-muted-foreground" />
                        )}
                        <span className="font-mono">{tool.name}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="max-w-sm">
                        <div className="font-mono text-micro font-semibold">
                          {tool.name}
                        </div>
                        {tool.description ? (
                          <div className="mt-1 text-micro text-muted-foreground">
                            {tool.description}
                          </div>
                        ) : null}
                        <div className="mt-1 text-micro uppercase text-muted-foreground">
                          {tool.kind}
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function KeyValueEditor({
  title,
  values,
  onChange,
  tx,
}: {
  title: string;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  tx: (key: string, fallback: string, options?: Record<string, unknown>) => string;
}) {
  const [newKey, setNewKey] = useState("");
  const entries = Object.entries(values);

  const handleAdd = () => {
    const k = newKey.trim();
    if (!k) return;
    if (k in values) return;
    onChange({ ...values, [k]: "" });
    setNewKey("");
  };

  const handleRemove = (k: string) => {
    const next = { ...values };
    delete next[k];
    onChange(next);
  };

  const handleValueChange = (k: string, v: string) => {
    onChange({ ...values, [k]: v });
  };

  return (
    <div>
      <div className="mb-1 text-caption font-medium text-foreground">{title}</div>
      <div className="space-y-1">
        {entries.length === 0 ? (
          <div className="text-micro text-muted-foreground">
            {tx("settings.mcp.editor.kvEmpty", "（无）")}
          </div>
        ) : null}
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-center gap-1">
            <Input
              value={k}
              readOnly
              className="h-7 flex-1 rounded-md bg-muted/40 font-mono text-caption"
            />
            <Input
              type="password"
              value={v}
              onChange={(e) => handleValueChange(k, e.target.value)}
              placeholder={tx(
                "settings.mcp.editor.kvValuePlaceholder",
                "值（留空清除）",
              )}
              className="h-7 flex-1 rounded-md font-mono text-caption"
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:bg-destructive/10"
              onClick={() => handleRemove(k)}
            >
              ×
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-1 flex items-center gap-1">
        <Input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder={tx("settings.mcp.editor.kvKeyPlaceholder", "新键名")}
          className="h-7 flex-1 rounded-md font-mono text-caption"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={handleAdd}
          disabled={!newKey.trim()}
        >
          <Plus className="mr-1 h-3 w-3" />
          {tx("settings.mcp.editor.kvAdd", "添加")}
        </Button>
      </div>
    </div>
  );
}

function McpServerEditor({
  draft,
  onChange,
  editingName,
  saving,
  onSave,
  onCancel,
  tx,
}: {
  draft: DraftConfig;
  onChange: (next: DraftConfig) => void;
  editingName: string | null;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  tx: (key: string, fallback: string, options?: Record<string, unknown>) => string;
}) {
  const isStdio = draft.transport === "stdio";
  const transportOptions: { key: Transport; label: string }[] = [
    { key: "stdio", label: "stdio" },
    { key: "sse", label: "SSE" },
    { key: "streamableHttp", label: "HTTP" },
  ];

  return (
    <section className="mt-2 rounded-lg border border-border/60 bg-card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between">
        <SubsectionLabel>
          {editingName
            ? tx("settings.mcp.editor.editTitle", "编辑 server")
            : tx("settings.mcp.editor.createTitle", "新增 server")}
          {editingName ? (
            <span className="ml-2 font-mono text-caption text-muted-foreground">
              {editingName}
            </span>
          ) : null}
        </SubsectionLabel>
      </div>

      <div className="space-y-4">
        {!editingName ? (
          <Field label={tx("settings.mcp.editor.name", "名称")}>
            <Input
              value={draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
              placeholder="my-server"
              className="h-8 rounded-full font-mono text-caption"
            />
          </Field>
        ) : null}

        <div>
          <div className="mb-1 text-caption font-medium text-foreground">
            {tx("settings.mcp.editor.transport", "传输方式")}
          </div>
          <div className="flex items-center gap-1 rounded-full border border-border/45 bg-card/60 p-0.5 text-caption">
            {transportOptions.map((opt) => (
              <Button
                key={opt.key}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange({ ...draft, transport: opt.key })}
                className={cn(
                  "h-auto rounded-full px-3 py-1 font-normal",
                  draft.transport === opt.key
                    ? "bg-info/[0.10] text-info hover:bg-info/[0.14]"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>

        {isStdio ? (
          <>
            <Field label={tx("settings.mcp.editor.command", "命令")}>
              <Input
                value={draft.command}
                onChange={(e) => onChange({ ...draft, command: e.target.value })}
                placeholder="npx"
                className="h-8 rounded-full text-ui"
              />
            </Field>
            <Field
              label={tx(
                "settings.mcp.editor.args",
                "参数（每行一个或用逗号分隔）",
              )}
            >
              <Textarea
                value={draft.args}
                onChange={(e) => onChange({ ...draft, args: e.target.value })}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path"}
                className="min-h-[80px] rounded-lg font-mono text-caption"
              />
            </Field>
            <KeyValueEditor
              title={tx("settings.mcp.editor.env", "环境变量")}
              values={draft.env}
              onChange={(env) => onChange({ ...draft, env })}
              tx={tx}
            />
          </>
        ) : (
          <>
            <Field
              label={tx("settings.mcp.editor.url", "URL")}
              hint={
                draft.transport === "sse"
                  ? tx("settings.mcp.editor.url.sseHint", "以 /sse 结尾")
                  : tx("settings.mcp.editor.url.httpHint", "streamable HTTP endpoint")
              }
            >
              <Input
                value={draft.url}
                onChange={(e) => onChange({ ...draft, url: e.target.value })}
                placeholder={
                  draft.transport === "sse"
                    ? "https://example.com/sse"
                    : "https://example.com/mcp"
                }
                className="h-8 rounded-full font-mono text-caption"
              />
            </Field>
            <KeyValueEditor
              title={tx("settings.mcp.editor.headers", "请求头")}
              values={draft.headers}
              onChange={(headers) => onChange({ ...draft, headers })}
              tx={tx}
            />
          </>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label={tx("settings.mcp.editor.toolTimeout", "工具超时（秒）")}>
            <Input
              type="number"
              min={1}
              value={draft.toolTimeout}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 1) {
                  onChange({ ...draft, toolTimeout: v });
                }
              }}
              className="h-8 rounded-full text-ui"
            />
          </Field>
          <Field
            label={tx(
              "settings.mcp.editor.enabledTools",
              "启用工具（每行一个，* 表示全部）",
            )}
          >
            <Textarea
              value={draft.enabledTools}
              onChange={(e) =>
                onChange({ ...draft, enabledTools: e.target.value })
              }
              placeholder="*"
              className="min-h-[60px] rounded-lg font-mono text-caption"
            />
          </Field>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          {tx("settings.mcp.editor.cancel", "取消")}
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : null}
          {tx("settings.mcp.editor.save", "保存并连接")}
        </Button>
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-caption font-medium text-foreground">{label}</span>
        {hint ? (
          <span className="text-micro text-muted-foreground">{hint}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}
