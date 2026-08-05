/**
 * v2 图表文档编辑器：集成工具栏、形状面板、画布、属性面板，
 * 处理历史、文档同步、选区管理和快捷键。
 * 拖动期间实时更新画布（不入历史栈），拖动结束时才压入历史并序列化。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NodeChange, EdgeChange } from "@xyflow/react";
import { Download, Group, Redo2, Settings, Trash2, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import type { OperationNote } from "../notes-data";
import {
  createBlankDiagramDocument,
  createShapeElement,
  generateDiagramId,
  paragraphBlock,
  type DiagramConnector,
  type DiagramDocument,
  type DiagramPoint,
  type DiagramSize,
  type ShapeKind,
} from "./diagram-document";
import {
  buildDiagramPlainText,
  parseDiagramMarkdown,
  serializeDiagramMarkdown,
} from "./diagram-serializer";
import {
  canRedo,
  canUndo,
  createDiagramHistory,
  pushDiagramCommand,
  redoDiagram,
  undoDiagram,
  type DiagramHistory,
} from "./diagram-reducer";
import type { DiagramCommand } from "./diagram-commands";
import {
  DiagramCanvas,
  DiagramFooter,
  type CanvasTool,
  type DiagramCanvasHandle,
} from "./DiagramCanvas";
import { DiagramShapePanel } from "./DiagramShapePanel";
import { DiagramInspector } from "./DiagramInspector";
import {
  useDiagramSelection,
  type DiagramDocumentStateSnapshot,
} from "./DiagramSelectionContext";
import { computeDiagramDocumentHash, computeDiagramSemanticHash } from "./diagram-hash";
import { computeDiagramLayout } from "./layout/diagram-layout";

const HISTORY_LIMIT = 100;

function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

function ToolbarButton({
  disabled,
  onClick,
  tip,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  tip: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}

export interface DiagramDocumentEditorProps {
  note: OperationNote;
  onContentChange: (next: { contentMarkdown: string; plainText: string }) => void;
  toolbarExtra?: ReactNode;
}

export function DiagramDocumentEditor({
  note,
  onContentChange,
  toolbarExtra,
}: DiagramDocumentEditorProps) {
  const canvasRef = useRef<DiagramCanvasHandle | null>(null);
  const [activeTool, setActiveTool] = useState<CanvasTool>("select");
  const [showGrid, setShowGrid] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState<{ elementIds: string[]; connectorIds: string[] }>({
    elementIds: [],
    connectorIds: [],
  });
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<{ x: number; y: number; zoom: number } | null>(null);

  const parsed = useMemo(() => parseDiagramMarkdown(note.contentMarkdown), [note.contentMarkdown]);

  const [history, setHistory] = useState<DiagramHistory>(() =>
    parsed.ok
      ? createDiagramHistory(parsed.document)
      : createDiagramHistory(createBlankDiagramDocument("freeform")),
  );

  const hasSelection = selection.elementIds.length > 0 || selection.connectorIds.length > 0;

  const historyRef = useRef(history);
  historyRef.current = history;
  const noteTitleRef = useRef(note.title);
  noteTitleRef.current = note.title;
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const lastSyncedMdRef = useRef(note.contentMarkdown);
  const isLocalCommitRef = useRef(false);

  useEffect(() => {
    if (isLocalCommitRef.current) {
      isLocalCommitRef.current = false;
      lastSyncedMdRef.current = note.contentMarkdown;
      return;
    }
    if (note.contentMarkdown === lastSyncedMdRef.current) return;
    lastSyncedMdRef.current = note.contentMarkdown;
    const result = parseDiagramMarkdown(note.contentMarkdown);
    if (!result.ok) {
      setParseError(result.message);
      return;
    }
    setParseError(null);
    setHistory(createDiagramHistory(result.document));
  }, [note.contentMarkdown]);

  const commit = useCallback((next: DiagramHistory) => {
    const doc = next.present.document;
    const title = noteTitleRef.current || "未命名图表";
    const md = serializeDiagramMarkdown(title, doc);
    const plainText = buildDiagramPlainText(title, doc);
    isLocalCommitRef.current = true;
    lastSyncedMdRef.current = md;
    setHistory(next);
    onContentChangeRef.current({ contentMarkdown: md, plainText });
  }, []);

  const executeCommand = useCallback(
    (cmd: DiagramCommand) => {
      const result = pushDiagramCommand(historyRef.current, cmd);
      if (!result.ok) {
        setParseError(result.message);
        return;
      }
      commit(result.history);
    },
    [commit],
  );

  const undo = useCallback(() => {
    const next = undoDiagram(historyRef.current);
    if (next) commit(next);
  }, [commit]);
  const redo = useCallback(() => {
    const next = redoDiagram(historyRef.current);
    if (next) commit(next);
  }, [commit]);

  const dropShape = useCallback(
    (kind: ShapeKind, x: number, y: number) => {
      const id = generateDiagramId("shape");
      const el = createShapeElement(id, kind, "形状", { x, y });
      executeCommand({ type: "addElements", elements: [el] });
    },
    [executeCommand],
  );
  const addShape = useCallback((kind: ShapeKind) => dropShape(kind, 100, 100), [dropShape]);

  const handleConnect = useCallback(
    (conn: { source: string; target: string; sourceHandle?: string; targetHandle?: string }) => {
      if (conn.source === conn.target) return;
      const id = generateDiagramId("conn");
      const connector: DiagramConnector = {
        id,
        source: { elementId: conn.source, portId: conn.sourceHandle },
        target: { elementId: conn.target, portId: conn.targetHandle },
        route: "orthogonal",
        markerStart: "none",
        markerEnd: "arrow-closed",
        stroke: { color: "#1f2329", width: 1.5, style: "solid" },
        zIndex: 0,
      };
      executeCommand({ type: "addConnectors", connectors: [connector] });
    },
    [executeCommand],
  );

  const dragBaselineRef = useRef<DiagramDocument | null>(null);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const removeIds = changes.filter((c): c is { type: "remove"; id: string } => c.type === "remove").map((c) => c.id);
      if (removeIds.length > 0) {
        executeCommand({ type: "removeElements", ids: removeIds });
        return;
      }
      const posChanges = changes.filter((c): c is Extract<NodeChange, { type: "position" }> => c.type === "position");
      const dimChanges = changes.filter((c): c is Extract<NodeChange, { type: "dimensions" }> => c.type === "dimensions");
      if (posChanges.length === 0 && dimChanges.length === 0) return;

      const dragEnded = posChanges.some((c) => c.dragging === false) || dimChanges.some((c) => c.resizing === false);
      const currentDoc = historyRef.current.present.document;
      if (!dragBaselineRef.current) dragBaselineRef.current = currentDoc;

      const updateMap = new Map<string, { position?: DiagramPoint; size?: DiagramSize }>();
      for (const c of posChanges) { const u = updateMap.get(c.id) ?? {}; u.position = c.position; updateMap.set(c.id, u); }
      for (const c of dimChanges) { const u = updateMap.get(c.id) ?? {}; u.size = c.dimensions; updateMap.set(c.id, u); }

      const updatedDoc: DiagramDocument = {
        ...currentDoc,
        elements: currentDoc.elements.map((el) => {
          const u = updateMap.get(el.id);
          return u ? { ...el, position: u.position ?? el.position, size: u.size ?? el.size } : el;
        }),
      };

      if (dragEnded) {
        const baseline = dragBaselineRef.current ?? currentDoc;
        dragBaselineRef.current = null;
        const h = historyRef.current;
        const nextHistory: DiagramHistory = {
          past: [...h.past, { document: baseline, revision: h.present.revision, documentHash: computeDiagramDocumentHash(baseline) }].slice(-HISTORY_LIMIT),
          present: { document: updatedDoc, revision: h.present.revision + 1, documentHash: computeDiagramDocumentHash(updatedDoc) },
          future: [],
        };
        commit(nextHistory);
      } else {
        setHistory((h) => ({ ...h, present: { ...h.present, document: updatedDoc } }));
      }
    },
    [executeCommand, commit],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removeIds = changes.filter((c): c is { type: "remove"; id: string } => c.type === "remove").map((c) => c.id);
      if (removeIds.length > 0) executeCommand({ type: "removeConnectors", ids: removeIds });
    },
    [executeCommand],
  );

  const handleElementLabelEdit = useCallback(
    (id: string, text: string) =>
      executeCommand({
        type: "updateElements",
        updates: [{ id, patch: { textBlocks: [paragraphBlock(generateDiagramId("tb"), text)] } }],
      }),
    [executeCommand],
  );
  const handleElementTitleEdit = useCallback(
    (id: string, title: string) =>
      executeCommand({ type: "updateElements", updates: [{ id, patch: { title } }] }),
    [executeCommand],
  );
  const handleConnectorLabelEdit = useCallback(
    (id: string, text: string) =>
      executeCommand({
        type: "updateConnectors",
        updates: [{ id, patch: { label: [paragraphBlock(generateDiagramId("tb"), text)] } }],
      }),
    [executeCommand],
  );

  const handleReconnect = useCallback(
    (
      edgeId: string,
      next: { source: string; target: string; sourceHandle?: string; targetHandle?: string },
    ) =>
      executeCommand({
        type: "updateConnectors",
        updates: [
          {
            id: edgeId,
            patch: {
              source: { elementId: next.source, portId: next.sourceHandle },
              target: { elementId: next.target, portId: next.targetHandle },
            },
          },
        ],
      }),
    [executeCommand],
  );

  const autoLayout = useCallback(async () => {
    const positions = await computeDiagramLayout(historyRef.current.present.document);
    if (positions.length > 0) {
      executeCommand({ type: "applyLayout", positions });
      requestAnimationFrame(() => canvasRef.current?.fitView());
    }
  }, [executeCommand]);

  const exportPng = useCallback(async () => {
    try {
      const dataUrl = await canvasRef.current?.exportToPng({ scale: 2, background: "theme" });
      if (dataUrl) downloadDataUrl(dataUrl, `${noteTitleRef.current || "图表"}.png`);
    } catch (e) {
      setParseError(String(e));
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      const meta = e.ctrlKey || e.metaKey;
      const isZ = e.key === "z" || e.key === "Z";
      if (meta && isZ && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (meta && isZ && e.shiftKey) { e.preventDefault(); redo(); }
      else if (meta && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); }
      if ((e.key === "Delete" || e.key === "Backspace") && hasSelection) {
        e.preventDefault();
        if (selection.elementIds.length > 0) executeCommand({ type: "removeElements", ids: selection.elementIds });
        if (selection.connectorIds.length > 0) executeCommand({ type: "removeConnectors", ids: selection.connectorIds });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo, selection, executeCommand, hasSelection]);

  const { setSelection: setCtxSelection } = useDiagramSelection();
  const docState: DiagramDocumentStateSnapshot = useMemo(
    () => ({
      revision: history.present.revision,
      documentHash: history.present.documentHash,
      semanticHash: computeDiagramSemanticHash(history.present.document),
    }),
    [history.present],
  );

  useEffect(() => {
    setCtxSelection(
      note.id,
      hasSelection ? { elementIds: selection.elementIds, connectorIds: selection.connectorIds } : null,
      docState,
    );
  }, [note.id, selection, docState, setCtxSelection, hasSelection]);

  const errorMessage = parseError ?? (!parsed.ok ? parsed.message : null);
  if (errorMessage) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-sm font-medium text-foreground">图表文件解析失败</div>
        <div className="max-w-md text-xs text-muted-foreground">{errorMessage}</div>
      </div>
    );
  }

  const doc = history.present.document;
  const readOnly = false;

  const deleteSelection = () => {
    if (selection.elementIds.length > 0) executeCommand({ type: "removeElements", ids: selection.elementIds });
    if (selection.connectorIds.length > 0) executeCommand({ type: "removeConnectors", ids: selection.connectorIds });
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
          <ToolbarButton disabled={!canUndo(history)} onClick={undo} tip="撤销 (Ctrl+Z)">
            <Undo2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton disabled={!canRedo(history)} onClick={redo} tip="重做 (Ctrl+Shift+Z)">
            <Redo2 className="h-4 w-4" />
          </ToolbarButton>

          <Separator orientation="vertical" className="mx-1 h-4" />

          {selection.elementIds.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => executeCommand({ type: "groupElements", elementIds: selection.elementIds })}
            >
              <Group className="mr-1 h-4 w-4" />
              组合
            </Button>
          )}
          {hasSelection && (
            <Button variant="ghost" size="sm" className="h-7" onClick={deleteSelection}>
              <Trash2 className="mr-1 h-4 w-4" />
              删除
            </Button>
          )}

          <div className="ml-auto flex items-center gap-1">
            <ToolbarButton onClick={exportPng} tip="导出 PNG">
              <Download className="h-4 w-4" />
            </ToolbarButton>
            {toolbarExtra}
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1">
          <DiagramShapePanel
            onAddShape={addShape}
            onDropShape={dropShape}
            readOnly={readOnly}
            activeTool={activeTool}
            onToolChange={setActiveTool}
          />
          <div className="flex h-full min-w-0 flex-1 flex-col">
            <DiagramCanvas
              ref={canvasRef}
              document={doc}
              readOnly={readOnly}
              selection={selection}
              noteId={note.id}
              initialViewport={viewport}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={handleConnect}
              onReconnect={handleReconnect}
              onViewportChange={setViewport}
              onSelectionChange={setSelection}
              onElementLabelEdit={handleElementLabelEdit}
              onElementTitleEdit={handleElementTitleEdit}
              onConnectorLabelEdit={handleConnectorLabelEdit}
              onDropShape={dropShape}
              activeTool={activeTool}
              showGrid={showGrid}
              snapToGrid={snapToGrid}
            />
            <DiagramFooter
              zoom={zoom}
              onZoomChange={(z) => {
                setZoom(z);
                canvasRef.current?.setZoom(z);
              }}
              onFitView={() => canvasRef.current?.fitView()}
              showGrid={showGrid}
              onShowGridChange={setShowGrid}
              snapToGrid={snapToGrid}
              onSnapToGridChange={setSnapToGrid}
              onAutoLayout={autoLayout}
              readOnly={readOnly}
            />
          </div>

          {inspectorOpen && (
            <div className="w-64 shrink-0 border-l border-border bg-background">
              <DiagramInspector
                document={doc}
                selection={selection}
                onUpdateElement={(id, patch) =>
                  executeCommand({ type: "updateElements", updates: [{ id, patch }] })
                }
                onUpdateConnector={(id, patch) =>
                  executeCommand({ type: "updateConnectors", updates: [{ id, patch }] })
                }
                onUpdateDocument={(patch) => executeCommand({ type: "setCanvas", patch })}
                onGroup={(ids) => executeCommand({ type: "groupElements", elementIds: ids })}
                onUngroup={(ids) => executeCommand({ type: "ungroupElements", groupIds: ids })}
              />
            </div>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 z-30 h-7 w-7"
            onClick={() => setInspectorOpen(!inspectorOpen)}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </TooltipProvider>
  );
}
