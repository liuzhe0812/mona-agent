import type { Terminal } from "@xterm/xterm";

export class TerminalRegistry {
  private terminals: Map<string, Terminal> = new Map();
  private buffers: Map<string, string> = new Map();
  private writtenLen: Map<string, number> = new Map();

  register(sessionId: string, terminal: Terminal): void {
    this.terminals.set(sessionId, terminal);
    const buf = this.buffers.get(sessionId) ?? "";
    const alreadyWritten = this.writtenLen.get(sessionId) ?? 0;
    if (buf.length > alreadyWritten) {
      terminal.write(buf.slice(alreadyWritten));
      this.writtenLen.set(sessionId, buf.length);
    }
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
    const terminal = this.terminals.get(sessionId);
    if (terminal) {
      const alreadyWritten = this.writtenLen.get(sessionId) ?? 0;
      if (newBuf.length > alreadyWritten) {
        terminal.write(newBuf.slice(alreadyWritten));
        this.writtenLen.set(sessionId, newBuf.length);
      }
    }
  }

  getBuffer(sessionId: string): string {
    return this.buffers.get(sessionId) ?? "";
  }

  clearBuffer(sessionId: string): void {
    this.buffers.delete(sessionId);
    this.writtenLen.delete(sessionId);
  }
}
