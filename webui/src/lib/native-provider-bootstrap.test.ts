import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  providerExecutors: vi.fn(),
  probe: vi.fn(),
  login: vi.fn(),
}));

vi.mock("@/lib/development-api", () => ({
  developmentApi: api,
}));

import { warmNativeProviderConnections } from "./native-provider-bootstrap";

describe("warmNativeProviderConnections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.probe.mockResolvedValue({ state: "ready" });
  });

  it("probes available native accounts without starting login", async () => {
    api.providerExecutors.mockResolvedValue({
      executors: [
        { id: "codex", available: true },
        { id: "codebuddy", available: true },
        { id: "claude", available: true },
        { id: "mona", available: true },
      ],
    });

    await warmNativeProviderConnections();

    expect(api.probe).toHaveBeenCalledTimes(3);
    expect(api.probe).toHaveBeenCalledWith(undefined, "codex");
    expect(api.probe).toHaveBeenCalledWith(undefined, "codebuddy");
    expect(api.probe).toHaveBeenCalledWith(undefined, "claude");
    expect(api.login).not.toHaveBeenCalled();
  });

  it("shares one in-flight startup even when multiple views become ready together", async () => {
    let finish!: (value: { executors: { id: string; available: boolean }[] }) => void;
    api.providerExecutors.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = warmNativeProviderConnections();
    const second = warmNativeProviderConnections();
    expect(first).toBe(second);
    expect(api.providerExecutors).toHaveBeenCalledTimes(1);
    finish({ executors: [{ id: "codex", available: true }] });
    await Promise.all([first, second]);
    expect(api.probe).toHaveBeenCalledTimes(1);
    api.providerExecutors.mockResolvedValueOnce({ executors: [] });
    await warmNativeProviderConnections();
    expect(api.providerExecutors).toHaveBeenCalledTimes(2);
  });

  it("does not probe unavailable native executors", async () => {
    api.providerExecutors.mockResolvedValue({
      executors: [
        { id: "codex", available: false },
        { id: "codebuddy", available: false },
      ],
    });

    await warmNativeProviderConnections();

    expect(api.probe).not.toHaveBeenCalled();
    expect(api.login).not.toHaveBeenCalled();
  });
});
