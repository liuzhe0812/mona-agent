import { sshConnectWithId, sshDisconnect } from "./ipc";
import { useTerminalStore } from "./store/terminalStore";
import type { ConnectionConfig } from "./types/terminal";

/** Shared saved-connection entry; host-key and credential prompts remain owned by the terminal. */
export function openSavedConnection(config: ConnectionConfig): string {
  const state = useTerminalStore.getState();
  const sessionId = crypto.randomUUID();
  state.addConnection(config);
  state.addSession({ id: sessionId, configId: config.id,
    type: config.protocol === "sftp" ? "sftp" : "ssh", status: "connecting", title: config.name || config.host });
  const exists = () => useTerminalStore.getState().sessions.some((session) => session.id === sessionId);
  const connect = async (value: ConnectionConfig) => {
    if (!exists()) return false;
    await sshConnectWithId(sessionId, value);
    if (!exists()) {
      await sshDisconnect(sessionId);
      return false;
    }
    state.updateSessionStatus(sessionId, "connected");
    return true;
  };
  void connect(config).catch((error) => {
    if (!exists()) return;
    const message = String(error);
    const unknown = message.match(/Host key unknown:\s*(SHA256:\S+)/);
    const changed = message.match(/Host key changed: expected\s*(SHA256:\S+),\s*got\s*(SHA256:\S+)/);
    if (unknown || changed) {
      state.showHostKeyDialog({ host: config.host, port: config.port,
        type: changed ? "changed" : "unknown", fingerprint: changed?.[2] ?? unknown![1],
        expectedFingerprint: changed?.[1] ?? "", pendingConfig: config,
        pendingSessionId: sessionId, saveSession: true });
    } else if (/keyring|authentication failed|storage format|re-enter the password/i.test(message)) {
      state.showSshPasswordDialog({ host: config.host, port: config.port, username: config.username,
        onConfirm: async (password: string) => {
          if (!exists()) throw new Error("原连接已关闭，请重新打开连接。");
          const updated: ConnectionConfig = { ...config, auth: { type: "password", password } };
          if (await connect(updated)) await state.saveConnection(updated);
        },
        onCancel: () => { if (exists()) state.updateSessionStatus(sessionId, "error"); },
      });
    } else {
      state.updateSessionStatus(sessionId, "error");
    }
  });
  return sessionId;
}
