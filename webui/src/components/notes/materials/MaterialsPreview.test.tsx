import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  httpFetch: vi.fn(),
  importOfficeSession: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ getServicesHttpBase: async () => "http://127.0.0.1:17174" }));
vi.mock("@/lib/tauri", () => ({ httpFetch: mocks.httpFetch }));
vi.mock("@/lib/office-client", () => ({ importOfficeSession: mocks.importOfficeSession }));
vi.mock("@/components/office/OfficeEditorHost", () => ({
  OfficeEditorHost: ({ initialSession }: { initialSession: { displayName: string } }) => (
    <div data-testid="office-editor">{initialSession.displayName}</div>
  ),
}));
vi.mock("@/components/MarkdownTextRenderer", () => ({ default: () => null }));

import { MaterialsPreview } from "./MaterialsPreview";

describe("MaterialsPreview Office source", () => {
  beforeEach(() => {
    mocks.httpFetch.mockReset();
    mocks.importOfficeSession.mockReset();
  });

  it("opens the library's authorized original in the Office editor", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]).buffer;
    mocks.httpFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => bytes });
    mocks.importOfficeSession.mockResolvedValue({ sessionId: "material-doc", displayName: "报告.docx" });
    render(<MaterialsPreview selection={{ kind: "raw", path: "raw/reports/报告.docx", knowledgeBaseId: "library-1" }} />);

    expect(await screen.findByTestId("office-editor")).toHaveTextContent("报告.docx");
    expect(mocks.httpFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:17174/api/materials/raw-binary/reports%2F%E6%8A%A5%E5%91%8A.docx?knowledgeBaseId=library-1",
    );
    expect(mocks.importOfficeSession).toHaveBeenCalledWith({
      filename: "报告.docx",
      sourceIdentity: "materials:library-1:reports/报告.docx",
      ownerSessionKey: "materials:library-1",
    }, bytes);
  });

  it("keeps a PDF on native PDF preview without creating an Office session", async () => {
    mocks.httpFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("about:blank");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const view = render(<MaterialsPreview selection={{ kind: "raw", path: "raw/reference.pdf", knowledgeBaseId: "library-1" }} />);
    await waitFor(() => expect(screen.getByTitle("reference.pdf")).toHaveAttribute("src", "about:blank"));
    expect(createUrl.mock.calls[0][0]).toHaveProperty("type", "application/pdf");
    expect(mocks.importOfficeSession).not.toHaveBeenCalled();
    view.unmount();
    expect(revokeUrl).toHaveBeenCalledWith("about:blank");
    createUrl.mockRestore();
    revokeUrl.mockRestore();
  });
});
