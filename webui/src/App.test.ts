import { createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  fetchBootstrap: vi.fn(),
  getGatewayStatus: vi.fn(),
  startGateway: vi.fn(),
}));

vi.mock("@/components/terminal/TerminalView", () => ({
  TerminalView: () => null,
}));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: () => true,
  getGatewayStatus: runtimeMocks.getGatewayStatus,
  startGateway: runtimeMocks.startGateway,
}));

vi.mock("@/lib/bootstrap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bootstrap")>()),
  fetchBootstrap: runtimeMocks.fetchBootstrap,
}));

import App, { openNewBrowserTab } from "./App";

beforeEach(() => {
  runtimeMocks.fetchBootstrap.mockReset().mockImplementation(() => new Promise(() => {}));
  runtimeMocks.getGatewayStatus.mockReset().mockResolvedValue({
    running: true,
    port: 8765,
    ws_port: 8765,
  });
  runtimeMocks.startGateway.mockReset().mockResolvedValue(8765);
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("openNewBrowserTab", () => {
  it("switches to the chat surface before creating the tab", () => {
    const setView = vi.fn();
    const addEmptyTab = vi.fn();

    openNewBrowserTab(setView, addEmptyTab);

    expect(setView).toHaveBeenCalledWith("chat");
    expect(addEmptyTab).toHaveBeenCalledOnce();
    expect(setView.mock.invocationCallOrder[0]).toBeLessThan(
      addEmptyTab.mock.invocationCallOrder[0],
    );
  });
});

describe("desktop runtime startup", () => {
  it("waits for the gateway readiness command even when the process is already running", async () => {
    window.location.hash = "#/quick-ask";

    render(createElement(App));

    await waitFor(() => expect(runtimeMocks.startGateway).toHaveBeenCalledOnce());
    expect(runtimeMocks.fetchBootstrap).toHaveBeenCalledOnce();
  });
});
