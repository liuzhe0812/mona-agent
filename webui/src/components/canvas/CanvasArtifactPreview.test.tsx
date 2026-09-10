import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliveredFile } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  fetchFilePreviewBlob: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock("@/lib/api", () => ({
  fetchFilePreviewBlob: mocks.fetchFilePreviewBlob,
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({ token: "tok" }),
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: mocks.isTauri,
}));

vi.mock("./CanvasFileView", () => ({
  CanvasFileView: ({ filePath }: { filePath: string }) => (
    <div data-testid="canvas-file-view">{filePath}</div>
  ),
}));

vi.mock("@/components/notes/flowchart/FlowchartDocumentEditor", () => ({
  FlowchartDocumentEditor: ({
    note,
    readOnly,
    writerInstanceId,
  }: {
    note: { title: string };
    readOnly?: boolean;
    writerInstanceId?: string;
  }) => (
    <div
      data-testid="flowchart-preview"
      data-read-only={String(!!readOnly)}
      data-writer-instance={writerInstanceId ?? ""}
    >
      {note.title}
    </div>
  ),
}));

vi.mock("@/components/notes/mindmap/MindMapDocumentEditor", () => ({
  MindMapDocumentEditor: ({ note }: { note: { title: string } }) => (
    <div data-testid="mindmap-preview">{note.title}</div>
  ),
}));

import { CanvasArtifactPreview } from "./CanvasArtifactPreview";

const file: DeliveredFile = {
  path: "C:/workspace/output/canvases/产品规划.mona-canvas",
  absolute_path: "C:/workspace/output/canvases/产品规划.mona-canvas",
  name: "产品规划",
  size: 256,
  size_human: "256 B",
  mime: "application/octet-stream",
  artifact_ref: {
    id: "stale-artifact-id",
    owner_kind: "agent",
    owner_id: "mona",
    relative_path: "canvases/产品规划.mona-canvas",
    created_by_agent_id: "mona",
    created_at: "2026-09-06T00:00:00Z",
  },
};

describe("CanvasArtifactPreview", () => {
  beforeEach(() => {
    mocks.fetchFilePreviewBlob.mockReset();
    mocks.isTauri.mockReset();
    mocks.isTauri.mockReturnValue(false);
  });

  it("falls back to the canvas relative path when an artifact reference is stale", async () => {
    const canvas = {
      version: 1,
      id: "canvas-1",
      kind: "mindmap",
      title: "产品规划",
      originChatId: "chat-1",
      createdAt: "2026-09-06T00:00:00Z",
      updatedAt: "2026-09-06T00:00:00Z",
      contentMarkdown: "# 产品规划",
    };
    mocks.fetchFilePreviewBlob
      .mockRejectedValueOnce(new Error("HTTP 404"))
      .mockResolvedValueOnce({
        blob: { text: async () => JSON.stringify(canvas) } as Blob,
        mime: "text/plain",
      });

    render(
      <CanvasArtifactPreview
        file={file}
        scope="shared"
        sessionKey="websocket:chat-1"
      />,
    );

    expect(await screen.findByTestId("mindmap-preview")).toHaveTextContent("产品规划");
    await waitFor(() => expect(mocks.fetchFilePreviewBlob).toHaveBeenCalledTimes(2));
    expect(mocks.fetchFilePreviewBlob).toHaveBeenNthCalledWith(1, "tok", {
      scope: "shared",
      path: "canvases/产品规划.mona-canvas",
      sessionKey: "websocket:chat-1",
      room: null,
      artifactId: "stale-artifact-id",
    });
    expect(mocks.fetchFilePreviewBlob).toHaveBeenNthCalledWith(2, "tok", {
      scope: "shared",
      path: "canvases/产品规划.mona-canvas",
      sessionKey: "websocket:chat-1",
      room: null,
      artifactId: null,
    });
  });

  it("opens a local desktop canvas in the editable file view", () => {
    mocks.isTauri.mockReturnValue(true);

    render(
      <CanvasArtifactPreview
        file={file}
        scope="shared"
        sessionKey="websocket:chat-1"
      />,
    );

    expect(screen.getByTestId("canvas-file-view")).toHaveTextContent(file.absolute_path);
    expect(mocks.fetchFilePreviewBlob).not.toHaveBeenCalled();
    expect(screen.queryByText("另一个标签页")).not.toBeInTheDocument();
  });

  it("uses an explicit read-only mode for a non-local flowchart preview", async () => {
    mocks.fetchFilePreviewBlob.mockResolvedValueOnce({
      blob: {
        text: async () => JSON.stringify({
          version: 1,
          id: "canvas-flow",
          kind: "flowchart",
          title: "退款流程",
          createdAt: "2026-09-06T00:00:00Z",
          updatedAt: "2026-09-06T00:00:00Z",
          contentMarkdown: "# 退款流程",
        }),
      } as Blob,
      mime: "text/plain",
    });

    render(<CanvasArtifactPreview file={file} scope="room" roomId="room-1" />);

    const preview = await screen.findByTestId("flowchart-preview");
    expect(preview).toHaveAttribute("data-read-only", "true");
    expect(preview).toHaveAttribute("data-writer-instance", "");
  });
});
