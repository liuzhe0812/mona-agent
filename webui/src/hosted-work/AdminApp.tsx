import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type Configuration = {
  cli_path: string;
  model: string;
  billing_model: string;
  label: string;
  auth_mode: "chatgpt" | "api_key";
};

type AdminStatus = {
  revision: string;
  configuration: Configuration;
  connection: { state: string; message: string; models: Array<{ id: string; label: string }> };
  billing: { mode: string; ready: boolean; message: string };
  public_enabled: boolean;
  qwen: { free: boolean; all_accounts: boolean };
  login_commands: string[];
};

type FieldErrors = Partial<Record<"cli_path" | "model" | "billing_model" | "label", string>>;
type Problem = { title: string; description: string; login?: boolean };

function getToken(): string | null {
  const valid = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
  try {
    const adminToken = sessionStorage.getItem("admin_token");
    if (valid(adminToken)) return adminToken;
    const website = JSON.parse(sessionStorage.getItem("mona-website-session-v1") || "null") as { token?: unknown } | null;
    return valid(website?.token) ? website.token : null;
  } catch {
    return null;
  }
}

class RequestError extends Error {
  constructor(readonly status: number) { super("Request failed"); }
}

function parseStatus(value: unknown): AdminStatus {
  if (!value || typeof value !== "object") throw new RequestError(0);
  const status = value as AdminStatus;
  const config = status.configuration;
  const connection = status.connection;
  const billing = status.billing;
  if (typeof status.revision !== "string" || !status.revision || !config ||
    typeof config.cli_path !== "string" || typeof config.model !== "string" ||
    typeof config.billing_model !== "string" || typeof config.label !== "string" ||
    (config.auth_mode !== "chatgpt" && config.auth_mode !== "api_key") ||
    !connection || typeof connection.state !== "string" || typeof connection.message !== "string" ||
    !Array.isArray(connection.models) || !connection.models.every(model => model && typeof model.id === "string" && typeof model.label === "string") ||
    !billing || typeof billing.mode !== "string" || typeof billing.ready !== "boolean" || typeof billing.message !== "string" ||
    typeof status.public_enabled !== "boolean" || !status.qwen || typeof status.qwen.free !== "boolean" ||
    typeof status.qwen.all_accounts !== "boolean" || !Array.isArray(status.login_commands) ||
    !status.login_commands.every(command => typeof command === "string")) throw new RequestError(0);
  return status;
}

