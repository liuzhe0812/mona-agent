import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AdminRequestError, isValidPriceAmount, requestCodexStatus, requestModelDiscovery, requestModelSettings,
  type ApiModelConfiguration, type BillingMode, type CodexStatus, type DiscoveredModel, type ManagedModel,
  type ModelPrice, type ModelSettings } from "./model-admin-api";

type Provider = "custom" | "codex";
type Connection = { apiBase: string; apiKeyEnv: string };
type Draft = {
  enabled: boolean; displayName: string; billingMode: BillingMode; inputPrice: string; cachedPrice: string; outputPrice: string;
  maxOutput: string; inputBudget: string;
};
type Field = keyof Draft;
type Edit = { fields: Partial<Draft>; originalId: string | null; baseline: Draft };
type Catalog = { state: "idle" | "loading" | "ready" | "error"; models: DiscoveredModel[]; message?: string };
type Problem = { title: string; description: string; login?: boolean; refresh?: boolean };
type ModelRow = { key: string; id: string; label: string; suggestedId?: string; discovered: boolean; existing?: ManagedModel };

const normalizeBase = (value: string) => value.trim().replace(/\/+$/, "");
const connectionId = (connection: Connection) => JSON.stringify([normalizeBase(connection.apiBase), connection.apiKeyEnv.trim()]);
const rowKey = (provider: Provider, connection: Connection | null, model: string) =>
  JSON.stringify([provider, provider === "custom" && connection ? connectionId(connection) : "", model]);
const sameConnection = (configuration: ApiModelConfiguration, connection: Connection) =>
  normalizeBase(configuration.api_base) === normalizeBase(connection.apiBase) && configuration.api_key_env === connection.apiKeyEnv.trim();
const sameDraftValue = (left: Draft, right: Draft) => JSON.stringify(left) === JSON.stringify(right);

function draftFor(row: ModelRow, provider: Provider, codex: CodexStatus | null): Draft {
  const config = row.existing?.configuration;
  const legacy = provider === "codex" && codex?.configuration.model === row.id ? codex.configuration : null;
  const price = config ? config.price : legacy?.price;
  const budget = config ? config.context_window_tokens : legacy?.context_window_tokens;
  return { enabled: config?.enabled ?? false, displayName: config?.label ?? legacy?.label ?? row.label,
    billingMode: config?.billing_mode ?? legacy?.billing_mode ?? "wallet",
    inputPrice: price?.input_amount_per_million ?? "", cachedPrice: price?.cached_input_amount_per_million ?? "",
    outputPrice: price?.output_amount_per_million ?? "", maxOutput: String(config?.max_output_tokens ?? legacy?.max_output_tokens ?? 4096),
    inputBudget: budget == null ? "" : String(budget) };
}

function canDiscover(connection: Connection | null): connection is Connection {
  if (!connection || !/^MONA_WORK_MODEL_[A-Z0-9_]+$/.test(connection.apiKeyEnv.trim())) return false;
  try {
    const url = new URL(connection.apiBase.trim());
    const local = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || local) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

async function codexModelId(model: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`codex\0${model}`));
  return "codex-" + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

