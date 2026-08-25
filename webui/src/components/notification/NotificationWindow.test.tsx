import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "notification", close: mocks.close }),
}));
vi.mock("@/hooks/useTheme", () => ({ useTheme: () => ({}) }));

import { NotificationWindow } from "./NotificationWindow";

describe("NotificationWindow brand surface", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
    mocks.close.mockReset();
    const payload = JSON.stringify({
      id: "n1",
      title: "Mona",
      body: "后台任务已完成",
      icon: "mona",
      actions: [],
      autoCloseMs: 0,
    });
    const bytes = new TextEncoder().encode(payload);
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    const encoded = btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    window.location.hash = `?data=${encoded}`;
  });

  it("uses semantic entry/exit motion and a single red signal", async () => {
    render(<NotificationWindow />);

    await waitFor(() => expect(screen.getByText("Mona")).toBeInTheDocument());
    const windowElement = screen.getByTestId("notification-window");

    expect(windowElement).toHaveClass("rounded-xl", "animate-in", "duration-standard");
    expect(windowElement.querySelector(".mona-agent-logo--welcome")).toBeTruthy();
    expect(screen.getByTestId("notification-signal")).toHaveClass(
      "h-0.5",
      "bg-[hsl(var(--brand-red))]",
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(windowElement).toHaveClass("animate-out", "duration-fast");
  });
});
