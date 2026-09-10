import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OfficeEditorFrame } from "./OfficeEditorFrame";
import type { OfficeDocumentType } from "./types";

describe("OfficeEditorFrame", () => {
  it.each([
    ["docs", "/office-editor/docs/index.html", "文档编辑器"],
    ["sheets", "/office-editor/sheets/index.html", "表格编辑器"],
    ["slides", "/office-editor/slides/index.html", "幻灯片编辑器"],
  ] as const)("loads the same-origin %s entry", (documentType, expectedSrc, expectedTitle) => {
    const detachedContainer = document.createElement("div");
    const onLoad = vi.fn();
    const { container } = render(
      <OfficeEditorFrame
        documentType={documentType as OfficeDocumentType}
        onLoad={onLoad}
      />,
      { container: detachedContainer },
    );
    const frame = container.querySelector("iframe");

    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("src")).toBe(expectedSrc);
    expect(frame).toHaveAttribute("title", expectedTitle);
    expect(frame).toHaveAttribute("sandbox", "allow-same-origin allow-scripts");

    // Keep this a DOM-only regression test; firing the event avoids loading a
    // development URL that is unavailable in the test environment.
    fireEvent.load(frame);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });
});
