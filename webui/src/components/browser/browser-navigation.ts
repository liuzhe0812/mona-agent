const DEFAULT_SEARCH_ENGINE = "https://www.google.com/search?q=";

function isLikelyUrl(input: string): boolean {
  return /^https?:\/\//i.test(input)
    || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(input)
    || /^localhost(:\d+)?(\/.*)?$/i.test(input)
    || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(input);
}

export function normalizeUrlOrSearch(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (isLikelyUrl(trimmed)) {
    return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  }
  return `${DEFAULT_SEARCH_ENGINE}${encodeURIComponent(trimmed)}`;
}
