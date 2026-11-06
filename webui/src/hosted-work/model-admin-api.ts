export type ApiModelConfiguration = {
  label: string;
  source: "mona";
  api_base: string;
  api_key_env: string;
  model: string;
  context_window_tokens: number | null;
  max_output_tokens: number;
  reasoning_effort: string | null;
};

export type ManagedModel = {
  id: string;
  configuration: ApiModelConfiguration & { source: string };
  credentials: { configured: boolean };
};

export type ModelSettings = {
  revision: string;
  models: ManagedModel[];
  synchronized?: boolean;
  billing: { mode: "shared_wallet"; ready: boolean; prices_endpoint: string; admin_url: string };
};

export type ModelPrice = {
  model: string;
  version: number;
  enabled: boolean;
  billing_type: "token";
  input_amount_per_million: string;
  cached_input_amount_per_million: string;
  output_amount_per_million: string;
};

export class AdminRequestError extends Error {
  constructor(readonly status: number, readonly code = "request_failed", readonly field?: string) {
    super("Configuration request failed");
  }
}

export function readAdminToken(): string | null {
  try {
    const token = sessionStorage.getItem("admin_token");
    return token && token.length <= 8192 && /^[\x21-\x7e]+$/.test(token) ? token : null;
  } catch { return null; }
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
        && typeof item.credentials?.configured === "boolean";
    }) || (settings.synchronized !== undefined && typeof settings.synchronized !== "boolean")
    || settings.billing?.mode !== "shared_wallet" || typeof settings.billing.ready !== "boolean"
    || settings.billing.prices_endpoint !== "/admin/credits/model-prices" || settings.billing.admin_url !== "/admin") {
    throw new AdminRequestError(0, "invalid_response");
  }
  return settings;
}

export async function requestModelSettings(token: string, body?: {
  expected_revision: string; model_id: string; configuration: ApiModelConfiguration;
}, signal?: AbortSignal): Promise<ModelSettings> {
  return parseModelSettings(await requestAdminJson(token, body ? "PUT" : "GET", "/api/work/admin/models", body, signal));
}

export async function requestModelPrices(token: string, signal?: AbortSignal): Promise<ModelPrice[]> {
  const value = await requestAdminJson(token, "GET", "/admin/credits/model-prices", undefined, signal) as { prices?: unknown };
  if (!Array.isArray(value.prices)) throw new AdminRequestError(0, "invalid_response");
  const prices = value.prices.filter(item => item?.billing_type === "token");
  if (!prices.every(item => typeof item.model === "string" && Number.isInteger(item.version) && item.version >= 0
    && typeof item.enabled === "boolean" && [item.input_amount_per_million, item.cached_input_amount_per_million,
      item.output_amount_per_million].every(amount => typeof amount === "string" && /^\d+(?:\.\d+)?$/.test(amount)))) {
    throw new AdminRequestError(0, "invalid_response");
  }
  return prices;
}

export function latestModelPrice(prices: ModelPrice[], model: string): ModelPrice | undefined {
  return prices.filter(price => price.model === model.trim() && price.enabled && price.billing_type === "token")
    .sort((left, right) => right.version - left.version)[0];
}
