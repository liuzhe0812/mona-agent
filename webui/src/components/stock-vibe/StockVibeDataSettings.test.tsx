import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), request: vi.fn() }));
vi.mock("@/lib/stock-vibe-data-settings-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-data-settings-api")>(), getStockVibeDataSettings: api.get, updateStockVibeDataSettings: api.update }));
vi.mock("@/lib/stock-vibe-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-api")>(), getStockVibeRequest: api.request }));
import { StockVibeDataSettings } from "./StockVibeDataSettings";
const STORAGE = "mona.stock-vibe.data-settings.pending.v1";
function receipt(id: string, source = "settings", configured = true) { return { request_id: id, method: "PUT", path: "/host/data-settings", receipt_owner: "mona_settings", source: null, status: "completed", receipt_sha256: "b".repeat(64), receipt: { status_code: 200, body: { tushare_configured: configured, source } } }; }
beforeEach(() => { localStorage.clear(); Object.values(api).forEach((mock) => mock.mockReset()); api.get.mockResolvedValue({ tushare_configured: true, source: "settings" }); api.update.mockImplementation(async (id: string) => receipt(id)); api.request.mockResolvedValue({ status: "unknown" }); });
describe("productized stock data credentials", () => {
  it("shows redacted status, leaves the password empty and never claims that permissions were verified", async () => {
    render(<StockVibeDataSettings onError={vi.fn()} />); await screen.findByText("已配置");
    const input = screen.getByLabelText("新的 Tushare 凭据"); expect(input).toHaveAttribute("type", "password"); expect(input).toHaveValue(""); expect(screen.getByText("Mona 本地设置")).toBeInTheDocument(); expect(screen.getByText(/配置状态不代表数据权限已验证/)).toBeInTheDocument(); expect(api.update).not.toHaveBeenCalled();
  });
  it("saves a transient credential once, clears the draft on confirmed success and persists no secret", async () => {
    let finishRead!: (value: { tushare_configured: boolean; source: string }) => void;
    api.get.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    const generated = crypto.randomUUID(), onSaved = vi.fn(); render(<StockVibeDataSettings onError={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("新的 Tushare 凭据"), { target: { value: generated } }); fireEvent.click(screen.getByRole("button", { name: "保存凭据" }));
    await screen.findByText("行情数据设置已更新。"); expect(api.update).toHaveBeenCalledOnce(); expect(api.update.mock.calls[0][1]).toBe(generated); expect(screen.getByLabelText("新的 Tushare 凭据")).toHaveValue(""); expect(onSaved).toHaveBeenCalledOnce(); expect(localStorage.length).toBe(0);
    await act(async () => { finishRead({ tushare_configured: false, source: "unconfigured" }); }); expect(screen.getByText("已配置")).toBeInTheDocument();
  });
  it("clears only local settings and preserves the environment source without pretending the active credential was removed", async () => {
    api.get.mockResolvedValue({ tushare_configured: true, source: "environment" }); api.update.mockImplementation(async (id: string) => receipt(id, "environment", true));
    render(<StockVibeDataSettings onError={vi.fn()} />); await screen.findByText("环境变量"); fireEvent.click(screen.getByRole("button", { name: "清除本地设置" }));
    await screen.findByText("行情数据设置已更新。"); expect(api.update.mock.calls[0][1]).toBe(""); expect(screen.getByText("已配置")).toBeInTheDocument(); expect(screen.getByText(/保存或清除只修改 Mona 本地设置，不会改变环境来源/)).toBeInTheDocument();
  });
  it("recovers an unknown save by stable request ID after remount without resending or retaining the credential", async () => {
    api.update.mockRejectedValue(new Error("lost response")); const generated = crypto.randomUUID(), first = render(<StockVibeDataSettings onError={vi.fn()} />); await screen.findByText("已配置");
    fireEvent.change(screen.getByLabelText("新的 Tushare 凭据"), { target: { value: generated } }); fireEvent.click(screen.getByRole("button", { name: "保存凭据" })); await waitFor(() => expect(api.update).toHaveBeenCalledOnce());
    const id = localStorage.getItem(STORAGE)!; expect(id).toBe(api.update.mock.calls[0][0]); expect(localStorage.length).toBe(1); expect(localStorage.key(0)).toBe(STORAGE); expect(id).not.toContain(generated); first.unmount();
    api.request.mockImplementation(async () => receipt(id)); render(<StockVibeDataSettings onError={vi.fn()} />); await screen.findByText("行情数据设置已更新。"); expect(api.request).toHaveBeenCalledWith(id); expect(api.update).toHaveBeenCalledOnce(); expect(screen.getByLabelText("新的 Tushare 凭据")).toHaveValue(""); expect(localStorage.getItem(STORAGE)).toBeNull();
  });
});
