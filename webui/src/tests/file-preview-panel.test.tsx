import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreviewPanel } from "@/components/deliver/FilePreviewPanel";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
import { ClientProvider } from "@/providers/ClientProvider";
import type { DeliveredFile } from "@/lib/types";
import { fetchFilePreviewBlob } from "@/lib/api";
import type { OfficeSessionState } from "@/components/office/types";

const officeImport = vi.hoisted(() => vi.fn());
const renderAbc = vi.hoisted(() => vi.fn((target: HTMLElement) => {
  target.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
  return [{ warnings: [] }];
}));

vi.mock("abcjs", () => ({
  renderAbc,
  TimingCallbacks: class {},
  synth: {
    CreateSynth: class {},
    getMidiFile: vi.fn(),
  },
}));

vi.mock("@/components/deliver/GuitarTabPreview", () => ({
  GuitarTabPreview: ({ source }: { source: string }) => (
    <div data-testid="guitar-tab-preview">{source}</div>
  ),
}));

vi.mock("@/lib/office-client", () => ({
  importOfficeSession: officeImport,
}));

vi.mock("@/components/office/OfficeEditorHost", () => ({
  OfficeEditorHost: ({ initialSession }: { initialSession: OfficeSessionState }) => (
    <div data-testid="office-editor-host">{initialSession.displayName}</div>
  ),
}));

vi.mock("@/components/canvas/CanvasArtifactPreview", () => ({
  CanvasArtifactPreview: ({
    file,
    scope,
    sessionKey,
    roomId,
  }: {
    file: DeliveredFile;
    scope: string;
    sessionKey?: string | null;
    roomId?: string | null;
  }) => (
    <div
      data-testid="canvas-artifact-preview"
      data-path={file.artifact_ref?.relative_path || file.path}
      data-scope={scope}
      data-session={sessionKey ?? ""}
      data-room={roomId ?? ""}
    />
  ),
}));

vi.mock("@/lib/api", () => ({
  fetchFilePreviewBlob: vi.fn(async (_token: string, params: { path: string }) => {
    if (params.path.endsWith(".mp4")) {
      if ((params as { artifactId?: string | null }).artifactId) {
        throw new Error("HTTP 404");
      }
      return {
        blob: new Blob(["video"], { type: "text/plain" }),
        mime: "text/plain",
      };
    }
    if (params.path.endsWith(".html")) {
      return {
        blob: new Blob([
          '<style>.icon{background:url("assets/icon.svg")}</style>'
            + '<link rel="stylesheet" href="assets/report.css">'
            + '<img src="assets/icon.svg"><object data="./assets/chart.svg"></object>',
        ], { type: "text/html" }),
        mime: "text/html",
      };
    }
    if (params.path.endsWith("report.css")) {
      return {
        blob: new Blob([".badge{background:url('../fonts/icon.woff2')}"], { type: "text/css" }),
        mime: "text/css",
      };
    }
    if (params.path.endsWith(".py")) {
      return {
        blob: new Blob(["import pandas as pd\nprint(pd.__version__)"], { type: "text/plain" }),
        mime: "text/plain",
      };
    }
    if (params.path.endsWith(".abc")) {
      return {
        blob: new Blob(["X:1\nT:Test\nM:4/4\nL:1/8\nK:C\nCDEF GABc|"], { type: "text/plain" }),
        mime: "text/plain",
      };
    }
    if (params.path.endsWith(".atex")) {
      return {
        blob: new Blob([String.raw`\title "Tab" \track "Guitar" \staff {tabs}`], { type: "text/plain" }),
        mime: "text/plain",
      };
    }
    return {
      blob: new Blob(["<svg></svg>"], { type: "image/svg+xml" }),
      mime: "image/svg+xml",
    };
  }),
}));

