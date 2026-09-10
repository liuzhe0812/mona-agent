import { act, cleanup, render, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBlankFlowchartDocument,
  computeFlowchartSemanticHash,
  serializeFlowchartMarkdown,
} from "./flowchart-document";
import type { OperationNote } from "../notes-data";

type CanvasAgentRequest = {
  requestId: string;
  canvasId?: string;
  action: "open" | "inspect" | "apply" | "export";
  patch?: unknown;
};

type CanvasAgentEventListener = (event: { payload: CanvasAgentRequest }) => void | Promise<void>;

const state = vi.hoisted(() => ({
  listener: undefined as CanvasAgentEventListener | undefined,
  listeners: new Set<CanvasAgentEventListener>(),
  listen: vi.fn(),
  invoke: vi.fn(),
  canvasHandle: {
    inspectQuality: vi.fn(),
    exportToPng: vi.fn(),
    exportToSvg: vi.fn(),
    fitView: vi.fn(),
    selectAll: vi.fn(),
    setZoom: vi.fn(),
    getZoom: vi.fn(),
    getViewportCenter: vi.fn(),
  },
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  getNotesVaultPath: vi.fn(async () => "C:/workspace"),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: state.listen }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: state.invoke }));

vi.mock("./FlowchartCanvas", () => ({
  FlowchartCanvas: forwardRef<Record<string, unknown>, Record<string, unknown>>((_props, ref) => {
    useImperativeHandle(ref, () => state.canvasHandle);
    return <div data-testid="flowchart-canvas" />;
  }),
  FlowchartFooter: () => null,
  flowchartCanvasHelpers: {
    toFlowNodes: (nodes: Array<{ id: string; position: { x: number; y: number } }>) =>
      nodes.map((node) => ({ id: node.id, type: "default", position: node.position, data: {} })),
    toFlowEdge: (edge: { id: string; source: string; target: string }) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    }),
    applyNodeChanges: (_changes: unknown[], nodes: unknown[]) => nodes,
    applyEdgeChanges: (_changes: unknown[], edges: unknown[]) => edges,
    addEdge: (_connection: unknown, edges: unknown[]) => edges,
  },
}));

vi.mock("./FlowchartShapePanel", () => ({ FlowchartShapePanel: () => null }));
vi.mock("./FlowchartSafeDeleteDialog", () => ({ FlowchartSafeDeleteDialog: () => null }));
vi.mock("./FlowchartInspector", () => ({ FlowchartInspector: () => null }));

import { FlowchartDocumentEditor } from "./FlowchartDocumentEditor";

function flowchartNote(): OperationNote {
  return {
    id: "canvas-agent-test",
    notebookId: "notebook-1",
    title: "Agent Canvas Test",
    preview: "",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    source: { kind: "agent", label: "Agent" },
    contentMarkdown: serializeFlowchartMarkdown("Agent Canvas Test", createBlankFlowchartDocument()),
    type: "flowchart",
  };
}

function renderEditor(onContentChange = vi.fn()) {
  render(
    <FlowchartDocumentEditor
      note={flowchartNote()}
      onContentChange={onContentChange}
    />,
  );
  return onContentChange;
}

async function dispatchCanvasAgentRequest(payload: CanvasAgentRequest): Promise<void> {
  await waitFor(() => expect(state.listener).toBeDefined());
  await act(async () => {
    await state.listener!({ payload });
  });
}

