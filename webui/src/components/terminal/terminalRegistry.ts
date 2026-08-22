import type { Terminal } from "@xterm/xterm";

export class TerminalRegistry {
  private terminals: Map<string, Terminal> = new Map();
  private buffers: Map<string, string> = new Map();

  register(sessionId: string, terminal: Terminal): void {
    this.terminals.set(sessionId, terminal);
    const buf = this.buffers.get(sessionId) ?? "";
    if (buf) terminal.write(buf);
  }

  unregister(sessionId: string): void {
    this.terminals.delete(sessionId);
  }

  get(sessionId: string): Terminal | undefined {
    return this.terminals.get(sessionId);
  }

  write(sessionId: string, data: string): void {
    const buf = this.buffers.get(sessionId) ?? "";
    const newBuf = buf + data;
    this.buffers.set(sessionId, newBuf);
    this.terminals.get(sessionId)?.write(data);
  }

  getBuffer(sessionId: string): string {
    return this.buffers.get(sessionId) ?? "";
  }

  clearBuffer(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}
