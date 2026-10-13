import { describe, expect, it } from "vitest";
import { accountDeviceErrorMessage, parseDeviceRemoval, parseLoginDevices } from "./account-devices";

const device = { id: "a".repeat(32), revision: 1, name: "桌面电脑", platform: "windows", current: true,
  last_seen_at: "2026-10-12T10:00:00Z", bound_at: "2026-10-11T10:00:00Z" };
const list = { devices: [device], device_limit: 1, plan: "free" };

describe("device account contracts", () => {
  it("accepts current server device list without inventing online status", () => {
    expect(parseLoginDevices(list)).toEqual(list);
  });
  it.each([
    null, {}, { ...list, device_limit: 3 }, { ...list, devices: [device, device] },
    { ...list, devices: [device, { ...device, id: "b".repeat(32) }] },
    { ...list, devices: [{ ...device, last_seen_at: "not-a-date" }] },
    { ...list, devices: [{ ...device, name: "" }] },
  ])("rejects malformed or ambiguous device lists: %j", (value) => {
    expect(() => parseLoginDevices(value)).toThrow();
  });
  it.each([
    undefined, null, {}, { success: false }, { success: true },
    { success: true, device_id: "b".repeat(32), current_device_removed: true },
    { success: true, device_id: device.id, current_device_removed: "true" },
  ])("never considers a false/foreign response a successful removal: %j", (value) => {
    expect(() => parseDeviceRemoval(value, device.id)).toThrow("尚未确认移除结果");
  });
  it("accepts a confirmed exact-device removal", () => {
    const result = { success: true, device_id: device.id, current_device_removed: false };
    expect(parseDeviceRemoval(result, device.id)).toEqual(result);
  });
  it("sanitizes unexpected failures", () => {
    expect(accountDeviceErrorMessage(new Error("stack token=SYNTHETIC"), "remove")).not.toContain("SYNTHETIC");
    expect(accountDeviceErrorMessage(new Error("设备已重新登录，请刷新后再次确认。"), "remove")).toContain("刷新列表");
  });
});