function makeClient() {
  return {
    status: "open" as const,
    defaultChatId: null,
    onStatus: () => () => {},
    onChat: () => () => {},
    onError: () => () => {},
    onSessionUpdate: () => () => {},
    onRuntimeModelUpdate: () => () => {},
    getRunStartedAt: () => null,
    getGoalState: () => undefined,
    sendMessage: vi.fn(),
    newChat: vi.fn(),
    attach: vi.fn(),
    connect: vi.fn(),
    close: vi.fn(),
    updateUrl: vi.fn(),
  };
}

function wrap(children: ReactNode) {
  return (
    <ClientProvider
      client={makeClient() as unknown as import("@/lib/mona-client").MonaClient}
      token="tok"
    >
      {children}
    </ClientProvider>
  );
}

function artifact(name: string): DeliveredFile {
  return {
    path: name,
    absolute_path: `/ws/output/${name}`,
    name,
    size: 5,
    size_human: "5 B",
    mime: "text/plain",
  };
}

function previewWith(file: DeliveredFile, sessionKey: string | null = null) {
  useFilePreviewStore.setState({
    file,
    scope: "shared",
    sessionKey,
    fullscreen: false,
  });
}

function officeSession(sessionId: string, displayName: string, type: OfficeSessionState["type"]): OfficeSessionState {
  return {
    sessionId,
    displayName,
    type,
    version: { editorEpoch: "epoch-1", modelRevision: 0 },
    checkpointVersion: null,
    savedVersion: null,
    dirty: true,
    editorConnected: false,
    saveState: "dirty",
    lastError: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("FilePreviewPanel", () => {
  beforeEach(() => {
    vi.mocked(fetchFilePreviewBlob).mockClear();
    officeImport.mockReset();
    useFilePreviewStore.setState({
      file: null,
      scope: "shared",
      sessionKey: null,
      fullscreen: false,
      artifactBaseline: null,
      viewedArtifactPaths: new Set(),
      treeCollapsedByOwner: {},
      treeExpansionInitializedByOwner: {},
    });
  });

  it("returns to the list via the back button", async () => {
    previewWith(artifact("a.txt"));
    render(wrap(<FilePreviewPanel files={[artifact("a.txt")]} />));

    fireEvent.click(await screen.findByTitle("返回列表"));

    expect(useFilePreviewStore.getState().file).toBeNull();
  });

  it("cycles through the scope file list with prev/next", async () => {
    const a = artifact("a.txt");
    const b = artifact("b.txt");
    const c = artifact("c.txt");
    previewWith(b);
    render(wrap(<FilePreviewPanel files={[a, b, c]} />));

    fireEvent.click(await screen.findByTitle("下一个文件"));
    expect(useFilePreviewStore.getState().file?.name).toBe("c.txt");

    // Wrap-around: past the last file comes the first one.
    fireEvent.click(screen.getByTitle("下一个文件"));
    expect(useFilePreviewStore.getState().file?.name).toBe("a.txt");

    fireEvent.click(screen.getByTitle("上一个文件"));
    expect(useFilePreviewStore.getState().file?.name).toBe("c.txt");
  });

  it("routes Mona canvas files through the canvas preview in direct and room sessions", async () => {
    const file: DeliveredFile = {
      ...artifact("C:/workspace/output/canvases/产品规划.mona-canvas"),
      name: "产品规划",
      artifact_ref: {
        id: "canvas-artifact",
        owner_kind: "agent",
        owner_id: "mona",
        relative_path: "canvases/产品规划.mona-canvas",
        created_by_agent_id: "mona",
        created_at: "2026-09-06T00:00:00Z",
      },
    };
    previewWith(file, "websocket:chat-1");
    const direct = render(wrap(<FilePreviewPanel files={[file]} />));

    const directPreview = await screen.findByTestId("canvas-artifact-preview");
    expect(directPreview).toHaveAttribute("data-scope", "shared");
    expect(directPreview).toHaveAttribute("data-session", "websocket:chat-1");
    expect(directPreview).toHaveAttribute("data-path", "canvases/产品规划.mona-canvas");
    expect(screen.getByTitle("返回列表")).toBeInTheDocument();
    expect(fetchFilePreviewBlob).not.toHaveBeenCalled();

    direct.unmount();
    render(wrap(
      <FilePreviewPanel
        files={[file]}
        previewFile={file}
        previewScope="room"
        previewRoomId="room-1"
      />,
    ));

    const roomPreview = await screen.findByTestId("canvas-artifact-preview");
    expect(roomPreview).toHaveAttribute("data-scope", "room");
    expect(roomPreview).toHaveAttribute("data-room", "room-1");
  });

  it("sandboxes HTML previews without same-origin access", async () => {
    const html: DeliveredFile = {
      ...artifact("page.html"),
      mime: "text/html",
    };
    previewWith(html);
    render(wrap(<FilePreviewPanel files={[html]} />));

    const iframe = (await waitFor(() =>
      screen.getByTitle("File preview"),
    )) as HTMLIFrameElement;
    expect(iframe.sandbox).toContain("allow-scripts");
    expect(iframe.sandbox).not.toContain("allow-same-origin");
  });

  it("inlines relative HTML assets for srcdoc previews", async () => {
    const html: DeliveredFile = {
      ...artifact("reports/page.html"),
      mime: "text/html",
    };
    previewWith(html);
    render(wrap(<FilePreviewPanel files={[html]} />));

    const iframe = (await waitFor(() => screen.getByTitle("File preview"))) as HTMLIFrameElement;
    await waitFor(() => expect(iframe.srcdoc).toContain("data:image/svg+xml;base64,"));
    expect(iframe.srcdoc).not.toContain('src="assets/icon.svg"');
    expect(iframe.srcdoc).not.toContain('href="assets/report.css"');
    expect(vi.mocked(fetchFilePreviewBlob)).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ path: "reports/assets/icon.svg", artifactId: null }),
    );
  });

  it("mounts fullscreen previews at the document body", async () => {
    const html = artifact("page.html");
    previewWith(html);
    render(wrap(<FilePreviewPanel files={[html]} />));
    fireEvent.click(await screen.findByTitle("全屏显示"));

    const overlay = document.querySelector("body > .fixed.inset-0");
    expect(overlay).toBeTruthy();
  });

  it("plays video artifacts inline", async () => {
    const video: DeliveredFile = {
      ...artifact("clip.mp4"),
      mime: "video/mp4",
      artifact_ref: {
        id: "stale-artifact-id",
        owner_kind: "agent",
        owner_id: "mona",
        relative_path: "clip.mp4",
        created_by_agent_id: "mona",
        created_at: "2026-08-26T00:00:00Z",
      },
    };
    previewWith(video);
    render(wrap(<FilePreviewPanel files={[video]} />));

    const player = await screen.findByLabelText("视频预览：clip.mp4");
    expect(player.tagName).toBe("VIDEO");
    expect(player).toHaveAttribute("controls");
    expect(vi.mocked(fetchFilePreviewBlob)).toHaveBeenLastCalledWith(
      "tok",
      expect.objectContaining({ path: "clip.mp4", artifactId: null }),
    );
  });

  it("syntax highlights recognized code files", async () => {
    const python = artifact("analysis.py");
    previewWith(python);
    const { container } = render(wrap(<FilePreviewPanel files={[python]} />));

    await waitFor(() => {
      expect(container.querySelector("code.language-python")).toBeInTheDocument();
    }, { timeout: 5_000 });
    expect(container.querySelector("code.language-python")).toHaveTextContent("import pandas as pd");
  });

  it("renders ABC artifacts with the dedicated score preview", async () => {
    const score = artifact("melody.abc");
    previewWith(score);
    render(wrap(<FilePreviewPanel files={[score]} />));

    expect(await screen.findByTestId("music-score-preview")).toBeInTheDocument();
    expect(screen.getByText("乐谱")).toBeInTheDocument();
    await waitFor(() => expect(renderAbc).toHaveBeenCalled());
    expect(vi.mocked(fetchFilePreviewBlob)).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ path: "melody.abc" }),
    );
  });

  it("routes AlphaTex artifacts to the independent guitar-tab preview", async () => {
    const tab = artifact("canon.atex");
    previewWith(tab);
    render(wrap(<FilePreviewPanel files={[tab]} />));

    expect(await screen.findByTestId("guitar-tab-preview")).toHaveTextContent("\\staff {tabs}");
    expect(screen.queryByTestId("music-score-preview")).not.toBeInTheDocument();
    expect(vi.mocked(fetchFilePreviewBlob)).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ path: "canon.atex" }),
    );
  });

  it("shows a loading state instead of the unsupported preview before content arrives", async () => {
    const pending = deferred<{ blob: Blob; mime: string }>();
    vi.mocked(fetchFilePreviewBlob).mockImplementationOnce(() => pending.promise);
    const python = artifact("loading.py");
    previewWith(python);
    const { container } = render(wrap(<FilePreviewPanel files={[python]} />));

    expect(await screen.findByText("正在加载预览…")).toBeInTheDocument();
    expect(screen.queryByText("此文件类型不支持预览")).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({
        blob: new Blob(["print('ready')"], { type: "text/plain" }),
        mime: "text/plain",
      });
    });
    await waitFor(() => {
      expect(container.querySelector("code.language-python")).toHaveTextContent("print('ready')");
    });
  });

  it.each([
    ["报告.docx", "docs", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["销售计划.xlsx", "sheets", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["季度汇报.pptx", "slides", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ] as const)("opens %s in the Office editor with the fetched bytes", async (filename, type, mime) => {
    const bytes = Uint8Array.from([0x4d, 0x4f, 0x4e, filename.length]);
    const file: DeliveredFile = {
      ...artifact(`reports/${filename}`),
      name: filename,
      mime,
      absolute_path: `/ws/output/reports/${filename}`,
    };
    officeImport.mockResolvedValue(officeSession(`office-${type}`, filename, type));
    vi.mocked(fetchFilePreviewBlob).mockResolvedValue({
      blob: new Blob([bytes], { type: mime }),
      mime,
    });
    previewWith(file, "websocket:chat-office");

    render(wrap(<FilePreviewPanel files={[file]} />));

    expect(await screen.findByTestId("office-editor-host")).toHaveTextContent(filename);
    expect(vi.mocked(fetchFilePreviewBlob)).toHaveBeenCalledWith("tok", {
      scope: "shared",
      path: file.path,
      sessionKey: "websocket:chat-office",
      room: null,
      artifactId: null,
    });
    expect(officeImport).toHaveBeenCalledWith(
      {
        filename,
        sourceIdentity: file.absolute_path,
        ownerSessionKey: "websocket:chat-office",
      },
      expect.any(ArrayBuffer),
    );
    const importedBytes = officeImport.mock.calls[0]?.[1] as ArrayBuffer;
    expect(new Uint8Array(importedBytes)).toEqual(bytes);
  });

  it("keeps a PDF as a binary preview when the server reports text/plain", async () => {
    const file = {
      ...artifact("report.pdf"),
      mime: "application/pdf",
    };
    vi.mocked(fetchFilePreviewBlob).mockResolvedValue({
      blob: new Blob(["%PDF-1.7"], { type: "text/plain" }),
      mime: "text/plain",
    });
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pdf-preview");
    previewWith(file, "websocket:chat-pdf");

    render(wrap(<FilePreviewPanel files={[file]} />));

    await waitFor(() => expect(createObjectUrl).toHaveBeenCalledOnce());
    const previewBlob = createObjectUrl.mock.calls[0]?.[0];
    expect(previewBlob).toBeInstanceOf(Blob);
    expect(previewBlob).toHaveProperty("type", "application/pdf");
    expect(screen.getByTitle("File preview")).toHaveAttribute("src", "blob:pdf-preview");
    expect(officeImport).not.toHaveBeenCalled();
    createObjectUrl.mockRestore();
  });
});
