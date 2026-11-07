import { AdminRequestError, isValidPriceAmount, requestAdminJson } from "./model-admin-api";

export type ImageConfiguration = { enabled: boolean; price: { amount_per_image: string } | null };
export type ImageSettings = {
  revision: string;
  configuration: ImageConfiguration;
  synchronized: boolean;
  availability: { ready: boolean; message: string };
};

function parseImageSettings(value: unknown): ImageSettings {
  const settings = value as ImageSettings | null;
  const config = settings?.configuration;
  const price = config?.price;
  if (!settings || typeof settings.revision !== "string" || !settings.revision || !config
    || typeof config.enabled !== "boolean" || price !== null && (!price || typeof price !== "object"
      || typeof price.amount_per_image !== "string" || !isValidPriceAmount(price.amount_per_image))
    || typeof settings.synchronized !== "boolean" || typeof settings.availability?.ready !== "boolean"
    || typeof settings.availability.message !== "string") throw new AdminRequestError(0, "invalid_response");
  return { revision: settings.revision, synchronized: settings.synchronized,
    availability: { ready: settings.availability.ready, message: settings.availability.message },
    configuration: { enabled: config.enabled, price: price === null ? null : { amount_per_image: price.amount_per_image } } };
}

export async function requestImageSettings(token: string, body?: {
  expected_revision: string; configuration: ImageConfiguration;
}, signal?: AbortSignal): Promise<ImageSettings> {
  return parseImageSettings(await requestAdminJson(token, body ? "PUT" : "GET", "/api/work/admin/image", body, signal));
}