export function ModelSettingsPanel({ token }: { token: string }) {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [revision, setRevision] = useState("");
  const [provider, setProvider] = useState<Provider>("custom");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [catalog, setCatalog] = useState<Catalog>({ state: "idle", models: [] });
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, Partial<Record<Field, string>>>>({});
  const [editor, setEditor] = useState<{ row: ModelRow; before?: Edit } | null>(null);
  const [cliPath, setCliPath] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"chatgpt" | "api_key">("chatgpt");
  const cliPathEdited = useRef(false);
  const authModeEdited = useRef(false);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState<"load" | "save" | "probe" | null>("load");
  const [reload, setReload] = useState(0);
  const [catalogReload, setCatalogReload] = useState(0);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState("");

  function failed(error: unknown) {
    if (error instanceof AdminRequestError) {
      if (error.status === 401 || error.status === 403) {
        setProblem({ title: error.status === 401 ? "需要管理员登录" : "没有管理权限",
          description: "请前往管理后台登录有权限的管理员账号。草稿已保留。", login: true });
        return;
      }
      if (error.code === "configuration_changed") {
        setRevision("");
        setProblem({ title: "配置已变化", description: "其他配置操作已更新版本，请刷新状态并核对后再保存。草稿已保留。", refresh: true });
        return;
      }
      if (error.code === "work_busy") {
        setProblem({ title: "工作台正在处理任务", description: "请在当前任务结束后保存。草稿已保留。" });
        return;
      }
    }
    setProblem({ title: "操作未完成", description: "配置未保存，请检查连接后重试。草稿已保留。" });
  }

  useEffect(() => {
    const controller = new AbortController();
    setPending("load");
    Promise.all([requestModelSettings(token, undefined, controller.signal), requestCodexStatus(token, "GET", undefined, controller.signal)])
      .then(([models, status]) => {
        if (controller.signal.aborted) return;
        setSettings(models);
        setCodex(status);
        setConnection(previous => previous ?? (() => {
          const first = models.models.find(item => item.configuration.source === "mona");
          return first ? { apiBase: first.configuration.api_base, apiKeyEnv: first.configuration.api_key_env } : { apiBase: "", apiKeyEnv: "" };
        })());
        setCliPath(previous => cliPathEdited.current ? previous ?? "" :
          status.configuration.cli_path || (status.discovery.state === "found" ? status.discovery.path : ""));
        if (!authModeEdited.current) setAuthMode(status.configuration.auth_mode);
        if (models.revision !== status.revision) {
          setRevision("");
          setProblem({ title: "配置已变化", description: "配置在读取时发生变化，请刷新状态并核对后再保存。草稿已保留。", refresh: true });
        } else setRevision(models.revision);
      }).catch(error => { if (!controller.signal.aborted) failed(error); })
      .finally(() => { if (!controller.signal.aborted) setPending(null); });
    return () => controller.abort();
  }, [token, reload]);

  useEffect(() => {
    if (provider !== "custom" || !canDiscover(connection)) {
      setCatalog({ state: "idle", models: [] });
      return;
    }
    const controller = new AbortController();
    setCatalog({ state: "loading", models: [] });
    const timer = window.setTimeout(() => {
      requestModelDiscovery(token, normalizeBase(connection.apiBase), connection.apiKeyEnv.trim(), controller.signal)
        .then(models => { if (!controller.signal.aborted) setCatalog({ state: "ready", models }); })
        .catch(error => {
          if (controller.signal.aborted) return;
          if (error instanceof AdminRequestError && [401, 403].includes(error.status)) {
            setCatalog({ state: "error", models: [], message: "" });
            failed(error);
            return;
          }
          const message = error instanceof AdminRequestError && error.code === "model_credentials_unavailable"
            ? "模型凭据尚未载入或无法读取列表，请检查服务器凭据后重试。"
            : error instanceof AdminRequestError && error.code === "invalid_model_endpoint"
              ? "模型地址无效或不允许访问，请检查 API Base URL。"
              : error instanceof AdminRequestError && error.code === "model_catalog_unavailable"
                ? "供应商未提供可读取的完整模型列表，请检查接口支持情况后重试。"
                : "无法获取模型列表，请检查地址与网络后重试。";
          setCatalog({ state: "error", models: [], message });
        });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [provider, connection?.apiBase, connection?.apiKeyEnv, token, catalogReload]);

  useEffect(() => {
    if (provider !== "codex" || !codex || !revision || pending) return;
    const controller = new AbortController();
    let checking = false;
    const check = () => {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;
      requestCodexStatus(token, "GET", undefined, controller.signal).then(status => {
        if (controller.signal.aborted) return;
        if (status.revision !== revision) {
          setRevision("");
          setProblem({ title: "配置已变化", description: "其他配置操作已更新版本，请刷新状态并核对后再保存。草稿已保留。", refresh: true });
          return;
        }
        setCodex(previous => previous ? { ...previous, discovery: status.discovery, connection: status.connection } : previous);
        if (!cliPathEdited.current && !status.configuration.cli_path) setCliPath(status.discovery.state === "found" ? status.discovery.path : "");
      }).catch(error => {
        if (!controller.signal.aborted && error instanceof AdminRequestError && [401, 403].includes(error.status)) {
          setRevision("");
          failed(error);
        }
      }).finally(() => { checking = false; });
    };
    check();
    const timer = window.setInterval(check, 10_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [provider, codex?.configuration.cli_path, token, revision, pending]);

  const connections = useMemo(() => {
    const result = new Map<string, Connection>();
    for (const model of settings?.models ?? []) if (model.configuration.source === "mona") {
      const item = { apiBase: model.configuration.api_base, apiKeyEnv: model.configuration.api_key_env };
      result.set(connectionId(item), item);
    }
    return [...result.values()];
  }, [settings]);

  const rows = useMemo(() => {
    if (!settings) return { listed: [] as ModelRow[], missing: [] as ModelRow[] };
    const saved = settings.models.filter(item => provider === "custom"
      ? item.configuration.source === "mona" && !!connection && sameConnection(item.configuration, connection)
      : item.configuration.source === "codex");
    const found = provider === "custom" ? catalog.models : (codex?.connection.models ?? []);
    const seen = new Set<string>();
    const listed: ModelRow[] = [];
    for (const item of found) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const matches = saved.filter(model => model.configuration.model === item.id);
      if (!matches.length) {
        listed.push({ key: rowKey(provider, connection, item.id), id: item.id, label: item.label.slice(0, 80), discovered: true,
          suggestedId: "suggested_id" in item && typeof item.suggested_id === "string" ? item.suggested_id : undefined });
      } else for (const [index, existing] of matches.entries()) {
        listed.push({ key: rowKey(provider, connection, index === 0 ? item.id : `${item.id}\0${existing.id}`), id: item.id,
          label: existing.configuration.label, discovered: true, existing,
          suggestedId: "suggested_id" in item && typeof item.suggested_id === "string" ? item.suggested_id : undefined });
      }
    }
    const missingCounts = new Map<string, number>();
    const missing = saved.filter(item => !seen.has(item.configuration.model)).map(item => {
      const model = item.configuration.model;
      const count = missingCounts.get(model) ?? 0;
      missingCounts.set(model, count + 1);
      return { key: rowKey(provider, connection, count === 0 ? model : `${model}\0${item.id}`),
        id: model, label: item.configuration.label, discovered: false, existing: item };
    });
    return { listed, missing };
  }, [settings, provider, connection, catalog.models, codex?.connection.models]);

  function edit(row: ModelRow, field: Field, value: string | boolean) {
    const base = draftFor(row, provider, codex);
    setEdits(previous => {
      const old = previous[row.key];
      const fields = { ...old?.fields };
      if (value === base[field]) delete fields[field];
      else Object.assign(fields, { [field]: value });
      const result = { ...previous };
      if (!Object.keys(fields).length) delete result[row.key];
      else result[row.key] = { originalId: old ? old.originalId : row.existing?.id ?? null,
        fields, baseline: { ...(old?.baseline ?? base), [field]: base[field] } };
      return result;
    });
    setRowErrors(previous => ({ ...previous, [row.key]: { ...previous[row.key], [field]: undefined } }));
    setNotice("");
  }

  async function saveModel(row: ModelRow, override?: Edit, preserveDraft = false): Promise<boolean> {
    const editState = override ?? edits[row.key];
    if (!settings || !codex || !revision || !editState || pendingRef.current || pending) return false;
    const latest = row.existing && settings.models.find(item => item.id === row.existing?.id);
    if (row.existing && (!latest || latest.configuration.model !== row.id || latest.configuration.source !== row.existing.configuration.source)) {
      setProblem({ title: "配置已变化", description: "原模型配置已变化，请刷新并核对草稿。", refresh: true });
      return false;
    }
    const base = draftFor(row, provider, codex);
    const draft = { ...base, ...editState.fields };
    const errors: Partial<Record<Field, string>> = {};
    const priceFields = ["inputPrice", "cachedPrice", "outputPrice"] as const;
    const prices = priceFields.map(field => draft[field].trim());
    const needsPrice = draft.enabled && !row.existing?.configuration.enabled;
    const deferPrice = editState.fields.enabled === false && prices.some(Boolean)
      && prices.some(value => !value || !isValidPriceAmount(value));
    if (!deferPrice && (needsPrice || prices.some(Boolean))) priceFields.forEach((field, index) => {
      if (!prices[index]) errors[field] = "请填写三项价格，或关闭模型。";
      else if (!isValidPriceAmount(prices[index])) errors[field] = "请输入不超过 1000000000 的非负金额，最多六位小数。";
    });
    if (!draft.displayName.trim() || draft.displayName.trim().length > 80 || /[\x00-\x1f\x7f]/.test(draft.displayName)) {
      errors.displayName = "请输入不超过 80 个字符的名称。";
    }
    if (!/^\d+$/.test(draft.maxOutput) || +draft.maxOutput < 256 || +draft.maxOutput > 32768) errors.maxOutput = "输出上限应为 256–32768。";
    if (draft.inputBudget && (!/^\d+$/.test(draft.inputBudget) || +draft.inputBudget < 4096 || +draft.inputBudget > 2_000_000)) {
      errors.inputBudget = "输入预算上限应为 4096–2000000，或留空。";
    }
    if (!row.discovered && draft.enabled && !row.existing?.configuration.enabled) errors.enabled = "当前目录未提供此模型，暂不能开放。";
    setRowErrors(previous => ({ ...previous, [row.key]: errors }));
    if (Object.keys(errors).length) return false;
    if ((row.existing?.id ?? null) !== editState.originalId || Object.keys(editState.fields).some(field => {
      const key = field as Field;
      return editState.baseline[key] !== base[key] && editState.fields[key] !== base[key];
    })) {
      setProblem({ title: "配置已变化", description: "原模型配置已变化，请刷新并核对草稿。", refresh: true });
      return false;
    }
    pendingRef.current = true;
    setPending("save");
    setNotice("");
    try {
      const modelId = row.existing?.id ?? row.suggestedId ?? await codexModelId(row.id);
      if (!row.existing && settings.models.some(item => item.id === modelId)) {
        throw new AdminRequestError(409, "model_id_conflict");
      }
      const price: ModelPrice | null = prices.some(Boolean) ? {
        input_amount_per_million: prices[0], cached_input_amount_per_million: prices[1], output_amount_per_million: prices[2],
      } : null;
      const priceEdited = priceFields.some(field => field in editState.fields);
      const config = { label: draft.displayName.trim(), source: provider === "custom" ? "mona" as const : "codex" as const,
        model: row.id, api_base: provider === "custom" ? row.existing?.configuration.api_base ?? normalizeBase(connection?.apiBase ?? "") : "",
        api_key_env: provider === "custom" ? row.existing?.configuration.api_key_env ?? (connection?.apiKeyEnv ?? "").trim() : "",
        enabled: draft.enabled, billing_mode: draft.billingMode, max_output_tokens: +draft.maxOutput,
        context_window_tokens: draft.inputBudget ? +draft.inputBudget : null,
        ...(!deferPrice && (priceEdited || !row.existing && price) ? { price } : {}),
      };
      const saved = await requestModelSettings(token, { expected_revision: revision, model_id: modelId, configuration: config });
      setSettings(saved);
      setRevision(saved.revision);
      setEdits(previous => {
        const next = { ...previous };
        if (preserveDraft) {
          const existing = next[row.key];
          if (existing) {
            const fields = { ...existing.fields };
            delete fields.enabled;
            if (Object.keys(fields).length) {
              next[row.key] = { ...existing, fields, baseline: { ...existing.baseline, enabled: draft.enabled } };
            } else delete next[row.key];
          }
        } else if (deferPrice) {
          const retained = Object.fromEntries(Object.entries(editState.fields).filter(([field]) => priceFields.includes(field as typeof priceFields[number])));
          if (Object.keys(retained).length) next[row.key] = { ...editState, fields: retained };
          else delete next[row.key];
        } else delete next[row.key];
        return next;
      });
      setNotice(`${row.label} 已保存。${deferPrice ? "价格草稿尚未保存。" : ""}`);
      return true;
    } catch (error) {
      if (error instanceof AdminRequestError && error.code === "model_id_conflict") {
        setProblem({ title: "模型标识冲突", description: "模型配置未保存，请刷新列表后重试。", refresh: true });
      } else failed(error);
      return false;
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  function openEditor(row: ModelRow, enable = false) {
    if (pendingRef.current || pending) return;
    setEditor({ row, before: edits[row.key] });
    if (enable) edit(row, "enabled", true);
  }

  function cancelEditor() {
    if (!editor || pendingRef.current) return;
    setEdits(previous => {
      const next = { ...previous };
      if (editor.before) next[editor.row.key] = editor.before;
      else delete next[editor.row.key];
      return next;
    });
    setEditor(null);
  }

  function toggleModel(row: ModelRow, enabled: boolean) {
    if (pendingRef.current || pending || !revision) return;
    if (enabled && (!row.existing || !row.existing.configuration.price)) {
      openEditor(row, true);
      return;
    }
    if (!row.existing) return;
    const base = draftFor(row, provider, codex);
    void saveModel(row, { fields: { enabled }, originalId: row.existing.id, baseline: base }, true);
  }

  async function saveConnection() {
    if (!codex || !revision || pendingRef.current || pending) return;
    const path = (cliPath ?? "").trim();
    if (path && (!path.startsWith("/") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path)
      || path.split("/").some(part => part === "." || part === ".."))) {
      setProblem({ title: "程序路径无效", description: "请输入 Ubuntu 上的绝对程序路径。" });
      return;
    }
    pendingRef.current = true;
    setPending("save");
    setNotice("");
    try {
      const saved = await requestCodexStatus(token, "PUT", { expected_revision: revision,
        configuration: { cli_path: path, auth_mode: authMode, billing_mode: codex.configuration.billing_mode } });
      setCodex(saved);
      setRevision(saved.revision);
      cliPathEdited.current = false;
      authModeEdited.current = false;
      setCliPath(saved.configuration.cli_path);
      setAuthMode(saved.configuration.auth_mode);
      setNotice("Codex 连接配置已保存。");
    } catch (error) { failed(error); }
    finally { pendingRef.current = false; setPending(null); }
  }

  async function probe() {
    if (!codex || !revision || pendingRef.current || pending || !codex.configuration.cli_path
      || cliPath !== codex.configuration.cli_path || authMode !== codex.configuration.auth_mode) return;
    pendingRef.current = true;
    setPending("probe");
    setNotice("");
    try {
      const result = await requestCodexStatus(token, "POST", {});
      if (result.revision !== revision) {
        setRevision("");
        setProblem({ title: "配置已变化", description: "检查期间配置发生变化，请刷新状态并核对后再保存。草稿已保留。", refresh: true });
        return;
      }
      setCodex(result);
    } catch (error) { failed(error); }
    finally { pendingRef.current = false; setPending(null); }
  }

  function renderRow(row: ModelRow) {
    const base = draftFor(row, provider, codex);
    const draft = { ...base, ...edits[row.key]?.fields };
    const dirty = !!edits[row.key] && !sameDraftValue(base, draft);
    const enabled = row.existing?.configuration.enabled ?? false;
    const unavailable = !!row.existing && enabled && !row.existing.availability.ready;
    const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s_\-·]/g, "");
    return <div key={row.key} role="group" aria-label={`模型 ${row.label}`}
      className="flex min-w-0 items-center gap-3 border-b border-border py-2 last:border-0">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-ui font-medium" title={row.label}>{row.label}</span>
        {normalized(row.id) !== normalized(row.label) && <span className="min-w-0 truncate text-caption text-muted-foreground" title={row.id}>{row.id}</span>}
        {!row.discovered && <span className="text-caption text-muted-foreground">未返回</span>}
        {unavailable && <span className="text-caption text-muted-foreground">暂不可用</span>}
        {dirty && <span className="text-caption text-muted-foreground">未保存</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-caption text-muted-foreground">开放</span>
        <Switch size="sm" aria-label={`开放 ${row.label}`} checked={enabled}
          disabled={!!pending || !revision || (!row.discovered && !enabled)}
          onCheckedChange={value => toggleModel(row, value)} />
        <Button type="button" variant="ghost" size="sm" aria-label={`设置 ${row.label}`}
          disabled={!!pending} onClick={() => openEditor(row)}>设置</Button>
      </div>
    </div>;
  }

  const editorRow = editor ? [...rows.listed, ...rows.missing].find(row => row.key === editor.row.key) ?? editor.row : null;
  const editorDraft = editorRow ? { ...draftFor(editorRow, provider, codex), ...edits[editorRow.key]?.fields } : null;
  const editorErrors = editorRow ? rowErrors[editorRow.key] ?? {} : {};

  function renderEditor() {
    if (!editorRow || !editorDraft) return null;
    const field = (key: "inputPrice" | "cachedPrice" | "outputPrice", label: string) => <div className="space-y-2">
      <label className="text-ui font-medium" htmlFor={`model-settings-${key}`}>{label}</label>
      <Input id={`model-settings-${key}`} type="text" inputMode="decimal" value={editorDraft[key]} disabled={!!pending}
        onChange={event => edit(editorRow, key, event.target.value)} aria-invalid={!!editorErrors[key]}
        aria-describedby={editorErrors[key] ? `model-settings-${key}-error` : undefined} />
      {editorErrors[key] && <p id={`model-settings-${key}-error`} className="text-caption text-destructive">{editorErrors[key]}</p>}
    </div>;
    return <>
      <DialogHeader><DialogTitle>设置 {editorRow.label}</DialogTitle>
        <DialogDescription>配置模型名称、计费方式和价格。</DialogDescription></DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2"><label htmlFor="model-settings-name" className="text-ui font-medium">显示名称</label>
          <Input id="model-settings-name" value={editorDraft.displayName} disabled={!!pending}
            onChange={event => edit(editorRow, "displayName", event.target.value)} aria-invalid={!!editorErrors.displayName}
            aria-describedby={editorErrors.displayName ? "model-settings-name-error" : undefined} />
          {editorErrors.displayName && <p id="model-settings-name-error" className="text-caption text-destructive">{editorErrors.displayName}</p>}
        </div>
        <div className="space-y-2"><span className="text-ui font-medium">计费方式</span>
          <Select aria-label="计费方式" value={editorDraft.billingMode} disabled={!!pending}
            onValueChange={value => edit(editorRow, "billingMode", value)} options={[
              { value: "free", label: "免费" }, { value: "wallet", label: "共用余额" },
            ]} /></div>
        {editorDraft.billingMode === "wallet" && !settings?.billing.ready &&
          <p className="text-caption text-muted-foreground">余额计费尚未接通，当前不能调用。</p>}
        <div className="space-y-2"><p className="text-ui font-medium">模型价格</p>
          <p className="text-caption text-muted-foreground">人民币 / 百万 token；三项全空表示尚未配置。</p>
          <div className="grid gap-4 sm:grid-cols-3">{field("inputPrice", "输入价格")}{field("cachedPrice", "缓存输入价格")}{field("outputPrice", "输出价格")}</div>
        </div>
        {editorErrors.enabled && <p className="text-caption text-destructive">{editorErrors.enabled}</p>}
        <details className="border-t border-border pt-3 text-ui"><summary className="cursor-pointer font-medium">模型参数</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><label htmlFor="model-settings-output">最大输出 token</label>
              <Input id="model-settings-output" type="number" value={editorDraft.maxOutput} disabled={!!pending}
                onChange={event => edit(editorRow, "maxOutput", event.target.value)} aria-invalid={!!editorErrors.maxOutput} />
              {editorErrors.maxOutput && <p className="text-caption text-destructive">{editorErrors.maxOutput}</p>}</div>
            <div className="space-y-2"><label htmlFor="model-settings-budget">输入预算上限（可选）</label>
              <Input id="model-settings-budget" type="number" value={editorDraft.inputBudget} disabled={!!pending}
                onChange={event => edit(editorRow, "inputBudget", event.target.value)} aria-invalid={!!editorErrors.inputBudget} />
              {editorErrors.inputBudget && <p className="text-caption text-destructive">{editorErrors.inputBudget}</p>}</div>
          </div>
        </details>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={!!pending} onClick={cancelEditor}>取消</Button>
        <Button type="button" disabled={!!pending} onClick={() => {
          if (!edits[editorRow.key]) { setEditor(null); return; }
          void saveModel(editorRow).then(saved => { if (saved) setEditor(null); });
        }}>{pending === "save" ? "保存中…" : "保存"}</Button>
      </DialogFooter>
    </>;
  }
  const availableConnection = connection && connections.some(item => connectionId(item) === connectionId(connection));
  const cliDirty = !!codex && (cliPath !== codex.configuration.cli_path || authMode !== codex.configuration.auth_mode);
  return <>
    <section className="space-y-4 rounded-lg border border-border bg-card p-6" aria-label="模型配置">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-title-sm font-semibold">模型配置</h2>
        <Button type="button" variant="outline" disabled={!!pending} onClick={() => setReload(value => value + 1)}>刷新配置</Button></div>
      <div role="group" aria-label="模型提供者" className="flex flex-wrap gap-2">
        <Button type="button" variant={provider === "custom" ? "secondary" : "ghost"} aria-pressed={provider === "custom"} disabled={!!pending}
          onClick={() => { setProvider("custom"); setNotice(""); }}>自定义 API</Button>
        <Button type="button" variant={provider === "codex" ? "secondary" : "ghost"} aria-pressed={provider === "codex"} disabled={!!pending}
          onClick={() => { setProvider("codex"); setNotice(""); }}>Codex CLI</Button>
      </div>
      {!settings || !codex ? <p className="text-ui text-muted-foreground">{pending === "load" ? "正在加载配置…" : "配置未加载。"}</p> : <>
        {provider === "custom" ? <div className="space-y-4 border-t border-border pt-4">
          {!!connections.length && <div className="flex flex-wrap items-center gap-3"><div className="min-w-48 flex-1">
            <Select aria-label="供应商连接" value={availableConnection ? connectionId(connection!) : undefined} disabled={!!pending}
              placeholder="新供应商连接" options={connections.map(item => ({ value: connectionId(item), label: `${normalizeBase(item.apiBase)} · ${item.apiKeyEnv}` }))}
              onValueChange={value => setConnection(connections.find(item => connectionId(item) === value) ?? null)} />
          </div><Button type="button" variant="outline" disabled={!!pending}
            onClick={() => setConnection({ apiBase: "", apiKeyEnv: "" })}>新增连接</Button></div>}
          <div className="space-y-2"><label htmlFor="provider-base" className="text-ui font-medium">API Base URL</label>
            <Input id="provider-base" value={connection?.apiBase ?? ""} disabled={!!pending}
              onChange={event => setConnection(previous => ({ apiBase: event.target.value, apiKeyEnv: previous?.apiKeyEnv ?? "" }))} /></div>
          <div className="space-y-2"><label htmlFor="provider-key" className="text-ui font-medium">API Key 环境变量名称</label>
            <Input id="provider-key" value={connection?.apiKeyEnv ?? ""} disabled={!!pending}
              onChange={event => setConnection(previous => ({ apiBase: previous?.apiBase ?? "", apiKeyEnv: event.target.value }))} />
            <p className="text-caption text-muted-foreground">只填写环境变量名称，密钥保存在服务器受限配置中。</p></div>
          <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" disabled={!canDiscover(connection) || !!pending || catalog.state === "loading"}
            onClick={() => setCatalogReload(value => value + 1)}>刷新模型列表</Button>
            <span className="text-caption text-muted-foreground">{catalog.state === "loading" ? "正在获取供应商模型…"
              : catalog.state === "error" ? catalog.message
                : catalog.state === "idle" ? "填写供应商地址与凭据引用后自动获取。" : `已获取 ${catalog.models.length} 个模型。`}</span></div>
        </div> : <div className="space-y-4 border-t border-border pt-4">
          {(!cliPath || (["unavailable", "timeout"].includes(codex.connection.state) && codex.discovery.state === "not_found")) &&
            <p role="status" className="text-ui text-muted-foreground">未检测到 Codex，请先在 Ubuntu 安装。</p>}
          {["unavailable", "timeout"].includes(codex.connection.state) && codex.discovery.state === "found"
            && !!codex.configuration.cli_path && codex.configuration.cli_path !== codex.discovery.path &&
            <Button type="button" variant="outline" size="sm" disabled={!!pending} onClick={() => {
              cliPathEdited.current = true; setCliPath(codex.discovery.path); setNotice("");
            }}>使用新安装的 Codex</Button>}
          <div className="space-y-2"><span className="text-ui font-medium">认证方式</span>
            <Select aria-label="认证方式" value={authMode} disabled={!!pending} onValueChange={value => {
              authModeEdited.current = true; setAuthMode(value as "chatgpt" | "api_key"); setNotice("");
            }} options={[{ value: "chatgpt", label: "ChatGPT 账号" }, { value: "api_key", label: "API Key" }]} /></div>
          <div className="flex flex-wrap items-center gap-3"><Button type="button" disabled={!!pending || !revision || !cliDirty || !cliPath} onClick={() => void saveConnection()}>保存连接</Button>
            <Button type="button" variant="outline" disabled={!!pending || !revision || cliDirty || !codex.configuration.cli_path}
              onClick={() => void probe()}>{pending === "probe" ? "检测中…" : "检测连接"}</Button></div>
          {codex.connection.state === "not_configured" ? cliPath && <p className="text-ui text-muted-foreground">请保存连接。</p>
            : <p className="text-ui text-muted-foreground">{codex.connection.message || "尚未检测连接。"}</p>}
        </div>}
        {notice && <p role="status" className="text-ui text-muted-foreground">{notice}</p>}
        <div className="space-y-4 border-t border-border pt-4">
          <h3 className="text-title-sm font-semibold">模型列表</h3>
          <p className="text-caption text-muted-foreground">模型权限以实际调用为准。</p>
          {settings.synchronized === false && <p className="text-ui text-muted-foreground">配置尚未同步至服务，暂不能保存模型更改。</p>}
          {provider === "codex" && ["not_checked", "not_configured"].includes(codex.connection.state) && rows.listed.length > 0 &&
            <p className="text-caption text-muted-foreground">显示上次缓存，实际权限未验证。</p>}
          {provider === "codex" && rows.listed.length === 0 && <p className="text-ui text-muted-foreground">尚未取得 Codex 模型，请检测连接。</p>}
          {provider === "custom" && catalog.state === "ready" && rows.listed.length === 0 && <p className="text-ui text-muted-foreground">供应商未返回模型。</p>}
          <div>{rows.listed.map(renderRow)}</div>
          {rows.missing.length > 0 && <div><h4 className="text-ui font-medium">已配置但未返回</h4>
            {rows.missing.map(renderRow)}</div>}
        </div>
      </>}
    </section>
    <Dialog open={!!problem || !!editor} onOpenChange={open => {
      if (!open) { if (problem) setProblem(null); else setEditor(null); }
    }}><DialogContent className="max-h-[90vh] overflow-y-auto" showCloseButton={false}>
      {problem ? <><DialogHeader><DialogTitle>{problem.title}</DialogTitle><DialogDescription>{problem.description}</DialogDescription>
      </DialogHeader><DialogFooter>{problem.login && <Button asChild><a href="/admin">前往管理员登录</a></Button>}
        {problem.refresh && <Button onClick={() => { setProblem(null); setReload(value => value + 1); }}>刷新配置状态</Button>}
        <Button variant="outline" onClick={() => setProblem(null)}>关闭</Button></DialogFooter></> : renderEditor()}
    </DialogContent></Dialog>
  </>;
}
