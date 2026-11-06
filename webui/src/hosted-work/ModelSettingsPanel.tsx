import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AdminRequestError, latestModelPrice, readAdminToken, requestModelPrices, requestModelSettings,
  type ApiModelConfiguration, type ManagedModel, type ModelPrice, type ModelSettings } from "./model-admin-api";

type Draft = { id: string; label: string; model: string; api_base: string; api_key_env: string;
  context_window_tokens: string; max_output_tokens: string; reasoning_effort: string };
type FieldErrors = Partial<Record<keyof Draft, string>>;
const blank = (): Draft => ({ id: "", label: "", model: "", api_base: "", api_key_env: "",
  context_window_tokens: "", max_output_tokens: "4096", reasoning_effort: "" });
function modelDraft(item: ManagedModel): Draft {
  const c = item.configuration;
  return { id: item.id, label: c.label, model: c.model, api_base: c.api_base, api_key_env: c.api_key_env,
    context_window_tokens: c.context_window_tokens == null ? "" : String(c.context_window_tokens),
    max_output_tokens: String(c.max_output_tokens), reasoning_effort: c.reasoning_effort ?? "" };
}

export function ModelSettingsPanel({ token, revision, billingModel, onRevisionChange, disabled = false }: {
  token: string; revision: string; billingModel: string; onRevisionChange: (revision: string) => void; disabled?: boolean;
}) {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState<{ title: string; description: string; login?: boolean; refresh?: boolean } | null>(null);
  const priceToken = readAdminToken() ?? token;
  const [prices, setPrices] = useState<ModelPrice[] | null>(null);
  const [pricesLoading, setPricesLoading] = useState(!!priceToken);
  const [priceError, setPriceError] = useState("");
  const [priceReload, setPriceReload] = useState(0);

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
        setErrors(previous => ({ ...previous, api_key_env: "当前服务尚未加载此环境变量。请由运维在服务器受限配置中配置并加载后重试。" }));
        return;
      }
      if (error.code === "work_busy") {
        setProblem({ title: "工作台正在处理任务", description: "请在当前任务结束后保存。草稿已保留。" });
        return;
      }
      if (error.code === "configuration_changed") {
        setProblem({ title: "配置已变化", description: "其他配置操作已更新版本，请刷新状态并核对后再保存。草稿已保留。", refresh: true });
        return;
      }
      const field = error.field === "model_id" ? "id" : error.field;
      if (field && ["id", "label", "model", "api_key_env", "max_output_tokens", "context_window_tokens", "reasoning_effort"].includes(field)) {
        setErrors(previous => ({ ...previous, [field]: "该字段未通过服务器校验，请检查后重试。" }));
        return;
      }
    }
    setProblem({ title: "操作未完成", description: "无法完成模型配置操作，请检查连接后重试。草稿已保留。" });
  }

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    requestModelSettings(token, undefined, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      setSettings(next);
      setDraft(previous => previous ?? (next.models.find(item => item.configuration.source === "mona")
        ? modelDraft(next.models.find(item => item.configuration.source === "mona")!) : blank()));
      onRevisionChange(next.revision);
    }).catch(error => { if (!controller.signal.aborted) failed(error); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [token, reload, onRevisionChange]);

  useEffect(() => {
    if (!priceToken) return;
    const controller = new AbortController();
    setPricesLoading(true);
    setPriceError("");
    requestModelPrices(priceToken, controller.signal).then(next => {
      if (!controller.signal.aborted) setPrices(next);
    }).catch(error => {
      if (!controller.signal.aborted) setPriceError(error instanceof AdminRequestError && [401, 403].includes(error.status)
        ? "请重新登录管理后台查看共用价格。" : "共用价格暂时无法读取，请重试。");
    }).finally(() => { if (!controller.signal.aborted) setPricesLoading(false); });
    return () => controller.abort();
  }, [priceToken, priceReload]);

  function change(field: keyof Draft, value: string) {
    setDraft(previous => previous ? { ...previous, [field]: value } : previous);
    setErrors(previous => ({ ...previous, [field]: undefined }));
    setNotice("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !settings || busy || disabled) return;
    const next = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim()])) as Draft;
    const invalid: FieldErrors = {};
    if (!/^[a-z0-9_-]{1,64}$/.test(next.id)) invalid.id = "使用 1–64 位小写字母、数字、下划线或短横线。";
    if (settings.models.some(item => item.id === next.id && item.configuration.source !== "mona")) invalid.id = "该标识属于其他模型来源，请使用新标识。";
    if (!next.label || next.label.length > 80 || /[\x00-\x1f\x7f]/.test(next.label)) invalid.label = "请输入不超过 80 个字符的名称。";
    if (!next.model || next.model.length > 200 || /[\x00-\x1f\x7f]/.test(next.model)) invalid.model = "请输入有效的供应商模型 ID。";
    if (!/^MONA_WORK_MODEL_[A-Z0-9_]+$/.test(next.api_key_env)) invalid.api_key_env = "请输入 MONA_WORK_MODEL_ 开头的大写环境变量名称，不能填写密钥。";
    try {
      const url = new URL(next.api_base);
      const saved = settings.models.find(item => item.id === next.id)?.configuration.api_base;
      const retainedLocal = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
        && !!saved && new URL(saved).origin === url.origin;
      if ((url.protocol !== "https:" && !retainedLocal) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { invalid.api_base = "请输入公网 HTTPS API 地址，不要包含账号、密码或密钥。"; }
    if (!/^\d+$/.test(next.max_output_tokens) || +next.max_output_tokens < 256 || +next.max_output_tokens > 32768) invalid.max_output_tokens = "输出上限应为 256–32768。";
    if (next.context_window_tokens && (!/^\d+$/.test(next.context_window_tokens) || +next.context_window_tokens < 4096 || +next.context_window_tokens > 2000000)) invalid.context_window_tokens = "输入预算上限应为 4096–2000000，或留空。";
    if (next.reasoning_effort.length > 80 || /[\x00-\x1f\x7f]/.test(next.reasoning_effort)) invalid.reasoning_effort = "请输入有效的推理强度，或留空。";
    setErrors(invalid);
    if (Object.keys(invalid).length) return;
    const configuration: ApiModelConfiguration = { label: next.label, source: "mona", model: next.model,
      api_base: next.api_base, api_key_env: next.api_key_env,
      context_window_tokens: next.context_window_tokens ? +next.context_window_tokens : null,
      max_output_tokens: +next.max_output_tokens, reasoning_effort: next.reasoning_effort || null };
    setBusy(true);
    setNotice("");
    try {
      const saved = await requestModelSettings(token, { expected_revision: revision || settings.revision, model_id: next.id, configuration });
      setSettings(saved);
      setDraft(modelDraft(saved.models.find(item => item.id === next.id)!));
      onRevisionChange(saved.revision);
      setNotice("免费 API 配置已保存。用户无需付费，凭据状态以当前服务信息为准。");
    } catch (error) { failed(error); }
    finally { setBusy(false); }
  }

  const models = settings?.models.filter(item => item.configuration.source === "mona") ?? [];
  const price = latestModelPrice(prices ?? [], billingModel);
  const field = (key: keyof Draft, label: string, help?: string, numeric = false) => <div className="space-y-2">
    <label className="text-ui font-medium" htmlFor={`api-${key}`}>{label}</label>
    <Input id={`api-${key}`} type={numeric ? "number" : "text"} value={draft?.[key] ?? ""}
      onChange={event => change(key, event.target.value)} disabled={busy || disabled}
      aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `api-${key}-error` : help ? `api-${key}-help` : undefined} />
    {errors[key] ? <p id={`api-${key}-error`} className="text-caption text-destructive">{errors[key]}</p>
      : help && <p id={`api-${key}-help`} className="text-caption text-muted-foreground">{help}</p>}
  </div>;

  return <>
    <section className="space-y-4 rounded-lg border border-border bg-card p-6" aria-label="免费 API 模型配置">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-title-sm font-semibold">免费 API 模型</h2>
        <Button type="button" variant="outline" disabled={busy || disabled} onClick={() => setReload(value => value + 1)}>刷新模型状态</Button></div>
      <p className="text-ui text-muted-foreground">这些线路向所有账号免费开放，不扣用户余额。供应商调用费用由配置方承担。</p>
      {settings && (models.length ? <ul className="space-y-3 text-ui">{models.map(item => <li key={item.id}>
        <p className="font-medium">{item.configuration.label} <span className="font-normal text-muted-foreground">({item.id})</span></p>
        <p className="text-muted-foreground">{item.credentials.configured ? "当前服务已加载凭据。" : "当前服务尚未加载凭据，暂不可调用；请由运维配置服务器受限环境。"}
          {settings.synchronized === false ? "配置尚未同步至服务。" : item.credentials.configured ? "所有账号免费，不扣余额。" : ""}</p>
      </li>)}</ul> : <p className="text-ui text-muted-foreground">尚未配置免费 API 模型。</p>)}
      {!draft ? <p className="text-ui text-muted-foreground">{busy ? "正在加载模型配置…" : "模型配置未加载。"}</p> : <form className="space-y-4 border-t border-border pt-4" onSubmit={save} noValidate>
        <div className="flex flex-wrap items-center gap-3"><div className="min-w-48 flex-1"><Select aria-label="选择免费 API 模型" value={models.some(item => item.id === draft.id) ? draft.id : undefined}
          disabled={busy || disabled} placeholder="新增免费 API 模型" options={models.map(item => ({ value: item.id, label: `${item.configuration.label} (${item.id})` }))}
          onValueChange={id => { setDraft(modelDraft(models.find(item => item.id === id)!)); setErrors({}); setNotice(""); }} /></div>
          <Button type="button" variant="outline" disabled={busy || disabled} onClick={() => { setDraft(blank()); setErrors({}); setNotice(""); }}>新增免费 API 模型</Button></div>
        <div className="grid gap-4 md:grid-cols-2">
          {field("id", "平台模型标识")}{field("label", "API 显示名称")}
          {field("model", "供应商模型 ID")}{field("api_base", "API Base URL")}
        </div>
        {field("api_key_env", "API Key 环境变量名称", "只填写变量名称。密钥由运维写入服务器受限配置并加载，本页面不接收或显示密钥。")}
        <div className="grid gap-4 md:grid-cols-2">{field("max_output_tokens", "最大输出 token", undefined, true)}
          {field("context_window_tokens", "输入预算上限（可选）", "留空沿用模型目录；此预算不改变模型的真实上下文窗口。", true)}</div>
        {field("reasoning_effort", "推理强度（可选）", "按供应商支持填写，例如 low、medium、high；不使用时留空。")}
        <Button type="submit" disabled={busy || disabled}>{busy ? "正在保存…" : "保存免费 API 配置"}</Button>
        {notice && <p role="status" className="text-ui text-muted-foreground">{notice}</p>}
      </form>}
    </section>
    <section className="space-y-4 rounded-lg border border-border bg-card p-6" aria-label="共用模型价格">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-title-sm font-semibold">共用余额与模型价格</h2>
        <Button type="button" variant="outline" disabled={!priceToken || pricesLoading} onClick={() => setPriceReload(value => value + 1)}>刷新共用价格</Button></div>
      <p className="text-ui text-muted-foreground">网站与应用使用同一账户余额、同一价格表。修改价格会同时影响应用和网站。</p>
      <p className="text-ui text-muted-foreground">Codex 连接检测与余额计费分开；余额扣费尚未接通，Codex 未向用户开放。</p>
      {!priceToken ? <p className="text-ui">请先登录管理后台查看共用价格。</p> : priceError ? <p className="text-ui">{priceError}</p>
        : pricesLoading ? <p className="text-ui text-muted-foreground">正在读取共用价格…</p> : !billingModel.trim() ? <p className="text-ui text-muted-foreground">填写 Codex 账务模型 ID 后显示对应价格。</p>
          : !price ? <p className="text-ui">账务模型 {billingModel.trim()} 没有已启用的 token 价格。</p> : <div className="space-y-2 text-ui">
            <p className="font-medium">{price.model} · 价格版本 {price.version}</p>
            <dl className="grid gap-3 sm:grid-cols-3">{[["输入", price.input_amount_per_million], ["缓存输入", price.cached_input_amount_per_million], ["输出", price.output_amount_per_million]].map(([label, amount]) => <div key={label}>
              <dt className="text-muted-foreground">{label}</dt><dd>¥{amount} / 百万 token</dd></div>)}</dl>
          </div>}
      <Button variant="outline" asChild><a href="/admin">打开模型服务 → 模型计价</a></Button>
    </section>
    <Dialog open={!!problem} onOpenChange={open => { if (!open) setProblem(null); }}><DialogContent><DialogHeader>
      <DialogTitle>{problem?.title}</DialogTitle><DialogDescription>{problem?.description}</DialogDescription>
    </DialogHeader><DialogFooter>{problem?.login && <Button asChild><a href="/admin">前往管理员登录</a></Button>}
      {problem?.refresh && <Button onClick={() => { setProblem(null); setReload(value => value + 1); }}>刷新配置状态</Button>}
      <Button variant="outline" onClick={() => setProblem(null)}>关闭</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
