import { describe, expect, it } from "vitest";

import { reconnectAvailability } from "./XtermTerminal";
import type { ConnectionConfig, Session } from "./types/terminal";

const SSH_SESSION: Pick<Session, "type" | "configId"> = {
  type: "ssh",
  configId: "cfg-1",
};
const CONNECTION: Pick<ConnectionConfig, "id"> = { id: "cfg-1" };

describe("reconnectAvailability", () => {
  it("offers reconnect for a dropped SSH session with a saved connection", () => {
    expect(reconnectAvailability(SSH_SESSION, [CONNECTION], "disconnected")).toEqual({
      canReconnect: true,
      needsReconnect: true,
    });
  });

  it("offers reconnect when the SSH session failed to connect", () => {
    // Regression: the reconnect banner was unreachable, so a failed session
    // was a dead end and the tab had to be closed and re-opened by hand.
    expect(reconnectAvailability(SSH_SESSION, [CONNECTION], "error")).toEqual({
      canReconnect: true,
      needsReconnect: true,
    });
  });

  it("stays hidden while the SSH session is healthy or connecting", () => {
    for (const status of ["connected", "connecting"]) {
      expect(reconnectAvailability(SSH_SESSION, [CONNECTION], status)).toEqual({
        canReconnect: true,
        needsReconnect: false,
      });
    }
  });

  it("never offers reconnect for a local shell", () => {
    const local: Pick<Session, "type" | "configId"> = { type: "local", configId: "" };
    expect(reconnectAvailability(local, [CONNECTION], "disconnected")).toEqual({
      canReconnect: false,
      needsReconnect: false,
    });
    expect(reconnectAvailability(local, [CONNECTION], "error")).toEqual({
      canReconnect: false,
      needsReconnect: false,
    });
  });

  it("never offers reconnect without a saved connection config", () => {
    // An ad-hoc `ssh host` typed in the shell has nothing to reconnect to.
    const adHoc: Pick<Session, "type" | "configId"> = { type: "ssh", configId: "" };
    expect(reconnectAvailability(adHoc, [CONNECTION], "error")).toEqual({
      canReconnect: false,
      needsReconnect: false,
    });
  });

  it("does not offer reconnect when the config was deleted", () => {
    expect(reconnectAvailability(SSH_SESSION, [], "error")).toEqual({
      canReconnect: false,
      needsReconnect: false,
    });
  });

  it("handles a session that is already gone from the store", () => {
    expect(reconnectAvailability(undefined, [CONNECTION], "error")).toEqual({
      canReconnect: false,
      needsReconnect: false,
    });
  });
});