describe("FlowchartDocumentEditor canvas-agent bridge", () => {
  beforeEach(() => {
    state.listener = undefined;
    state.listeners.clear();
    state.listen.mockReset();
    state.listen.mockImplementation(async (_event: string, listener: CanvasAgentEventListener) => {
      state.listeners.add(listener);
      state.listener = listener;
      return () => {
        state.listeners.delete(listener);
        state.listener = [...state.listeners].at(-1);
      };
    });
    state.invoke.mockReset();
    state.invoke.mockResolvedValue(undefined);
    state.canvasHandle.inspectQuality.mockReset();
    state.canvasHandle.inspectQuality.mockResolvedValue([
      { code: "overview-too-small", severity: "warning", message: "overview" },
    ]);
    state.canvasHandle.exportToPng.mockReset();
    state.canvasHandle.exportToPng.mockResolvedValue("data:image/png;base64,test");
    state.canvasHandle.exportToSvg.mockReset();
    state.canvasHandle.exportToSvg.mockResolvedValue("<svg />");
    state.canvasHandle.fitView.mockReset();
    state.canvasHandle.selectAll.mockReset();
    state.canvasHandle.setZoom.mockReset();
    state.canvasHandle.getZoom.mockReset();
    state.canvasHandle.getZoom.mockReturnValue(1);
    state.canvasHandle.getViewportCenter.mockReset();
    state.canvasHandle.getViewportCenter.mockReturnValue({ x: 0, y: 0 });
  });

  afterEach(() => {
    cleanup();
  });

  it("responds to inspect with the current canvas id, document hash, and rendered quality", async () => {
    renderEditor();

    await dispatchCanvasAgentRequest({
      requestId: "inspect-1",
      canvasId: "canvas-agent-test",
      action: "inspect",
    });

    expect(state.invoke.mock.calls.filter(([name]) => name === "canvas_agent_respond")).toHaveLength(1);
    expect(state.invoke).toHaveBeenCalledWith(
      "canvas_agent_respond",
      expect.objectContaining({
        requestId: "inspect-1",
        result: expect.objectContaining({
          ok: true,
          status: "ready",
          canvasId: "canvas-agent-test",
          documentHash: expect.any(String),
          renderedQuality: {
            status: "ready",
            issues: [{ code: "overview-too-small", severity: "warning", message: "overview" }],
          },
        }),
      }),
    );
  });

  it("responds while its tab is temporarily hidden instead of dropping the request", async () => {
    render(
      <div className="hidden">
        <FlowchartDocumentEditor
          note={flowchartNote()}
          onContentChange={vi.fn()}
        />
      </div>,
    );

    await dispatchCanvasAgentRequest({
      requestId: "open-hidden",
      canvasId: "canvas-agent-test",
      action: "open",
    });

    expect(state.invoke).toHaveBeenCalledWith(
      "canvas_agent_respond",
      expect.objectContaining({
        requestId: "open-hidden",
        result: expect.objectContaining({
          ok: true,
          status: "ready",
          canvasId: "canvas-agent-test",
        }),
      }),
    );
  });

  it("returns invalid for a malformed apply patch without committing content", async () => {
    const onContentChange = renderEditor();

    await dispatchCanvasAgentRequest({
      requestId: "apply-invalid-1",
      canvasId: "canvas-agent-test",
      action: "apply",
      patch: { ops: [] },
    });

    expect(state.invoke).toHaveBeenCalledWith(
      "canvas_agent_respond",
      expect.objectContaining({
        requestId: "apply-invalid-1",
        result: expect.objectContaining({
          ok: false,
          status: "invalid",
          canvasId: "canvas-agent-test",
        }),
      }),
    );
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it("returns after commit and leaves visual inspection to an explicit inspect request", async () => {
    const doc = createBlankFlowchartDocument();
    state.canvasHandle.inspectQuality
      .mockResolvedValueOnce([{
        code: "render-missing-edge",
        severity: "error",
        message: "edge pending",
        edgeIds: ["e1"],
      }])
      .mockResolvedValueOnce([]);
    renderEditor();

    await dispatchCanvasAgentRequest({
      requestId: "apply-render-lag",
      canvasId: "canvas-agent-test",
      action: "apply",
      patch: {
        baseHash: computeFlowchartSemanticHash(doc),
        ops: [{
          name: "replaceGraph",
          graph: {
            direction: "TB",
            nodes: [
              { id: "a", kind: "start", label: "开始" },
              { id: "b", kind: "end", label: "结束" },
            ],
            edges: [{ id: "e1", source: "a", target: "b" }],
          },
        }],
      },
    });

    expect(state.canvasHandle.inspectQuality).not.toHaveBeenCalled();
    expect(state.invoke).toHaveBeenCalledWith(
      "canvas_agent_respond",
      expect.objectContaining({
        requestId: "apply-render-lag",
        result: expect.objectContaining({
          status: "applied",
          renderedQuality: { status: "not_requested", issues: [] },
        }),
      }),
    );
  });

  it("unsubscribes when unmounted while async listener registration is pending", async () => {
    let finishRegistration: (() => void) | undefined;
    const stopListening = vi.fn();
    state.listen.mockImplementationOnce((_event: string, listener: CanvasAgentEventListener) => (
      new Promise<() => void>((resolve) => {
        finishRegistration = () => {
          state.listeners.add(listener);
          resolve(stopListening);
        };
      })
    ));
    const view = render(
      <FlowchartDocumentEditor note={flowchartNote()} onContentChange={vi.fn()} />,
    );
    await waitFor(() => expect(state.listen).toHaveBeenCalledTimes(1));
    view.unmount();

    await act(async () => {
      finishRegistration?.();
      await Promise.resolve();
    });

    expect(stopListening).toHaveBeenCalledTimes(1);
  });
});
