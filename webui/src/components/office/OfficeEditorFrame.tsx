import { forwardRef } from "react";

import type { OfficeDocumentType } from "./types";

interface OfficeEditorFrameProps {
  documentType: OfficeDocumentType;
  onLoad: () => void;
}

const OFFICE_EDITOR_BASE = "/office-editor";

const DOCUMENT_LABELS: Record<OfficeDocumentType, string> = {
  docs: "文档",
  sheets: "表格",
  slides: "幻灯片",
};

const ENTRY_PATHS: Record<OfficeDocumentType, string> = {
  docs: `${OFFICE_EDITOR_BASE}/docs/index.html`,
  sheets: `${OFFICE_EDITOR_BASE}/sheets/index.html`,
  slides: `${OFFICE_EDITOR_BASE}/slides/index.html`,
};

export const OfficeEditorFrame = forwardRef<HTMLIFrameElement, OfficeEditorFrameProps>(
  function OfficeEditorFrame({ documentType, onLoad }, ref) {
    return (
      <iframe
        ref={ref}
        src={ENTRY_PATHS[documentType]}
        title={`${DOCUMENT_LABELS[documentType]}编辑器`}
        sandbox="allow-same-origin allow-scripts"
        onLoad={onLoad}
        className="h-full w-full border-0 bg-[hsl(var(--editor-surface))]"
      />
    );
  },
);
