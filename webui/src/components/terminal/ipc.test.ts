import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  onTerminalOutput,
  shellSpawn,
  sshConnectWithId,
  terminalDeleteSavedConnection,
  terminalLoadConnections,
  terminalUpsertConnection,
} from "./ipc";
import type { ConnectionConfig } from "./types/terminal";

describe("local shell startup", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    mocks.invoke.mockReset().mockResolvedValue("session-1");
    mocks.listen.mockReset();
  });

  it("waits for the output listener before spawning the shell", async () => {
    let finishListening!: () => void;
    mocks.listen.mockReturnValue(
      new Promise<() => void>((resolve) => {
        finishListening = () => resolve(() => {});
      }),
    );

    const listening = onTerminalOutput(() => {});
    const spawning = shellSpawn(80, 24);

    await Promise.resolve();
    expect(mocks.invoke).not.toHaveBeenCalled();

    finishListening();
    await listening;

    await expect(spawning).resolves.toBe("session-1");
    expect(mocks.invoke).toHaveBeenCalledWith("shell_spawn", {
      cols: 80,
      rows: 24,
      cwd: null,
    });
  });

  it("passes the current workspace as the shell working directory", async () => {
    mocks.listen.mockResolvedValue(() => {});
    await onTerminalOutput(() => {});

    await expect(shellSpawn(100, 30, "D:\\workspace\\project")).resolves.toBe("session-1");

    expect(mocks.invoke).toHaveBeenCalledWith("shell_spawn", {
      cols: 100,
      rows: 30,
      cwd: "D:\\workspace\\project",
    });
  });
});

describe("saved terminal connections", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    mocks.invoke.mockReset();
  });

  it("loads masked connections with the current snapshot revision", async () => {
    const connection: ConnectionConfig = { id: "saved-one", name: "Fixture", protocol: "ssh", host: "192.0.2.20", port: 22,
      username: "test", auth: { type: "agent" } };
    mocks.invoke.mockResolvedValue({ connections: [connection], revision: "revision-1" });
    await expect(terminalLoadConnections()).resolves.toEqual([{ ...connection, storageRevision: "revision-1" }]);
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_load_connection_state");
  });

  it("upserts and deletes with captured revisions without sending frontend-only revision fields", async () => {
    const connection: ConnectionConfig = { id: "saved-one", name: "Fixture", protocol: "ssh", host: "192.0.2.20", port: 22,
      username: "test", auth: { type: "agent" }, storageRevision: "revision-1" };
    mocks.invoke.mockResolvedValue({ connections: [], revision: "revision-2" });
    await terminalUpsertConnection(connection, connection.storageRevision);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "terminal_upsert_connection", {
      connection: { id: connection.id, name: connection.name, protocol: connection.protocol, host: connection.host,
        port: connection.port, username: connection.username, auth: connection.auth }, expectedRevision: "revision-1",
    });
    await terminalDeleteSavedConnection(connection.id, "revision-2");
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "terminal_delete_saved_connection", {
      connectionId: connection.id, expectedRevision: "revision-2",
    });
  });

  it("uses a null revision when inserting a new saved connection", async () => {
    const connection: ConnectionConfig = { id: "saved-new", name: "Fixture", protocol: "ssh", host: "192.0.2.20", port: 22,
      username: "test", auth: { type: "agent" } };
    mocks.invoke.mockResolvedValue({ connections: [connection], revision: "revision-1" });
    await terminalUpsertConnection(connection);
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_upsert_connection", {
      connection, expectedRevision: null,
    });
  });

  it("does not send the frontend snapshot revision with a connection command", async () => {
    const connection: ConnectionConfig = { id: "saved-one", name: "Fixture", protocol: "ssh", host: "192.0.2.20", port: 22,
      username: "test", auth: { type: "agent" }, storageRevision: "revision-1" };
    await sshConnectWithId("session-1", connection);
    expect(mocks.invoke).toHaveBeenCalledWith("ssh_connect_with_id", {
      sessionId: "session-1", config: { id: "saved-one", name: "Fixture", protocol: "ssh", host: "192.0.2.20",
        port: 22, username: "test", auth: { type: "agent" } }, cols: 80, rows: 24,
    });
  });
});
