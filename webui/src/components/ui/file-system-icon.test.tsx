import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DOCUMENT_FILE_ICON_SRC, getFileIconSource, INLINE_FALLBACK_FILE_ICON_SRC } from "@/lib/file-icons";
import { resolveFileDisplayDescriptor } from "@/components/development/zcode/tools/fileDisplay";
import { FileSystemIcon } from "./file-system-icon";

describe("shared file icons", () => {
  it.each(["report.docx", "archive.tar.gz", "data.sqlite", "index.tsx", "unknown.custom"])("matches development file links for %s", (name) => {
    expect(getFileIconSource(name)).toBe(resolveFileDisplayDescriptor(name).fileIconSrc);
  });

  it("normalizes paths and common file families without relying on OS associations", () => {
    expect(getFileIconSource("C:\\Data\\REPORT.DOCX")).toBe(getFileIconSource("/data/report.doc"));
    expect(getFileIconSource("backup.tar.gz")).toBe(getFileIconSource("backup.zip"));
    expect(getFileIconSource("data.sqlite")).toBe(getFileIconSource("data.db"));
    expect(getFileIconSource("no-extension")).toBe(DOCUMENT_FILE_ICON_SRC);
    expect(getFileIconSource("unknown.custom")).toBe(DOCUMENT_FILE_ICON_SRC);
    expect(getFileIconSource("folder", true)).not.toBe(DOCUMENT_FILE_ICON_SRC);
    expect(getFileIconSource("folder.zip", true, true)).toBe(getFileIconSource("folder", true));
  });

  it("keeps a fixed icon slot and does not carry a broken icon into another file", () => {
    const { container, rerender } = render(<FileSystemIcon name="report.docx" />);
    const icon = container.querySelector("img")!;
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    fireEvent.error(icon);
    expect(icon).toHaveAttribute("src", DOCUMENT_FILE_ICON_SRC);
    fireEvent.error(icon);
    expect(icon).toHaveAttribute("src", INLINE_FALLBACK_FILE_ICON_SRC);
    fireEvent.error(icon);
    expect(icon).toHaveAttribute("src", INLINE_FALLBACK_FILE_ICON_SRC);
    rerender(<FileSystemIcon name="picture.png" />);
    expect(icon).toHaveAttribute("src", getFileIconSource("picture.png"));
  });
});
