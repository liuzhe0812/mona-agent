import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), removeLoginDevice: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/hooks/useLicense", () => ({ useLicense: () => ({ removeLoginDevice: mocks.removeLoginDevice }) }));
import { AccountDevices } from "./AccountDevices";

const device = { id: "a".repeat(32), revision: 2, name: "办公室电脑", platform: "windows", current: false,
  bound_at: "2026-10-12T00:00:00Z", last_seen_at: "2026-10-12T00:00:00Z" };
const local = { ...device, id: "b".repeat(32), name: "此电脑", current: true };
const list = { devices: [device, local], device_limit: 3, plan: "pro" };
const removed = { success: true, device_id: device.id, current_device_removed: false };

beforeEach(() => { mocks.invoke.mockReset(); mocks.removeLoginDevice.mockReset(); });

describe("account devices in settings", () => {
  it("shows names, OS, recent activity and slots directly in settings", async () => {
    mocks.invoke.mockResolvedValue(list);
    render(<AccountDevices />);
    await screen.findByRole("button", { name: "移除 办公室电脑" });
    expect(screen.getByRole("region", { name: "登录设备" })).toBeInTheDocument();
    expect(screen.getByLabelText("设备名额")).toHaveTextContent("2 / 3 台");
    expect(screen.getByText("当前设备")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("此电脑");
    expect(screen.getAllByText(/Windows · 最近使用/)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "管理设备" })).not.toBeInTheDocument();
  });

  it("removes only after confirmation and refreshes actual slot count", async () => {
    mocks.invoke.mockResolvedValueOnce(list).mockResolvedValueOnce({ ...list, devices: [local] });
    mocks.removeLoginDevice.mockResolvedValue(removed);
    render(<AccountDevices />);
    fireEvent.click(await screen.findByRole("button", { name: "移除 办公室电脑" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("本地资料和任务不会删除");
    expect(mocks.removeLoginDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(mocks.removeLoginDevice).toHaveBeenCalledTimes(1));
    expect(mocks.removeLoginDevice).toHaveBeenCalledWith({ id: device.id, revision: 2 });
    await waitFor(() => expect(screen.getByLabelText("设备名额")).toHaveTextContent("1 / 3 台"));
    expect(screen.queryByRole("button", { name: "移除 办公室电脑" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除 此电脑" })).toBeInTheDocument();
  });

  it("cancel never sends a removal", async () => {
    mocks.invoke.mockResolvedValue(list);
    render(<AccountDevices />);
    fireEvent.click(await screen.findByRole("button", { name: "移除 办公室电脑" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(mocks.removeLoginDevice).not.toHaveBeenCalled();
    expect(screen.getByLabelText("设备名额")).toHaveTextContent("2 / 3 台");
  });

  it("supports the free account and warns when removing this device", async () => {
    mocks.invoke.mockResolvedValue({ devices: [local], device_limit: 1, plan: "free" });
    mocks.removeLoginDevice.mockResolvedValue({ ...removed, device_id: local.id, current_device_removed: true });
    render(<AccountDevices />);
    fireEvent.click(await screen.findByRole("button", { name: "移除 此电脑" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("移除当前设备？");
    expect(screen.getByRole("dialog")).toHaveTextContent("将退出当前设备的账号登录");
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(mocks.removeLoginDevice).toHaveBeenCalledTimes(1));
    expect(mocks.removeLoginDevice).toHaveBeenCalledWith({ id: local.id, revision: local.revision });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("stale-session failures require a refreshed list and a fresh confirmation", async () => {
    mocks.invoke.mockResolvedValue(list);
    mocks.removeLoginDevice.mockRejectedValue(new Error("设备已重新登录，请刷新后再次确认。"));
    render(<AccountDevices />);
    fireEvent.click(await screen.findByRole("button", { name: "移除 办公室电脑" }));
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("设备登录状态已变化");
    expect(screen.queryByRole("button", { name: "确认移除" })).not.toBeInTheDocument();
    mocks.invoke.mockResolvedValue({ ...list, devices: [{ ...device, revision: 3 }, local] });
    fireEvent.click(screen.getByRole("button", { name: "刷新设备列表" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "移除 办公室电脑" })).toBeEnabled());
    expect(mocks.removeLoginDevice).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("设备名额")).toHaveTextContent("2 / 3 台");
  });

  it("unknown network result does not expose internal errors or remove a row", async () => {
    mocks.invoke.mockResolvedValue(list);
    mocks.removeLoginDevice.mockRejectedValue(new Error("TypeError: internal stack at localhost:1234 SENSITIVE"));
    render(<AccountDevices />);
    fireEvent.click(await screen.findByRole("button", { name: "移除 办公室电脑" }));
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("尚未确认移除结果");
    expect(alert).not.toHaveTextContent("SENSITIVE");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByLabelText("设备名额")).toHaveTextContent("2 / 3 台");
    expect(screen.getByRole("button", { name: "移除 办公室电脑" })).toBeInTheDocument();
  });

  it("a pending removal cannot be double submitted", async () => {
    mocks.invoke.mockResolvedValue(list);
    let finish!: (value: unknown) => void;
    mocks.removeLoginDevice.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<AccountDevices />);
    fireEvent.click(await screen.findByRole("button", { name: "移除 办公室电脑" }));
    const confirm = screen.getByRole("button", { name: "确认移除" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(mocks.removeLoginDevice).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    view.unmount();
    await act(async () => finish(removed));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("a failed read is not an empty account and can be retried", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(list);
    render(<AccountDevices />);
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取登录设备");
    expect(screen.queryByText("暂无已登录设备")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新登录设备" }));
    await screen.findByRole("button", { name: "移除 办公室电脑" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("confirmed removal survives a failed subsequent list refresh", async () => {
    mocks.invoke.mockResolvedValueOnce(list).mockRejectedValueOnce(new Error("offline"));
    mocks.removeLoginDevice.mockResolvedValue(removed);
    render(<AccountDevices />);
    fireEvent.click(await screen.findByRole("button", { name: "移除 办公室电脑" }));
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "移除 办公室电脑" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("设备名额")).toHaveTextContent("1 / 3 台");
    expect(screen.getByRole("button", { name: "刷新登录设备" })).toBeEnabled();
    expect(mocks.removeLoginDevice).toHaveBeenCalledTimes(1);
  });

  it("never restores old device information after the account is replaced", async () => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((accept) => { resolve = accept; }))
      .mockResolvedValueOnce({ devices: [], device_limit: 1, plan: "free" });
    const view = render(<AccountDevices key="old" />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    view.rerender(<AccountDevices key="new" />);
    await screen.findByText("暂无已登录设备");
    await act(async () => resolve(list));
    expect(screen.queryByText("办公室电脑")).not.toBeInTheDocument();
    expect(screen.getByLabelText("设备名额")).toHaveTextContent("0 / 1 台");
  });
});
