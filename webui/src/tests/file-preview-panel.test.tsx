import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreviewPanel } from "@/components/deliver/FilePreviewPanel";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
import { ClientProvider } from "@/providers/ClientProvider";
import type { DeliveredFile } from "@/lib/types";
import { fetchFilePreviewBlob } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchFilePreviewBlob: vi.fn(async (_token: string, params: { path: string }) => {
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

function previewWith(file: DeliveredFile) {
  useFilePreviewStore.setState({
    file,
    scope: "shared",
    sessionKey: null,
    fullscreen: false,
  });
}

describe("FilePreviewPanel", () => {
  beforeEach(() => {
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
});
