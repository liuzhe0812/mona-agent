import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AdminRequestError, isValidPriceAmount, requestCodexStatus, requestModelSettings,
  type ApiModelConfiguration, type BillingMode, type CodexConfiguration, type CodexStatus, type ManagedModel,
  type ModelPrice, type ModelSettings } from "./model-admin-api";

type Provider = "custom" | "codex";
type Draft = {
  id: string; label: string; model: string; api_base: string; api_key_env: string; cli_path: string;
  auth_mode: "chatgpt" | "api_key"; billing_mode: BillingMode;
  context_window_tokens: string; max_output_tokens: string; reasoning_effort: string;
  input_price: string; cached_input_price: string; output_price: string;
};
type FieldErrors = Partial<Record<keyof Draft, string>>;
type Problem = { title: string; description: string; login?: boolean; refresh?: boolean };

const blank = (): Draft => ({ id: "", label: "", model: "", api_base: "", api_key_env: "", cli_path: "",
  auth_mode: "chatgpt", billing_mode: "wallet", context_window_tokens: "",
  max_output_tokens: "4096", reasoning_effort: "", input_price: "", cached_input_price: "", output_price: "" });
function commonDraft(config: ApiModelConfiguration | CodexConfiguration): Draft {
  return { ...blank(), label: config.label, model: config.model, billing_mode: config.billing_mode,
    context_window_tokens: config.context_window_tokens == null ? "" : String(config.context_window_tokens),
    max_output_tokens: String(config.max_output_tokens), reasoning_effort: config.reasoning_effort ?? "",
    input_price: config.price?.input_amount_per_million ?? "", cached_input_price: config.price?.cached_input_amount_per_million ?? "",
    output_price: config.price?.output_amount_per_million ?? "" };
}
function modelDraft(item: ManagedModel): Draft {
  return { ...commonDraft(item.configuration), id: item.id, api_base: item.configuration.api_base, api_key_env: item.configuration.api_key_env };
}
function codexDraft(config: CodexConfiguration): Draft {
  return { ...commonDraft(config), cli_path: config.cli_path, auth_mode: config.auth_mode };
}
function withPrice(target: Draft, source: Draft): Draft {
  return { ...target, input_price: source.input_price, cached_input_price: source.cached_input_price, output_price: source.output_price };
}

