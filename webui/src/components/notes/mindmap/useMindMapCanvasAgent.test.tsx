import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MindElixirInstance } from "mind-elixir";
import { useMindMapCanvasAgent } from "./useMindMapCanvasAgent";
import { computeBaseHash, parseMindMap, type MindMapNode } from "./mindmap-outline";

type CanvasRequest = {
  requestId: string;
  canvasId?: string;
  action: "open" | "inspect" | "apply" | "export";
  patch?: Record<string, unknown>;
  includeVisual?: boolean;
  format?: "png" | "svg";
  deadlineMs?: number;
};

type EventListener = (event: { payload: unknown }) => unknown;

const state = vi.hoisted(() => ({
  registrations: [] as Array<{
    event: string;
    listener: EventListener;
    active: boolean;
  }>,
  listen: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: state.listen }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: state.invoke }));

const NOTE_ID = "mindmap-canvas-test";
const LEGACY_MARKDOWN = "# Root\n- Alpha";

function initialRoot(): MindMapNode {
  return {
    id: "root-live-id",
    topic: "Root",
    children: [{ id: "alpha-live-id", topic: "Alpha", children: [] }],
  };
}

function flatten(root: MindMapNode): Array<{ nodeObj: { id: string } }> {
  return [
    { nodeObj: { id: root.id } },
    ...root.children.flatMap(flatten),
  ];
}

function createMindAdapter(rootRef: { current: MindMapNode }) {
  return {
    currentNodes: flatten(rootRef.current),
    findEle: vi.fn(() => ({
      getBoundingClientRect: () => ({ width: 60, height: 24 }),
    })),
    getData: vi.fn(() => ({ nodeData: rootRef.current })),
    exportPng: vi.fn(async () => new Blob(["mindmap-png-bytes"], { type: "image/png" })),
    exportSvg: vi.fn(async () => new Blob(["<svg>mindmap</svg>"], { type: "image/svg+xml" })),
  };
}

type TestMind = ReturnType<typeof createMindAdapter>;
type HarnessContext = {
  contentRef: { current: string };
  rootRef: { current: MindMapNode };
  containerRef: { current: HTMLDivElement | null };
  mind: TestMind;
  commit: ReturnType<typeof vi.fn>;
};

let lastHarness: HarnessContext | undefined;

function AgentHarness({ noteId = NOTE_ID }: { noteId?: string }) {
  const contentRef = useRef(LEGACY_MARKDOWN);
  const rootRef = useRef(initialRoot());
  const adapterRef = useRef<TestMind | null>(null);
  if (!adapterRef.current) adapterRef.current = createMindAdapter(rootRef);
  const mind = adapterRef.current;
  const mindRef = useRef<MindElixirInstance | null>(mind as unknown as MindElixirInstance);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const commit = useRef(vi.fn((markdown: string) => {
    contentRef.current = markdown;
    const parsed = parseMindMap(markdown);
    if (parsed.ok) {
      rootRef.current = parsed.root;
      mind.currentNodes = flatten(parsed.root);
    }
  })).current;

  useMindMapCanvasAgent({
    noteId,
    contentRef: contentRef as RefObject<string>,
    mindRef,
    containerRef: containerRef as RefObject<HTMLElement | null>,
    readRoot: () => rootRef.current,
    commit,
  });

  lastHarness = { contentRef, rootRef, containerRef, mind, commit };
  return <div data-testid="mindmap-canvas-root" ref={containerRef} />;
}

function renderAgent(noteId = NOTE_ID) {
  const view = render(<AgentHarness noteId={noteId} />);
  if (!lastHarness) throw new Error("Mind-map test harness did not render");
  return { ...lastHarness, view };
}

function activeListeners(event: string) {
  return state.registrations.filter((registration) => registration.active && registration.event === event);
}

async function emit(event: string, payload: unknown): Promise<void> {
  await Promise.all(activeListeners(event).map(({ listener }) => Promise.resolve(listener({ payload }))));
}

async function waitForListeners(event: string, count = 1): Promise<void> {
  await waitFor(() => expect(activeListeners(event)).toHaveLength(count));
}

function responseCalls(requestId: string) {
  return state.invoke.mock.calls.filter(([command, args]) =>
    command === "canvas_agent_respond" && args.requestId === requestId);
}

function responseFor(requestId: string): Record<string, unknown> {
  const call = responseCalls(requestId)[0];
  if (!call) throw new Error(`No canvas response for ${requestId}`);
  return call[1].result;
}

