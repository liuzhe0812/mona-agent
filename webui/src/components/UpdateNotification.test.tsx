import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  checkForUpdates: vi.fn(),
  showNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  checkForUpdates: mocks.checkForUpdates,
  performUpdate: vi.fn(),
  showNotification: mocks.showNotification,
  takeUpdateError: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("1.0.0"),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, listener);
    return () => mocks.listeners.delete(name);
  }),
}));

import { UpdateNotification } from "./UpdateNotification";

describe("UpdateNotification", () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.checkForUpdates.mockReset();
    mocks.showNotification.mockClear();
  });

  it("keeps the new-version notification visible until the user chooses an action", async () => {
    render(<UpdateNotification />);

    await waitFor(() => expect(mocks.listeners.has("update-available")).toBe(true));
    act(() => {
      mocks.listeners.get("update-available")?.({
        payload: {
          has_update: true,
          current_version: "1.0.0",
          latest_version: "1.1.0",
          notes: "改进更新体验",
          size: 10_485_760,
        },
      });
    });

    await waitFor(() => expect(mocks.showNotification).toHaveBeenCalledOnce());
    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "发现新版本 v1.1.0",
        autoCloseMs: 0,
        actions: [
          { label: "立即更新", action: "update-now", primary: true },
          { label: "稍后", action: "update-dismiss" },
        ],
      }),
    );
  });

  it("clears the parent update state after a fresh check finds no update", async () => {
    const onUpdateAvailable = vi.fn();
    mocks.checkForUpdates.mockResolvedValue({
      has_update: false,
      current_version: "1.6.0",
      latest_version: "1.6.0",
      notes: null,
      size: null,
    });

    render(
      <UpdateNotification
        onUpdateAvailable={onUpdateAvailable}
        openTrigger={1}
      />,
    );

    await waitFor(() => expect(mocks.checkForUpdates).toHaveBeenCalledOnce());
    await waitFor(() => expect(onUpdateAvailable).toHaveBeenLastCalledWith(null));
  });

  it("does not repeat the notification when the same result is broadcast again", async () => {
    render(<UpdateNotification />);
    await waitFor(() => expect(mocks.listeners.has("update-available")).toBe(true));
    const payload = { has_update: true, current_version: "1.6.0", latest_version: "1.6.1", notes: null, size: 100 };
    act(() => {
      mocks.listeners.get("update-available")?.({ payload });
      mocks.listeners.get("update-available")?.({ payload });
    });
    await waitFor(() => expect(mocks.showNotification).toHaveBeenCalledOnce());
  });

  it("clears the cached update when the backend reports no update", async () => {
    const onUpdateAvailable = vi.fn();
    render(<UpdateNotification onUpdateAvailable={onUpdateAvailable} />);

    await waitFor(() => expect(mocks.listeners.has("update-available")).toBe(true));
    act(() => {
      mocks.listeners.get("update-available")?.({
        payload: {
          has_update: true,
          current_version: "1.0.0",
          latest_version: "1.1.0",
          notes: null,
          size: null,
        },
      });
    });
    await waitFor(() => expect(onUpdateAvailable).toHaveBeenLastCalledWith(expect.objectContaining({
      latest_version: "1.1.0",
    })));

    act(() => {
      mocks.listeners.get("update-available")?.({
        payload: {
          has_update: false,
          current_version: "1.0.0",
          latest_version: "1.0.0",
          notes: null,
          size: null,
        },
      });
    });

    await waitFor(() => expect(onUpdateAvailable).toHaveBeenLastCalledWith(null));
  });
});
