export interface LoginDevice {
  id: string;
  revision: number;
  name: string;
  platform: "windows" | "macos" | "linux";
  current: boolean;
  last_seen_at: string;
  bound_at: string;
}

export interface DeviceReplacement { id: string; revision: number }
export interface DeviceLoginOptions { requestId?: string; replacements?: DeviceReplacement[] }
export interface LoginDeviceList { devices: LoginDevice[]; device_limit: number; plan: "free" | "pro" }

export function parseLoginDevices(value: unknown): LoginDeviceList {
  if (!value || typeof value !== "object") throw new Error("设备列表返回异常，请重试。");
  const data = value as Partial<LoginDeviceList>;
  if (!Array.isArray(data.devices) || data.devices.length > 16
    || ![1, 3].includes(data.device_limit ?? 0) || !["free", "pro"].includes(data.plan ?? "")
    || data.device_limit !== (data.plan === "pro" ? 3 : 1)
    || data.devices.some((device) => !device || typeof device.id !== "string" || !/^[a-f0-9]{32}$/.test(device.id)
      || !Number.isSafeInteger(device.revision) || device.revision < 1
      || typeof device.name !== "string" || !device.name.trim() || device.name.length > 240
      || typeof device.current !== "boolean" || !["windows", "macos", "linux"].includes(device.platform)
      || typeof device.last_seen_at !== "string" || !Number.isFinite(Date.parse(device.last_seen_at))
      || typeof device.bound_at !== "string" || !Number.isFinite(Date.parse(device.bound_at)))
    || new Set(data.devices.map((device) => device.id)).size !== data.devices.length
    || data.devices.filter((device) => device.current).length > 1) {
    throw new Error("设备列表返回异常，请重试。");
  }
  return data as LoginDeviceList;
}

export interface DeviceRemovalResult {
  success: true;
  device_id: string;
  current_device_removed: boolean;
}

export function parseDeviceRemoval(value: unknown, deviceId: string): DeviceRemovalResult {
  if (value && typeof value === "object") {
    const result = value as Partial<DeviceRemovalResult>;
    if (result.success === true && result.device_id === deviceId
      && typeof result.current_device_removed === "boolean") return result as DeviceRemovalResult;
  }
  throw new Error("尚未确认移除结果，请刷新设备列表核对。");
}

export const devicePlatformLabel: Record<LoginDevice["platform"], string> = {
  windows: "Windows", macos: "macOS", linux: "Linux",
};

export function accountDeviceErrorMessage(error: unknown, operation: "read" | "remove" | "logout"): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/设备(?:已重新登录|状态已变化|登录状态已变化)|设备列表已变化/.test(message)) {
    return "设备登录状态已变化，请刷新列表后重新选择。";
  }
  if (/此设备的登录已结束|登录已过期|请先登录|登录凭据无效/.test(message)) {
    return "当前登录已失效，请重新登录。";
  }
  if (/尚未支持设备登录|尚未开放|先升级服务端/.test(message)) {
    return "登录设备管理暂不可用，请稍后重试。";
  }
  if (operation === "read") return "暂时无法读取登录设备，请刷新重试。";
  if (operation === "logout") return "暂时无法确认退出结果，请联网后重试。本地资料不受影响。";
  return "尚未确认移除结果，请刷新设备列表核对。本地资料不受影响。";
}

export class DeviceLimitError extends Error {
  readonly devices: LoginDevice[];
  readonly deviceLimit: number;
  readonly requiredReplacements: number;
  constructor(value: unknown) {
    const data = parseLoginDevices(value);
    const required = (value as { required_replacements?: number }).required_replacements;
    if (!Number.isSafeInteger(required) || required! < 1 || required! > data.devices.length) {
      throw new Error("设备列表返回异常，请重试。");
    }
    super("登录设备已达上限，请选择退出的设备后继续。");
    this.name = "DeviceLimitError";
    this.devices = data.devices;
    this.deviceLimit = data.device_limit;
    this.requiredReplacements = required!;
  }
}

export function requireLoginAccepted(value: unknown): void {
  if (value && typeof value === "object") {
    const result = value as { success?: boolean; error?: string };
    if (result.success === true) return;
    if (result.error === "device_limit_exceeded") throw new DeviceLimitError(value);
  }
  throw new Error("登录未完成，请重新登录。");
}
