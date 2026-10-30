import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusBar } from "./StatusBar";
import { useBatchStore, type BatchSession } from "./store/batchStore";
import { useTerminalStore } from "./store/terminalStore";

function batchSessions(...statuses: BatchSession["status"][]): BatchSession[] {
  return statuses.map((status, index) => ({
    id: `host-${index}`,
    host: `192.0.2.${index + 1}`,
    port: 22,
    username: "user",
    status,
    selected: true,
  }));
}

describe("StatusBar batch status", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      sessions: [{ id: "batch", configId: "", type: "batch", status: "connected", title: "批量管理" }],
    });
    useBatchStore.setState({ sessions: [], isConnecting: false });
  });

  afterEach(cleanup);

  it("shows an unconnected state for an empty batch", () => {
    render(<StatusBar sessionId="batch" />);

    expect(screen.getByText("未连接")).toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  });

  it("tracks progress and the number of actually connected hosts", () => {
    useBatchStore.setState({ sessions: batchSessions("connected", "connecting"), isConnecting: true });
    render(<StatusBar sessionId="batch" />);

    expect(screen.getByText("正在连接 1/2")).toBeInTheDocument();
    act(() => useBatchStore.setState({ sessions: batchSessions("connected", "error"), isConnecting: false }));
    expect(screen.getByText("已连接 1/2")).toBeInTheDocument();
    act(() => useBatchStore.setState({ sessions: batchSessions("error", "disconnected") }));
    expect(screen.getByText("未连接")).toBeInTheDocument();
  });

  it("keeps an ordinary SSH session's own status", () => {
    useTerminalStore.setState({
      sessions: [{ id: "ssh", configId: "", type: "ssh", status: "connected", title: "SSH" }],
    });
    useBatchStore.setState({ sessions: batchSessions("error") });
    render(<StatusBar sessionId="ssh" />);

    expect(screen.getByText("已连接")).toBeInTheDocument();
  });
});
