import { useEffect, useRef, type RefObject } from "react";
import type { MindElixirInstance, NodeObj } from "mind-elixir";

import { isTauri } from "@/lib/tauri";
import { waitForCanvasRender, waitForCanvasTask } from "../flowchart/canvas-render-task";
import { computeBaseHash, serializeMindMap, type MindMapNode } from "./mindmap-outline";
import { applyPatch, parsePatch } from "./mindmap-patch";

interface CanvasRequest {
  requestId: string;
  canvasId?: string;
  action: "open" | "inspect" | "apply" | "export";
  patch?: Record<string, unknown>;
  includeVisual?: boolean;
  format?: "png" | "svg";
  deadlineMs?: number;
}

interface MindMapCanvasAgentOptions {
  noteId: string;
  contentRef: RefObject<string>;
  mindRef: RefObject<MindElixirInstance | null>;
  containerRef: RefObject<HTMLElement | null>;
  readRoot: () => MindMapNode;
  commit: (markdown: string) => void;
}

const editors = new Map<string, symbol[]>();

export function useMindMapCanvasAgent(options: MindMapCanvasAgentOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const { noteId } = options;

  useEffect(() => {
    if (!isTauri()) return;
    const editor = Symbol(noteId);
    editors.set(noteId, [...(editors.get(noteId) ?? []), editor]);
    let disposed = false;
    let busy = false;
    const unlisten: Array<() => void> = [];
    const requests = new Map<string, { controller: AbortController; result?: Record<string, unknown> }>();
    void (async () => {
      const [{ listen }, { invoke }] = await Promise.all([
        import("@tauri-apps/api/event"), import("@tauri-apps/api/core"),
      ]);
      if (disposed) return;
      const register = async <T,>(event: string, handler: (event: { payload: T }) => void | Promise<void>) => {
        const stop = await listen<T>(event, handler);
        if (disposed) stop();
        else unlisten.push(stop);
      };
      await register<{ requestId: string }>("canvas-agent-cancel", ({ payload }) => {
        requests.get(payload.requestId)?.controller.abort(new Error("画布请求已超时"));
      });
      if (disposed) return;
      await register<CanvasRequest>("canvas-agent-request", async ({ payload }) => {
        if (disposed || !payload?.requestId || !payload.action) return;
        if (payload.canvasId && payload.canvasId !== noteId) return;
        if (editors.get(noteId)?.at(-1) !== editor) return;
        const respond = (result: Record<string, unknown>) => invoke("canvas_agent_respond", {
          requestId: payload.requestId, result,
        }).catch((error) => console.error("Canvas response failed", payload.requestId, error));
        const existing = requests.get(payload.requestId);
        if (existing) {
          if (existing.result) await respond(existing.result);
          return;
        }
        if (payload.deadlineMs && Date.now() >= payload.deadlineMs) return;
        const controller = new AbortController();
        const entry: { controller: AbortController; result?: Record<string, unknown> } = { controller };
        requests.set(payload.requestId, entry);
        const timer = window.setTimeout(() => controller.abort(new Error("画布请求已超时")),
          Math.max(1, (payload.deadlineMs ?? Date.now() + 25_000) - Date.now()));
        let stage = "received";
        const reportStage = (next: string) => {
          stage = next;
          void invoke("canvas_agent_stage", { requestId: payload.requestId, stage })
            .catch((error) => console.error("Canvas stage report failed", payload.requestId, error));
        };
        reportStage(stage);
        let result: Record<string, unknown>;
        let ownsVisualWork = false;
        try {
          const state = latest.current;
          const mind = state.mindRef.current;
          if (!mind) throw new Error("思维导图尚未就绪");
          const current = state.contentRef.current;
          const hash = computeBaseHash(current);
          if (payload.action !== "open" && busy) throw new Error("画布正在检查或导出，请等待当前操作完成");
          if (payload.action === "apply") {
            const parsed = parsePatch(JSON.stringify(payload.patch));
            if (!parsed.ok) {
              result = { ok: false, status: "invalid", message: parsed.message };
            } else if (parsed.patch.ops.length > 50 || new TextEncoder().encode(JSON.stringify(payload.patch)).length > 64 * 1024) {
              result = { ok: false, status: "invalid", message: "画布修改超过大小限制" };
            } else if (parsed.patch.baseHash !== hash || payload.patch?.baseDocumentHash !== hash) {
              result = { ok: false, status: "conflict", message: "画布已修改，请重新读取后再修改" };
            } else {
              reportStage("parsed");
              // Legacy outlines have no stored IDs; apply against the editor's live IDs after checking the stored version.
              const canonical = serializeMindMap(state.readRoot());
              const applied = applyPatch(canonical, { ...parsed.patch, baseHash: computeBaseHash(canonical) });
              if (!applied.ok) {
                result = { ok: false, status: "conflict", message: applied.message };
              } else {
                controller.signal.throwIfAborted();
                const unchanged = applied.appliedCount === 0 || applied.markdown === current;
                if (!unchanged) state.commit(applied.markdown);
                reportStage("committed");
                const nextHash = computeBaseHash(unchanged ? current : applied.markdown);
                result = {
                  ok: true, status: unchanged ? "unchanged" : "applied",
                  semanticHash: nextHash, documentHash: nextHash, summary: applied.summary,
                  renderedQuality: { status: "not_requested", issues: [] },
                };
              }
            }
          } else {
            result = {
              ok: true, status: "ready", kind: "mindmap", document: state.readRoot(),
              semanticHash: hash, documentHash: hash, writable: true,
              selection: { nodeIds: mind.currentNodes.map((node) => node.nodeObj.id) },
              renderedQuality: { status: "not_requested", issues: [] },
              capabilities: {
                actions: ["open", "inspect", "apply", "export"], maxOps: 50, formats: ["png", "svg"],
                operations: ["addChild", "insertSibling", "updateTopic", "removeNode", "moveNode"],
              },
            };
            if (payload.action === "inspect" || payload.action === "export") {
              busy = ownsVisualWork = true;
              reportStage("inspect");
              await waitForCanvasRender(state.containerRef.current, controller.signal);
              const issues: Array<Record<string, unknown>> = [];
              const checkNode = (node: NodeObj) => {
                const rect = mind.findEle(node.id)?.getBoundingClientRect();
                if (!rect || rect.width < 2 || rect.height < 2) {
                  issues.push({ code: "render-missing-node", severity: "error", nodeIds: [node.id], message: "节点尚未完成渲染" });
                }
                if (node.expanded !== false) node.children?.forEach(checkNode);
              };
              checkNode(mind.getData().nodeData);
              result.renderedQuality = { status: "ready", issues };
              if (payload.includeVisual || payload.action === "export") {
                reportStage("export");
                const format = payload.action === "export" ? payload.format ?? "png" : "png";
                const blob = await waitForCanvasTask(Promise.resolve(format === "svg" ? mind.exportSvg() : mind.exportPng()), controller.signal);
                if (!blob || blob.size === 0) throw new Error("思维导图未返回图像数据");
                const data = await waitForCanvasTask(format === "svg" ? blob.text() : new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result));
                  reader.onerror = () => reject(reader.error ?? new Error("读取导图图像失败"));
                  reader.readAsDataURL(blob);
                }), controller.signal);
                if (payload.action === "export") {
                  result = { ok: true, status: "exported", format, documentHash: hash, data };
                } else result.visualData = data;
              }
              controller.signal.throwIfAborted();
              if (hash !== computeBaseHash(latest.current.contentRef.current)) {
                result = { ok: false, status: "conflict", message: "检查或导出期间画布已修改，请重新读取" };
              }
            }
          }
        } catch (error) {
          result = { ok: false, status: "unavailable", stage, message: error instanceof Error ? error.message : String(error) };
        } finally {
          window.clearTimeout(timer);
          if (ownsVisualWork) busy = false;
        }
        result.canvasId = noteId;
        entry.result = result;
        for (const [id, request] of requests) {
          if (requests.size <= 8) break;
          if (request.result) requests.delete(id);
        }
        await respond(result);
      });
    })().catch((error) => console.error("Canvas listener registration failed", noteId, error));
    return () => {
      disposed = true;
      const remaining = (editors.get(noteId) ?? []).filter((value) => value !== editor);
      if (remaining.length) editors.set(noteId, remaining);
      else editors.delete(noteId);
      requests.forEach(({ controller }) => controller.abort(new Error("画布已关闭")));
      unlisten.forEach((stop) => stop());
    };
  }, [noteId]);
}
