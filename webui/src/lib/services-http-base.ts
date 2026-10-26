import { getServicesStatus, isTauri } from "./tauri";

let _servicesHttpBase: string | null = null;

/** Return the services HTTP base URL (e.g. ``http://127.0.0.1:17174``).
 *
 * The services process serves business-domain routes (email / schedule /
 * video / materials / profile / hoard / contacts). Mirrors
 * ``getGatewayHttpBase()``: caches the base and lazily starts the services
 * process when it is not running. */
export async function getServicesHttpBase(): Promise<string> {
  if (_servicesHttpBase) return _servicesHttpBase;
  if (isTauri()) {
    let status = await getServicesStatus();
    if (!status.running || !status.port) {
      try {
        const { startServices } = await import("./tauri");
        await startServices();
        status = await getServicesStatus();
      } catch {
        return "";
      }
    }
    if (status.port) {
      _servicesHttpBase = `http://127.0.0.1:${status.port}`;
      return _servicesHttpBase;
    }
  }
  return "";
}

export function resetServicesHttpBase(): void {
  _servicesHttpBase = null;
}