async function requestStatus(token: string, method: "GET" | "PUT" | "POST", url: string, body?: unknown, signal?: AbortSignal): Promise<AdminStatus> {
  const response = await fetch(url, {
    method,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (!response.ok) throw new RequestError(response.status);
  return parseStatus(await response.json());
}

function problemFor(error: unknown): Problem {
  if (error instanceof RequestError && error.status === 401) {
    return { title: "需要管理员登录", description: "登录已失效，请前往管理后台重新登录。", login: true };
  }
  if (error instanceof RequestError && error.status === 403) {
    return { title: "没有管理权限", description: "当前账号没有此配置的管理权限，请使用管理员账号登录。", login: true };
  }
  if (error instanceof RequestError && error.status === 409) {
    return { title: "配置已变化", description: "其他管理员已更新配置，请重新加载并检查后再保存。" };
  }
  return { title: "操作未完成", description: "无法完成配置操作，请检查连接后重试。" };
}

function validate(config: Configuration): FieldErrors {
  const errors: FieldErrors = {};
  if (config.cli_path && (!config.cli_path.startsWith("/") || config.cli_path.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(config.cli_path) || config.cli_path.split("/").some(part => part === "." || part === ".."))) {
    errors.cli_path = "请输入 Ubuntu 上的绝对程序路径。";
  }
  if (!config.label || config.label.length > 80 || /[\x00-\x1f\x7f]/.test(config.label)) {
    errors.label = "请输入不超过 80 个字符的显示名称。";
  }
  for (const field of ["model", "billing_model"] as const) {
    if (config[field].length > 200 || /[\x00-\x1f\x7f]/.test(config[field])) errors[field] = "请输入有效的模型 ID。";
  }
  return errors;
}

const endpoint = "/api/work/admin/codex";

export function AdminApp() {
  const [token] = useState(getToken);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [draft, setDraft] = useState<Configuration | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "probe" | null>(token ? "load" : null);
  const [refresh, setRefresh] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setBusy("load");
    requestStatus(token, "GET", endpoint, undefined, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      setStatus(next);
      setDraft({ ...next.configuration });
      setErrors({});
    }).catch(error => {
      if (!controller.signal.aborted) setProblem(problemFor(error));
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(null);
    });
    return () => controller.abort();
  }, [token, refresh]);

  const dirty = !!status && !!draft && JSON.stringify(status.configuration) !== JSON.stringify(draft);

  function change<K extends keyof Configuration>(field: K, value: Configuration[K]) {
    setDraft(previous => previous ? { ...previous, [field]: value } : previous);
    setErrors(previous => ({ ...previous, [field]: undefined }));
    setNotice("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!token || !status || !draft || busy) return;
    const configuration = { ...draft, cli_path: draft.cli_path.trim(), model: draft.model.trim(),
      billing_model: draft.billing_model.trim(), label: draft.label.trim() };
    const validation = validate(configuration);
    setErrors(validation);
    if (Object.keys(validation).length) return;
    setBusy("save");
    setNotice("");
    try {
      const next = await requestStatus(token, "PUT", endpoint, { expected_revision: status.revision, configuration });
      setStatus(next);
      setDraft({ ...next.configuration });
      setNotice("配置已保存。请检测连接；Codex 开放状态以服务端信息为准。");
    } catch (error) {
      setProblem(problemFor(error));
    } finally {
      setBusy(null);
    }
  }

  async function probe() {
    if (!token || !status || !draft || busy || dirty) return;
    setBusy("probe");
    setNotice("");
    try {
      const next = await requestStatus(token, "POST", `${endpoint}/probe`, {});
      setStatus(next);
      setDraft({ ...next.configuration });
      setNotice("检测已完成，请查看连接状态。");
    } catch (error) {
      setProblem(problemFor(error));
    } finally {
      setBusy(null);
    }
  }

  return <main className="min-h-screen bg-background px-4 py-8 text-foreground">
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-title font-semibold">线上模型配置</h1><p className="mt-2 text-ui text-muted-foreground">管理线上工作台的模型连接和计费配置。</p></div>
        <Button variant="outline" asChild><a href="/admin">管理后台</a></Button>
      </header>
      {!token ? <section className="rounded-lg border border-border bg-card p-6">
        <p className="text-ui">请先登录管理后台，再打开此页面。</p>
        <Button className="mt-4" asChild><a href="/admin">前往管理员登录</a></Button>
      </section> : !status || !draft ? <section className="rounded-lg border border-border bg-card p-6">
        <p className="text-ui">{busy === "load" ? "正在加载配置…" : "配置未加载。"}</p>
        {busy !== "load" && <Button className="mt-4" variant="outline" onClick={() => setRefresh(value => value + 1)}>重新加载配置</Button>}
      </section> : <>
        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-title-sm font-semibold">模型状态</h2>
          <div className="mt-4 space-y-3 text-ui">
            <div><p className="font-medium">Codex</p>
              <p className="mt-1 text-muted-foreground">{!status.billing.ready
                ? "余额计费尚未接通，Codex 未向用户开放。"
                : status.public_enabled ? "Codex 已向用户开放。" : "Codex 暂未向用户开放。"}</p>
              {status.billing.ready && status.billing.message && <p className="mt-1 text-muted-foreground">{status.billing.message}</p>}
            </div>
            <div><p className="font-medium">Qwen3.7</p><p className="mt-1 text-muted-foreground">{status.qwen.free && status.qwen.all_accounts ? "所有账号免费，不扣余额。" : "当前配置未对所有账号免费开放。"}</p></div>
          </div>
        </section>
        <form className="space-y-6 rounded-lg border border-border bg-card p-6" onSubmit={save} noValidate>
          <div><h2 className="text-title-sm font-semibold">Codex 配置</h2><p className="mt-2 text-ui text-muted-foreground">配置先保存为草稿，连接检测通过后仍需完成余额计费。</p></div>
          <div className="space-y-4">
            <div className="space-y-2"><label className="text-ui font-medium" htmlFor="cli-path">CLI 程序路径</label>
              <Input id="cli-path" value={draft.cli_path} onChange={event => change("cli_path", event.target.value)} placeholder="例如 /usr/local/bin/codex" disabled={!!busy} aria-invalid={!!errors.cli_path} aria-describedby={errors.cli_path ? "cli-path-error" : "cli-path-help"} />
              {errors.cli_path ? <p id="cli-path-error" className="text-caption text-destructive">{errors.cli_path}</p> : <p id="cli-path-help" className="text-caption text-muted-foreground">填写 Ubuntu 上 Codex 程序的绝对路径。</p>}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2"><label className="text-ui font-medium" htmlFor="model">模型 ID</label>
                <Input id="model" list="codex-models" value={draft.model} onChange={event => change("model", event.target.value)} placeholder="填写实际可用的模型 ID" disabled={!!busy} aria-invalid={!!errors.model} aria-describedby={errors.model ? "model-error" : undefined} />
                <datalist id="codex-models">{status.connection.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
                {errors.model && <p id="model-error" className="text-caption text-destructive">{errors.model}</p>}
              </div>
              <div className="space-y-2"><label className="text-ui font-medium" htmlFor="billing-model">账务模型 ID</label>
                <Input id="billing-model" value={draft.billing_model} onChange={event => change("billing_model", event.target.value)} placeholder="与现有模型价格表一致" disabled={!!busy} aria-invalid={!!errors.billing_model} aria-describedby={errors.billing_model ? "billing-model-error billing-model-help" : "billing-model-help"} />
                {errors.billing_model && <p id="billing-model-error" className="text-caption text-destructive">{errors.billing_model}</p>}
                <p id="billing-model-help" className="text-caption text-muted-foreground">请在 <a className="underline underline-offset-4" href="/admin">管理后台</a> 的“模型服务 → 模型计价”配置对应价格。</p>
              </div>
              <div className="space-y-2"><label className="text-ui font-medium" htmlFor="label">显示名称</label>
                <Input id="label" value={draft.label} onChange={event => change("label", event.target.value)} disabled={!!busy} aria-invalid={!!errors.label} aria-describedby={errors.label ? "label-error" : undefined} />
                {errors.label && <p id="label-error" className="text-caption text-destructive">{errors.label}</p>}
              </div>
              <div className="space-y-2"><span className="text-ui font-medium">认证方式</span>
                <Select aria-label="认证方式" value={draft.auth_mode} onValueChange={value => change("auth_mode", value as Configuration["auth_mode"])} disabled={!!busy} options={[
                  { value: "chatgpt", label: "ChatGPT 账号" }, { value: "api_key", label: "API Key" },
                ]} />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!!busy}>{busy === "save" ? "保存中…" : "保存配置"}</Button>
            <Button type="button" variant="outline" onClick={probe} disabled={!!busy || dirty || !status.configuration.cli_path}>{busy === "probe" ? "检测中…" : "检测连接"}</Button>
            {dirty && <span className="text-caption text-muted-foreground">请先保存更改，再检测服务器上的配置。</span>}
          </div>
          {notice && <p role="status" className="text-ui text-muted-foreground">{notice}</p>}
          <div className="space-y-2 border-t border-border pt-4"><h3 className="text-ui font-medium">连接状态</h3><p className="text-ui text-muted-foreground">{status.connection.message || "尚未检测。"}</p></div>
          <details className="border-t border-border pt-4 text-ui"><summary className="cursor-pointer font-medium">Ubuntu 登录说明</summary>
            <p className="mt-3 text-muted-foreground">凭据保存在服务器上，请在 Ubuntu 终端完成登录，不要在此页面填写凭据。</p>
            {status.login_commands.length ? <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3">{status.login_commands.join("\n")}</pre> : <p className="mt-3 text-muted-foreground">配置程序后显示登录说明。</p>}
          </details>
        </form>
      </>}
    </div>
    <Dialog open={!!problem} onOpenChange={open => { if (!open) setProblem(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{problem?.title}</DialogTitle><DialogDescription>{problem?.description}</DialogDescription></DialogHeader>
        <DialogFooter>{problem?.login && <Button variant="outline" asChild><a href="/admin">前往管理员登录</a></Button>}{problem?.title === "配置已变化" && <Button variant="outline" onClick={() => { setProblem(null); setRefresh(value => value + 1); }}>重新加载配置</Button>}<Button onClick={() => setProblem(null)}>知道了</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </main>;
}