function setCanvasBounds(container: HTMLDivElement, width = 640, height = 480) {
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("useMindMapCanvasAgent", () => {
  beforeEach(() => {
    lastHarness = undefined;
    state.registrations.length = 0;
    state.listen.mockReset();
    state.listen.mockImplementation(async (event: string, listener: EventListener) => {
      const registration = { event, listener, active: true };
      state.registrations.push(registration);
      return () => { registration.active = false; };
    });
    state.invoke.mockReset();
    state.invoke.mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  it("opens the matching canvas while hidden and returns both document hashes", async () => {
    renderAgent();
    await waitForListeners("canvas-agent-request");

    await emit("canvas-agent-request", {
      requestId: "wrong-canvas",
      canvasId: "another-note",
      action: "open",
    } satisfies CanvasRequest);
    expect(responseCalls("wrong-canvas")).toHaveLength(0);

    await act(async () => emit("canvas-agent-request", {
      requestId: "open-hidden",
      canvasId: NOTE_ID,
      action: "open",
    } satisfies CanvasRequest));

    const result = responseFor("open-hidden");
    const hash = computeBaseHash(LEGACY_MARKDOWN);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: "ready",
      kind: "mindmap",
      canvasId: NOTE_ID,
      semanticHash: hash,
      documentHash: hash,
      document: expect.objectContaining({
        id: "root-live-id",
        children: [expect.objectContaining({ id: "alpha-live-id", topic: "Alpha" })],
      }),
    }));
  });

  it("applies a path patch to a legacy outline using both hashes and commits a duplicate request once", async () => {
    const harness = renderAgent();
    await waitForListeners("canvas-agent-request");
    const patch = {
      baseHash: computeBaseHash(LEGACY_MARKDOWN),
      baseDocumentHash: computeBaseHash(LEGACY_MARKDOWN),
      ops: [{ name: "updateTopic", path: [0], expectedTopic: "Alpha", topic: "Renamed" }],
    };

    const request: CanvasRequest = {
      requestId: "apply-legacy",
      canvasId: NOTE_ID,
      action: "apply",
      patch,
    };
    await act(async () => emit("canvas-agent-request", request));
    await act(async () => emit("canvas-agent-request", request));

    expect(harness.commit).toHaveBeenCalledTimes(1);
    expect(harness.contentRef.current).toContain("Renamed");
    expect(harness.rootRef.current.children[0]).toEqual(expect.objectContaining({
      id: "alpha-live-id",
      topic: "Renamed",
    }));
    expect(responseCalls("apply-legacy")).toHaveLength(2);
    expect(responseFor("apply-legacy")).toEqual(expect.objectContaining({ ok: true, status: "applied" }));

    const opened = responseFor("apply-legacy");
    await act(async () => emit("canvas-agent-request", {
      requestId: "apply-stable-id",
      canvasId: NOTE_ID,
      action: "apply",
      patch: {
        baseHash: opened.semanticHash,
        baseDocumentHash: opened.documentHash,
        ops: [{ name: "addChild", parentId: "alpha-live-id", topic: "Leaf" }],
      },
    } satisfies CanvasRequest));
    expect(harness.rootRef.current.children[0].children[0].topic).toBe("Leaf");
    expect(harness.rootRef.current.children[0].id).toBe("alpha-live-id");
  });

  it("rejects invalid patches and stale document hashes without committing", async () => {
    const harness = renderAgent();
    await waitForListeners("canvas-agent-request");
    const baseHash = computeBaseHash(LEGACY_MARKDOWN);

    await emit("canvas-agent-request", {
      requestId: "invalid-patch",
      canvasId: NOTE_ID,
      action: "apply",
      patch: { baseHash, baseDocumentHash: computeBaseHash(LEGACY_MARKDOWN), ops: [{ name: "updateTopic", path: "bad", topic: "x" }] },
    } satisfies CanvasRequest);
    await emit("canvas-agent-request", {
      requestId: "stale-base-hash",
      canvasId: NOTE_ID,
      action: "apply",
      patch: { baseHash: "stale", baseDocumentHash: computeBaseHash(LEGACY_MARKDOWN), ops: [{ name: "updateTopic", path: [0], topic: "x" }] },
    } satisfies CanvasRequest);
    await emit("canvas-agent-request", {
      requestId: "stale-document-hash",
      canvasId: NOTE_ID,
      action: "apply",
      patch: { baseHash, baseDocumentHash: "stale", ops: [{ name: "updateTopic", path: [0], topic: "x" }] },
    } satisfies CanvasRequest);

    expect(responseFor("invalid-patch")).toEqual(expect.objectContaining({ ok: false, status: "invalid" }));
    expect(responseFor("stale-base-hash")).toEqual(expect.objectContaining({ ok: false, status: "conflict" }));
    expect(responseFor("stale-document-hash")).toEqual(expect.objectContaining({ ok: false, status: "conflict" }));
    expect(harness.commit).not.toHaveBeenCalled();
  });

  it("exports actual Blob bytes and reports a hidden canvas or empty image as unavailable", async () => {
    const harness = renderAgent();
    await waitForListeners("canvas-agent-request");

    await emit("canvas-agent-request", {
      requestId: "inspect-hidden",
      canvasId: NOTE_ID,
      action: "inspect",
      includeVisual: true,
    } satisfies CanvasRequest);
    expect(responseFor("inspect-hidden")).toEqual(expect.objectContaining({
      ok: false,
      status: "unavailable",
      message: expect.stringContaining("不可见"),
    }));

    setCanvasBounds(harness.containerRef.current!);
    harness.mind.exportPng.mockResolvedValueOnce(new Blob([], { type: "image/png" }));
    await act(async () => emit("canvas-agent-request", {
      requestId: "inspect-empty-image",
      canvasId: NOTE_ID,
      action: "inspect",
      includeVisual: true,
    } satisfies CanvasRequest));
    expect(responseFor("inspect-empty-image")).toEqual(expect.objectContaining({
      ok: false,
      status: "unavailable",
      message: expect.stringContaining("图像数据"),
    }));

    const bytes = "actual-png-data";
    harness.mind.exportPng.mockResolvedValueOnce(new Blob([bytes], { type: "image/png" }));
    await act(async () => emit("canvas-agent-request", {
      requestId: "inspect-image",
      canvasId: NOTE_ID,
      action: "inspect",
      includeVisual: true,
    } satisfies CanvasRequest));
    expect(responseFor("inspect-image")).toEqual(expect.objectContaining({
      ok: true,
      visualData: `data:image/png;base64,${btoa(bytes)}`,
    }));

    const svg = "<svg><text>Mind map</text></svg>";
    harness.mind.exportSvg.mockResolvedValueOnce(new Blob([svg], { type: "image/svg+xml" }));
    await act(async () => emit("canvas-agent-request", {
      requestId: "export-svg",
      canvasId: NOTE_ID,
      action: "export",
      format: "svg",
    } satisfies CanvasRequest));
    expect(responseFor("export-svg")).toEqual(expect.objectContaining({
      ok: true,
      status: "exported",
      format: "svg",
      data: svg,
    }));
  });

  it("reports a conflict if the outline changes while an export is running", async () => {
    const harness = renderAgent();
    setCanvasBounds(harness.containerRef.current!);
    await waitForListeners("canvas-agent-request");

    let finishExport!: (blob: Blob) => void;
    harness.mind.exportPng.mockReturnValueOnce(new Promise<Blob>((resolve) => { finishExport = resolve; }));
    const pending = emit("canvas-agent-request", {
      requestId: "export-conflict",
      canvasId: NOTE_ID,
      action: "export",
      format: "png",
    } satisfies CanvasRequest);
    await waitFor(() => expect(harness.mind.exportPng).toHaveBeenCalledTimes(1));
    harness.contentRef.current = "# Root\n- Changed by the user";
    finishExport(new Blob(["image"], { type: "image/png" }));
    await pending;

    expect(responseFor("export-conflict")).toEqual(expect.objectContaining({ ok: false, status: "conflict" }));
    expect(harness.commit).not.toHaveBeenCalled();
  });

  it.each(["cancel", "unmount"] as const)("does not submit a late response after %s", async (mode) => {
    const harness = renderAgent();
    setCanvasBounds(harness.containerRef.current!);
    await waitForListeners("canvas-agent-request");

    harness.mind.exportPng.mockReturnValueOnce(new Promise<Blob>(() => {}));
    const pending = emit("canvas-agent-request", {
      requestId: `aborted-${mode}`,
      canvasId: NOTE_ID,
      action: "export",
      format: "png",
    } satisfies CanvasRequest);
    await waitFor(() => expect(harness.mind.exportPng).toHaveBeenCalledTimes(1));

    if (mode === "cancel") {
      await emit("canvas-agent-cancel", { requestId: `aborted-${mode}` });
    } else {
      harness.view.unmount();
    }
    await pending;

    expect(harness.commit).not.toHaveBeenCalled();
    const responses = responseCalls(`aborted-${mode}`);
    if (responses.length) {
      expect(responses[0][1].result).toEqual(expect.objectContaining({ ok: false, status: "unavailable" }));
    }
  });

  it("responds once when multiple editor instances share a note id", async () => {
    renderAgent();
    await waitForListeners("canvas-agent-request");
    render(<AgentHarness />);
    await waitForListeners("canvas-agent-request", 2);

    await emit("canvas-agent-request", {
      requestId: "shared-note",
      canvasId: NOTE_ID,
      action: "open",
    } satisfies CanvasRequest);

    expect(responseCalls("shared-note")).toHaveLength(1);
    expect(responseFor("shared-note")).toEqual(expect.objectContaining({ ok: true, kind: "mindmap" }));
  });
});
