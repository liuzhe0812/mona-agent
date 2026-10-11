import { onTerminalSessionStatus, shellKill, shellSpawn, terminalListSessions } from "@/components/terminal/ipc";
import { useTerminalStore } from "@/components/terminal/store/terminalStore";
import { useDevelopmentStore } from "./store";

const starts = new Map<string, Promise<void>>();
const stops = new Map<string, Promise<void>>();
const checks = new Map<string, Promise<void>>();
let listening: Promise<void> | undefined;
let unlisten: (() => void) | undefined;
let disposed = false;

function listenForExit() {
  listening ??= onTerminalSessionStatus((event) => {
    if (event.status !== "disconnected" && event.status !== "error") return;
    const state = useDevelopmentStore.getState();
    for (const [session, terminal] of Object.entries(state.terminals)) {
      if (terminal.id === event.sessionId && terminal.status !== "closing") {
        state.setTerminal(session, { ...terminal, status: event.status === "error" ? "error" : "exited",
          error: event.status === "error" ? "终端连接发生错误，请核对状态或结束此终端。" : undefined });
      }
    }
  }).then((stop) => { if (disposed) stop(); else unlisten = stop; })
    .catch((error) => { listening = undefined; throw error; });
  return listening;
}

export function checkDevelopmentTerminal(session: string): Promise<void> {
  const pending = checks.get(session);
  if (pending) return pending;
  const terminal = useDevelopmentStore.getState().terminals[session];
  if (!terminal?.id || terminal.status === "opening" || terminal.status === "closing") return Promise.resolve();
  const id = terminal.id;
  const task = listenForExit().then(() => terminalListSessions()).then((rows) => {
    const current = useDevelopmentStore.getState().terminals[session];
    if (current !== terminal || current.status === "closing") return;
    const native = rows.find((row) => row.id === id && row.session_type === "local");
    const status = !native || native.status === "disconnected" ? "exited" : native.status === "connected" ? "ready" : "error";
    useDevelopmentStore.getState().setTerminal(session, { id, status,
      error: status === "error" ? "终端状态异常，请结束此终端后再打开。" : undefined });
  }).catch((error) => {
    const current = useDevelopmentStore.getState().terminals[session];
    if (current === terminal && current.status !== "closing") useDevelopmentStore.getState().setTerminal(session,
      { ...current, status: "error", error: `终端状态尚未确认：${error instanceof Error ? error.message : String(error)}` });
  }).finally(() => checks.delete(session));
  checks.set(session, task);
  return task;
}

export function startDevelopmentTerminal(session: string, directory: string): Promise<void> {
  const pending = starts.get(session) ?? stops.get(session);
  if (pending) return pending;
  const state = useDevelopmentStore.getState();
  // A known process is never replaced just because its view was closed or an IPC failed.
  if (state.terminals[session]?.id) return checkDevelopmentTerminal(session);
  state.setTerminal(session, { status: "opening" });
  const task = listenForExit().then(() => shellSpawn(80, 24, directory)).then(async (id) => {
    const current = useDevelopmentStore.getState().terminals[session];
    state.setTerminal(session, { id, status: current?.status === "closing" ? "closing" : "ready" });
    if (current?.status !== "closing") await checkDevelopmentTerminal(session);
  }).catch((error) => {
    const current = useDevelopmentStore.getState().terminals[session];
    if (!current?.id) state.setTerminal(session, { status: "error", error: error instanceof Error ? error.message : "本地终端启动失败" });
  }).finally(() => starts.delete(session));
  starts.set(session, task);
  return task;
}

export function stopDevelopmentTerminal(session: string): Promise<void> {
  const pending = stops.get(session);
  if (pending) return pending;
  const state = useDevelopmentStore.getState();
  const current = state.terminals[session];
  if (!current) return Promise.resolve();
  state.setTerminal(session, { ...current, status: "closing", error: undefined });
  const task = (async () => {
    await starts.get(session);
    const terminal = useDevelopmentStore.getState().terminals[session];
    const id = terminal?.id;
    try {
      if (id) await shellKill(id);
      if (useDevelopmentStore.getState().terminals[session]?.id === id) {
        state.setTerminal(session, null);
        if (id) useTerminalStore.getState().terminalRegistry.clearBuffer(id);
      }
    } catch (error) {
      if (useDevelopmentStore.getState().terminals[session]?.id === id) state.setTerminal(session,
        { id, status: "error", error: `未确认终端已结束：${error instanceof Error ? error.message : String(error)}` });
    }
  })().finally(() => stops.delete(session));
  stops.set(session, task);
  return task;
}

if (import.meta.hot) import.meta.hot.dispose(() => { disposed = true; unlisten?.(); });
