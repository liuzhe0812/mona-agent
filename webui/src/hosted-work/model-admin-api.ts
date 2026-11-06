export type BillingMode = "free" | "wallet";

export type ModelPrice = {
  input_amount_per_million: string;
  cached_input_amount_per_million: string;
  output_amount_per_million: string;
};

export function isValidPriceAmount(value: string): boolean {
  const match = /^(0|[1-9]\d{0,9})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return false;
  return match[1].length < 10 || (match[1] === "1000000000" && (!match[2] || /^0+$/.test(match[2])));
}

function isModelPrice(value: unknown): value is ModelPrice | null | undefined {
  if (value == null) return true;
  if (typeof value !== "object") return false;
  const price = value as ModelPrice;
  return [price.input_amount_per_million, price.cached_input_amount_per_million, price.output_amount_per_million]
    .every(amount => typeof amount === "string" && isValidPriceAmount(amount));
}

export type ApiModelConfiguration = {
  label: string;
  source: "mona";
  api_base: string;
  api_key_env: string;
  model: string;
  context_window_tokens: number | null;
  max_output_tokens: number;
  reasoning_effort: string | null;
  billing_mode: BillingMode;
  billing_model: string;
  price: ModelPrice | null;
};

export type ManagedModel = {
  id: string;
  configuration: ApiModelConfiguration & { source: string };
  credentials: { configured: boolean };
  availability: { ready: boolean; message: string };
};

export type ModelSettings = {
  revision: string;
  models: ManagedModel[];
  synchronized?: boolean;
  billing: { mode: "shared_wallet"; ready: boolean };
};

export type CodexConfiguration = {
  cli_path: string;
  model: string;
  billing_model: string;
  billing_mode: BillingMode;
  label: string;
  auth_mode: "chatgpt" | "api_key";
  context_window_tokens: number | null;
  max_output_tokens: number;
  reasoning_effort: string | null;
  price: ModelPrice | null;
};

export type CodexStatus = {
  revision: string;
  configuration: CodexConfiguration;
  connection: { state: string; message: string; models: Array<{ id: string; label: string }> };
  billing: { mode: BillingMode; ready: boolean; message: string };
  execution: { ready: boolean; message: string };
  discovery: { state: "found" | "not_found"; path: string | null };
  public_enabled: boolean;
  login_commands: string[];
};

export class AdminRequestError extends Error {
  constructor(readonly status: number, readonly code = "request_failed", readonly field?: string) {
    super("Configuration request failed");
  }
}

export async function requestAdminJson(token: string, method: "GET" | "PUT" | "POST", url: string,
  body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { method,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    credentials: "omit", cache: "no-store", redirect: "error", signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof payload?.code === "string" ? payload.code
      : typeof payload?.error === "string" ? payload.error : payload?.error?.code;
    throw new AdminRequestError(response.status, typeof code === "string" ? code : "request_failed",
      typeof payload?.field === "string" ? payload.field : undefined);
  }
  if (!payload || typeof payload !== "object") throw new AdminRequestError(0, "invalid_response");
  return payload;
}

export function parseModelSettings(value: unknown): ModelSettings {
  const settings = value as ModelSettings | null;
  if (!settings || typeof settings.revision !== "string" || !settings.revision || !Array.isArray(settings.models)
    || !settings.models.every(item => {
      const c = item?.configuration;
      return typeof item?.id === "string" && c && typeof c.label === "string" && typeof c.source === "string"
        && typeof c.api_base === "string" && typeof c.api_key_env === "string" && typeof c.model === "string"
        && (c.context_window_tokens == null || Number.isInteger(c.context_window_tokens))
        && Number.isInteger(c.max_output_tokens) && (c.reasoning_effort == null || typeof c.reasoning_effort === "string")
        && (c.billing_mode === "free" || c.billing_mode === "wallet") && typeof c.billing_model === "string"
        && isModelPrice(c.price)
        && typeof item.credentials?.configured === "boolean" && typeof item.availability?.ready === "boolean"
        && typeof item.availability?.message === "string";
    }) || (settings.synchronized !== undefined && typeof settings.synchronized !== "boolean")
    || settings.billing?.mode !== "shared_wallet" || typeof settings.billing.ready !== "boolean") {
    throw new AdminRequestError(0, "invalid_response");
  }
  return { ...settings, models: settings.models.map(item => ({ ...item,
    configuration: { ...item.configuration, price: item.configuration.price ?? null } })) };
}

function parseCodexStatus(value: unknown): CodexStatus {
  const status = value as CodexStatus | null;
  const c = status?.configuration;
  const connection = status?.connection;
  const billing = status?.billing;
  const execution = status?.execution;
  const discovery: CodexStatus["discovery"] = status?.discovery ?? { state: "not_found", path: null };
  if (!status || typeof status.revision !== "string" || !status.revision || !c ||
    typeof c.cli_path !== "string" || typeof c.model !== "string" || typeof c.label !== "string" ||
    typeof c.billing_model !== "string" || (c.billing_mode !== "free" && c.billing_mode !== "wallet") ||
    (c.auth_mode !== "chatgpt" && c.auth_mode !== "api_key") ||
    (c.context_window_tokens != null && !Number.isInteger(c.context_window_tokens)) ||
    !Number.isInteger(c.max_output_tokens) || (c.reasoning_effort != null && typeof c.reasoning_effort !== "string") ||
    !isModelPrice(c.price) ||
    !connection || typeof connection.state !== "string" || typeof connection.message !== "string" ||
    !Array.isArray(connection.models) || !connection.models.every(model => model && typeof model.id === "string" && typeof model.label === "string") ||
    !billing || (billing.mode !== "free" && billing.mode !== "wallet") || typeof billing.ready !== "boolean" || typeof billing.message !== "string" ||
    !execution || typeof execution.ready !== "boolean" || typeof execution.message !== "string" ||
    !((discovery.state === "not_found" && discovery.path === null) || (discovery.state === "found" &&
      typeof discovery.path === "string" && discovery.path.startsWith("/") && discovery.path.length <= 2048 &&
      !/[\x00-\x1f\x7f\\]/.test(discovery.path) && !discovery.path.split("/").some(part => part === "." || part === ".."))) ||
    typeof status.public_enabled !== "boolean" || !Array.isArray(status.login_commands) ||
    !status.login_commands.every(command => typeof command === "string")) throw new AdminRequestError(0, "invalid_response");
  return { ...status, configuration: { ...c, price: c.price ?? null }, discovery };
}

export async function requestCodexStatus(token: string, method: "GET" | "PUT" | "POST", body?: unknown,
  signal?: AbortSignal): Promise<CodexStatus> {
  const url = method === "POST" ? "/api/work/admin/codex/probe" : "/api/work/admin/codex";
  return parseCodexStatus(await requestAdminJson(token, method, url, body, signal));
}

export async function requestModelSettings(token: string, body?: {
  expected_revision: string; model_id: string;
  configuration: Omit<ApiModelConfiguration, "billing_model" | "price"> & { price?: ModelPrice | null };
}, signal?: AbortSignal): Promise<ModelSettings> {
  return parseModelSettings(await requestAdminJson(token, body ? "PUT" : "GET", "/api/work/admin/models", body, signal));
}
