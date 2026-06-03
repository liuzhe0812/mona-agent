/**
 * Shared HTTP helpers routed through Tauri's Rust-backed plugin so
 * third-party endpoints that don't set browser-friendly CORS headers
 * still work.
 */
let pluginFetchPromise: Promise<typeof globalThis.fetch> | null = null

const isNodeEnv = typeof window === "undefined"

export function getHttpFetch(): Promise<typeof globalThis.fetch> {
  if (!pluginFetchPromise) {
    if (isNodeEnv) {
      pluginFetchPromise = Promise.resolve(globalThis.fetch.bind(globalThis))
    } else {
      pluginFetchPromise = import("@tauri-apps/plugin-http")
        .then((m) => m.fetch as unknown as typeof globalThis.fetch)
        .catch(() => globalThis.fetch.bind(globalThis))
    }
  }
  return pluginFetchPromise
}

export function isFetchNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === "AbortError") return false
  if (err.name === "TypeError") return true
  if (err.message === "Load failed") return true
  if (err.message === "Failed to fetch") return true
  if (err.message.includes("network error")) return true
  return false
}