export function ModelSettingsPanel({ token }: { token: string }) {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [revision, setRevision] = useState("");
  const [provider, setProvider] = useState<Provider>("custom");
  const [selected, setSelected] = useState<string | null>(null);
  const [modelsDraft, setModelsDraft] = useState<Record<string, Draft>>({});
  const [codexForm, setCodexForm] = useState<Draft | null>(null);
  const previousModels = useRef<ModelSettings | null>(null);
  const previousCodex = useRef<CodexStatus | null>(null);
  const cliPathEdited = useRef(false);
  const autoDetectedPath = useRef<string | null>(null);
  const editedPrices = useRef(new Set<string>());
  const [pending, setPending] = useState<"load" | "save" | "probe" | null>("load");
  const [reload, setReload] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);

  function failed(error: unknown) {
    if (error instanceof AdminRequestError) {
      if (error.status === 401 || error.status === 403) {
        setProblem({ title: error.status === 401 ? "需要管理员登录" : "没有管理权限",
          description: "请前往管理后台登录有权限的管理员账号。草稿已保留。", login: true });
        return;
      }
      if (error.code === "invalid_endpoint") {
        setErrors(previous => ({ ...previous, api_base: "请输入公网 HTTPS API 地址，不要包含账号、密码或密钥。" }));
        return;
      }
      if (error.code === "credential_not_ready") {
        setErrors(previous => ({ ...previous, api_key_env: "当前服务尚未加载此环境变量，请先在服务器受限配置中配置并加载。" }));
        return;
      }
      if (error.code === "work_busy") {
        setProblem({ title: "工作台正在处理任务", description: "请在当前任务结束后保存。草稿已保留。" });
        return;
      }
      if (error.code === "configuration_changed") {
        setRevision("");
        setProblem({ title: "配置已变化", description: "其他配置操作已更新版本，请刷新状态并核对后再保存。草稿已保留。", refresh: true });
        return;
      }
      const field = ({ model_id: "id", input_amount_per_million: "input_price", cached_input_amount_per_million: "cached_input_price",
        output_amount_per_million: "output_price", price: "input_price" } as Record<string, string>)[error.field ?? ""] ?? error.field;
      if (field && ["id", "label", "model", "api_key_env", "cli_path", "max_output_tokens", "context_window_tokens",
        "reasoning_effort", "input_price", "cached_input_price", "output_price"].includes(field)) {
        setErrors(previous => ({ ...previous, [field]: "该字段未通过服务器校验，请检查后重试。" }));
        return;
      }
    }
    setProblem({ title: "操作未完成", description: "无法完成模型配置操作，请检查连接后重试。草稿已保留。" });
  }

  useEffect(() => {
    const controller = new AbortController();
    setPending("load");
    Promise.all([requestModelSettings(token, undefined, controller.signal), requestCodexStatus(token, "GET", undefined, controller.signal)])
      .then(([models, status]) => {
        if (controller.signal.aborted) return;
        const oldModels = previousModels.current;
        const oldCodex = previousCodex.current;
        setSettings(models);
        setCodex(status);
        setModelsDraft(previous => {
          const result = { ...previous };
          if (!result[""]) result[""] = blank();
          for (const item of models.models) {
            const old = oldModels?.models.find(model => model.id === item.id);
            if (!result[item.id] || old && JSON.stringify(result[item.id]) === JSON.stringify(modelDraft(old))) {
              result[item.id] = modelDraft(item);
            } else if (!editedPrices.current.has(`custom:${item.id}`)) {
              result[item.id] = withPrice(result[item.id], modelDraft(item));
            }
          }
          return result;
        });
        setSelected(previous => previous === null ? models.models.find(item => item.configuration.source === "mona")?.id ?? "" : previous);
        setCodexForm(previous => {
          let next = !previous || oldCodex && JSON.stringify(previous) === JSON.stringify(codexDraft(oldCodex.configuration))
            ? codexDraft(status.configuration) : previous;
          if (!editedPrices.current.has("codex")) next = withPrice(next, codexDraft(status.configuration));
          if (status.configuration.cli_path && !cliPathEdited.current && autoDetectedPath.current &&
            next.cli_path === autoDetectedPath.current) {
            next = { ...next, cli_path: status.configuration.cli_path };
            autoDetectedPath.current = null;
          }
          if (!status.configuration.cli_path && !cliPathEdited.current && !next.cli_path && status.discovery.state === "found") {
            autoDetectedPath.current = status.discovery.path;
            next = { ...next, cli_path: status.discovery.path! };
          }
          return next;
        });
        previousModels.current = models;
        previousCodex.current = status;
        if (models.revision !== status.revision) {
          setRevision("");
          setProblem({ title: "配置已变化", description: "配置在读取时发生变化，请刷新状态并核对后再保存。草稿已保留。", refresh: true });
        } else setRevision(models.revision);
      }).catch(error => { if (!controller.signal.aborted) failed(error); })
      .finally(() => { if (!controller.signal.aborted) setPending(null); });
    return () => controller.abort();
  }, [token, reload]);

  useEffect(() => {
    if (provider !== "codex" || !codex || codex.configuration.cli_path || !revision || pending) return;
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
        setCodex(previous => previous ? { ...previous, revision, discovery: status.discovery } : previous);
        setCodexForm(previous => {
          if (!previous || status.configuration.cli_path || cliPathEdited.current || previous.cli_path || status.discovery.state !== "found") return previous;
          autoDetectedPath.current = status.discovery.path;
          return { ...previous, cli_path: status.discovery.path! };
        });
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

  const draft = provider === "custom" ? selected === null ? null : modelsDraft[selected] ?? null : codexForm;
  const models = settings?.models.filter(item => item.configuration.source === "mona") ?? [];
  const current = selected === null ? undefined : models.find(item => item.id === selected);
  const dirtyCodex = !!codexForm && !!codex && JSON.stringify(codexForm) !== JSON.stringify(codexDraft(codex.configuration));

  function change(field: keyof Draft, value: string) {
    if (provider === "codex" && field === "cli_path") {
      cliPathEdited.current = true;
      autoDetectedPath.current = null;
    }
    if (["input_price", "cached_input_price", "output_price"].includes(field)) {
      editedPrices.current.add(provider === "codex" ? "codex" : `custom:${selected ?? ""}`);
    }
    if (provider === "custom" && selected !== null) {
      setModelsDraft(previous => previous[selected] ? { ...previous, [selected]: { ...previous[selected], [field]: value } } : previous);
    } else if (provider === "codex") setCodexForm(previous => previous ? { ...previous, [field]: value } : previous);
    setErrors(previous => ({ ...previous, [field]: undefined }));
    setNotice("");
  }

  function selectProvider(next: Provider) {
    setProvider(next);
    setErrors({});
    setNotice("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !settings || !codex || !revision || pending) return;
    const next = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim()])) as Draft;
    const invalid: FieldErrors = {};
    if (provider === "custom" && !/^[a-z0-9_-]{1,64}$/.test(next.id)) invalid.id = "使用 1–64 位小写字母、数字、下划线或短横线。";
    else if (provider === "custom" && models.some(item => item.id === next.id && item.id !== selected)) {
      invalid.id = "此模型标识已存在，请先选择该模型。";
    }
    if (!next.label || next.label.length > 80 || /[\x00-\x1f\x7f]/.test(next.label)) invalid.label = "请输入不超过 80 个字符的名称。";
    if ((provider === "custom" && !next.model) || next.model.length > 200 || /[\x00-\x1f\x7f]/.test(next.model)) invalid.model = "请输入有效的模型 ID。";
    const priceKeys = ["input_price", "cached_input_price", "output_price"] as const;
    if (priceKeys.some(key => next[key])) for (const key of priceKeys) {
      if (!next[key]) invalid[key] = "请填写三项价格，或全部留空。";
      else if (!isValidPriceAmount(next[key])) invalid[key] = "请输入不超过 1000000000 的非负金额，最多 6 位小数。";
    }
    if (!/^\d+$/.test(next.max_output_tokens) || +next.max_output_tokens < 256 || +next.max_output_tokens > 32768) invalid.max_output_tokens = "输出上限应为 256–32768。";
    if (next.context_window_tokens && (!/^\d+$/.test(next.context_window_tokens) || +next.context_window_tokens < 4096 || +next.context_window_tokens > 2000000)) invalid.context_window_tokens = "输入预算上限应为 4096–2000000，或留空。";
    if (next.reasoning_effort.length > 64 || /[\x00-\x1f\x7f]/.test(next.reasoning_effort)) invalid.reasoning_effort = "请输入有效的推理强度，或留空。";
    if (provider === "custom") {
      if (!/^MONA_WORK_MODEL_[A-Z0-9_]+$/.test(next.api_key_env)) invalid.api_key_env = "请输入 MONA_WORK_MODEL_ 开头的大写环境变量名称，不能填写密钥。";
      try {
        const url = new URL(next.api_base);
        const saved = settings.models.find(item => item.id === next.id)?.configuration.api_base;
        const retainedLocal = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
          && !!saved && new URL(saved).origin === url.origin;
        if ((url.protocol !== "https:" && !retainedLocal) || url.username || url.password || url.search || url.hash) throw new Error();
      } catch { invalid.api_base = "请输入公网 HTTPS API 地址，不要包含账号、密码或密钥。"; }
    } else if (next.cli_path && (!next.cli_path.startsWith("/") || next.cli_path.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(next.cli_path) || next.cli_path.split("/").some(part => part === "." || part === ".."))) {
      invalid.cli_path = "请输入 Ubuntu 上的绝对程序路径。";
    }
    setErrors(invalid);
    if (Object.keys(invalid).length) return;

    const price: ModelPrice | null = priceKeys.some(key => next[key]) ? {
      input_amount_per_million: next.input_price, cached_input_amount_per_million: next.cached_input_price,
      output_amount_per_million: next.output_price,
    } : null;
    const editedPriceKey = provider === "codex" ? "codex" : `custom:${selected ?? ""}`;
    const copiedPrice = provider === "custom" && !models.some(item => item.id === next.id) && price !== null;
    const common = { label: next.label, model: next.model, billing_mode: next.billing_mode,
      ...(editedPrices.current.has(editedPriceKey) || copiedPrice ? { price } : {}),
      context_window_tokens: next.context_window_tokens ? +next.context_window_tokens : null,
      max_output_tokens: +next.max_output_tokens, reasoning_effort: next.reasoning_effort || null };
    setPending("save");
    setNotice("");
    try {
      if (provider === "custom") {
        const configuration = { ...common, source: "mona" as const, api_base: next.api_base, api_key_env: next.api_key_env };
        const saved = await requestModelSettings(token, { expected_revision: revision, model_id: next.id, configuration });
        const model = saved.models.find(item => item.id === next.id);
        if (!model) throw new AdminRequestError(0, "invalid_response");
        setSettings(saved);
        editedPrices.current.delete(editedPriceKey);
        previousModels.current = saved;
        setModelsDraft(previous => {
          const result = { ...previous, [next.id]: modelDraft(model) };
          if (selected === "") result[""] = blank();
          else if (selected !== null && selected !== next.id) {
            const original = saved.models.find(item => item.id === selected);
            if (original) result[selected] = modelDraft(original);
            else delete result[selected];
          }
          return result;
        });
        setSelected(next.id);
        setRevision(saved.revision);
      } else {
        const configuration = { ...common, cli_path: next.cli_path, auth_mode: next.auth_mode };
        const saved = await requestCodexStatus(token, "PUT", { expected_revision: revision, configuration });
        editedPrices.current.delete(editedPriceKey);
        autoDetectedPath.current = null;
        setCodex(saved);
        previousCodex.current = saved;
        setCodexForm(codexDraft(saved.configuration));
        setRevision(saved.revision);
      }
      setNotice("模型配置已保存。实际可用状态以服务信息为准。");
    } catch (error) { failed(error); }
    finally { setPending(null); }
  }

  async function probe() {
    if (!codex || !revision || pending || dirtyCodex) return;
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
      previousCodex.current = result;
      setCodexForm(codexDraft(result.configuration));
      setRevision(result.revision);
      setNotice("检测已完成，请查看连接状态。");
    } catch (error) { failed(error); }
    finally { setPending(null); }
  }

  const field = (key: keyof Draft, label: string, help?: string, numeric = false, decimal = false) => <div className="space-y-2">
    <label className="text-ui font-medium" htmlFor={`model-${key}`}>{label}</label>
    <Input id={`model-${key}`} type={numeric ? "number" : "text"} value={draft?.[key] ?? ""}
      inputMode={decimal ? "decimal" : undefined}
      list={provider === "codex" && key === "model" ? "codex-models" : undefined}
      onChange={event => change(key, event.target.value)} disabled={!!pending}
      aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `model-${key}-error` : help ? `model-${key}-help` : undefined} />
    {provider === "codex" && key === "model" && <datalist id="codex-models">{codex?.connection.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>}
    {errors[key] ? <p id={`model-${key}-error`} className="text-caption text-destructive">{errors[key]}</p>
      : help && <p id={`model-${key}-help`} className="text-caption text-muted-foreground">{help}</p>}
  </div>;

  return <>
    <section className="space-y-4 rounded-lg border border-border bg-card p-6" aria-label="模型配置">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-title-sm font-semibold">模型配置</h2>
        <Button type="button" variant="outline" disabled={!!pending} onClick={() => setReload(value => value + 1)}>刷新模型状态</Button></div>
      <div role="group" aria-label="模型提供者" className="flex flex-wrap gap-2">
        <Button type="button" variant={provider === "custom" ? "secondary" : "ghost"} aria-pressed={provider === "custom"} disabled={!!pending}
          onClick={() => selectProvider("custom")}>自定义 API</Button>
        <Button type="button" variant={provider === "codex" ? "secondary" : "ghost"} aria-pressed={provider === "codex"} disabled={!!pending}
          onClick={() => selectProvider("codex")}>Codex CLI</Button>
      </div>
      {!draft || !settings || !codex ? <p className="text-ui text-muted-foreground">{pending === "load" ? "正在加载模型配置…" : "模型配置未加载。"}</p>
        : <form className="space-y-4 border-t border-border pt-4" onSubmit={save} noValidate>
          {provider === "custom" && <div className="flex flex-wrap items-center gap-3"><div className="min-w-48 flex-1">
            <Select aria-label="选择模型" value={models.some(item => item.id === selected) ? selected ?? undefined : undefined}
              disabled={!!pending} placeholder="新增模型" options={models.map(item => ({ value: item.id, label: `${item.configuration.label} (${item.id})` }))}
              onValueChange={id => { setSelected(id); setErrors({}); setNotice(""); }} /></div>
            <Button type="button" variant="outline" disabled={!!pending} onClick={() => { setSelected(""); setErrors({}); setNotice(""); }}>新增模型</Button>
          </div>}
          {provider === "custom" && current && <div className="space-y-1 text-ui text-muted-foreground">
            <p>凭据：{current.credentials.configured ? "已加载" : "尚未加载"}。</p>
            <p>当前已保存状态：{current.availability.message}</p>
            {settings.synchronized === false && <p>配置尚未同步至服务。</p>}
          </div>}
          {provider === "codex" && <div className="space-y-1 text-ui text-muted-foreground">
            <p>{codex.execution.message}</p><p>当前已保存计费状态：{codex.billing.message}</p>
          </div>}
          <div className="grid gap-4 md:grid-cols-2">
            {provider === "custom" && field("id", "平台模型标识")}
            {field("label", "显示名称")}{field("model", "模型 ID")}
            {provider === "custom" ? field("api_base", "API Base URL") : field("cli_path", "CLI 程序路径", "填写 Ubuntu 上 Codex 程序的绝对路径。")}
          </div>
          {provider === "codex" && <div className="space-y-2 text-ui text-muted-foreground">
            <p role="status">{codex.discovery.state === "found" ? `已检测到 Codex CLI：${codex.discovery.path}`
              : codex.configuration.cli_path ? "未发现其他安装位置，可检查已保存的程序路径。" : "尚未检测到 Codex CLI，安装后会自动重新检测。"}</p>
            {codex.discovery.state === "found" && <Button type="button" variant="outline" disabled={!!pending}
              onClick={() => change("cli_path", codex.discovery.path!)}>使用检测到的路径</Button>}
            {codex.discovery.state === "found" && !codex.configuration.cli_path && draft.cli_path === codex.discovery.path &&
              <p>路径已填入，请保存配置后检查连接。</p>}
          </div>}
          {provider === "custom" ? field("api_key_env", "API Key 环境变量名称", "只填写变量名称。密钥由运维写入服务器受限配置并加载，本页面不接收或显示密钥。")
            : <div className="space-y-2"><span className="text-ui font-medium">认证方式</span>
              <Select aria-label="认证方式" value={draft.auth_mode} disabled={!!pending} onValueChange={value => change("auth_mode", value)} options={[
                { value: "chatgpt", label: "ChatGPT 账号" }, { value: "api_key", label: "API Key" },
              ]} /></div>}
          <div className="grid gap-4 md:grid-cols-2">{field("max_output_tokens", "最大输出 token", undefined, true)}
            {field("context_window_tokens", "输入预算上限（可选）", "留空沿用模型目录；此预算不改变模型的真实上下文窗口。", true)}</div>
          {field("reasoning_effort", "推理强度（可选）", "按供应商支持填写，例如 low、medium、high；不使用时留空。")}
          <div className="space-y-2"><span className="text-ui font-medium">计费方式</span>
            <Select aria-label="计费方式" value={draft.billing_mode} disabled={!!pending} onValueChange={value => change("billing_mode", value)} options={[
              { value: "free", label: "免费" }, { value: "wallet", label: "共用余额" },
            ]} />
          </div>
          <fieldset className="space-y-3 border-t border-border pt-4" aria-label="工作台模型价格">
            <legend className="text-ui font-medium">模型价格</legend>
            <p className="text-caption text-muted-foreground">人民币 / 百万 token。三项可全部留空，0 表示价格为零。</p>
            <div className="grid gap-4 md:grid-cols-3">
              {field("input_price", "输入价格", undefined, false, true)}
              {field("cached_input_price", "缓存输入价格", undefined, false, true)}
              {field("output_price", "输出价格", undefined, false, true)}
            </div>
            {draft.billing_mode === "free" && <p className="text-caption text-muted-foreground">当前选择免费，不按模型价格扣费。</p>}
            {draft.billing_mode === "wallet" && !settings.billing.ready &&
              (provider === "custom" ? !current || current.configuration.billing_mode !== "wallet" : codex.configuration.billing_mode !== "wallet") &&
              <p className="text-caption text-muted-foreground">余额计费尚未接通，选择共用余额的模型暂不可调用。</p>}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!!pending || !revision}>{pending === "save" ? "保存中…" : "保存配置"}</Button>
            {provider === "codex" && <Button type="button" variant="outline" onClick={probe} disabled={!!pending || !revision || dirtyCodex || !codex.configuration.cli_path}>
              {pending === "probe" ? "检测中…" : "检测连接"}</Button>}
            {provider === "codex" && dirtyCodex && <span className="text-caption text-muted-foreground">请先保存更改，再检测服务器上的配置。</span>}
          </div>
          {notice && <p role="status" className="text-ui text-muted-foreground">{notice}</p>}
          {provider === "codex" && <>
            <div className="space-y-2 border-t border-border pt-4"><h3 className="text-ui font-medium">连接状态</h3><p className="text-ui text-muted-foreground">{codex.connection.message || "尚未检测。"}</p></div>
            <details className="border-t border-border pt-4 text-ui"><summary className="cursor-pointer font-medium">Ubuntu 登录说明</summary>
              <p className="mt-3 text-muted-foreground">凭据保存在服务器上，请在 Ubuntu 终端完成登录，不要在此页面填写凭据。</p>
              {codex.login_commands.length ? <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3">{codex.login_commands.join("\n")}</pre> : <p className="mt-3 text-muted-foreground">配置程序后显示登录说明。</p>}
            </details>
          </>}
        </form>}
    </section>
    <Dialog open={!!problem} onOpenChange={open => { if (!open) setProblem(null); }}><DialogContent><DialogHeader>
      <DialogTitle>{problem?.title}</DialogTitle><DialogDescription>{problem?.description}</DialogDescription>
    </DialogHeader><DialogFooter>{problem?.login && <Button asChild><a href="/admin">前往管理员登录</a></Button>}
      {problem?.refresh && <Button onClick={() => { setProblem(null); setReload(value => value + 1); }}>刷新配置状态</Button>}
      <Button variant="outline" onClick={() => setProblem(null)}>关闭</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
