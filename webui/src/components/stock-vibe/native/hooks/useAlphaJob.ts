import { useCallback, useEffect, useRef, useState } from "react";
import { getStockVibeOperation, getStockVibeRequest, type StockVibeRequestRecord } from "@/lib/stock-vibe-api";
import { api, type AlphaBenchRequest, type AlphaCompareRequest, type AlphaBenchResult, type AlphaCompareResult, type AlphaProgress } from "../lib/api";
import { useNativeToast } from "../lib/toast";

export type AlphaJobStatus = "idle" | "submitting" | "streaming" | "done" | "error" | "disconnected";
type Request = AlphaBenchRequest | AlphaCompareRequest;
interface Saved { jobId: string | null; request: Request | null; pendingRequest: Request | null; }
const OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[a-f\d]{32}$/i;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function stored(key: string): Saved {
  try { const value = JSON.parse(localStorage.getItem(key) ?? "null"); if (object(value)) return { jobId: typeof value.jobId === "string" && OBJECT_ID.test(value.jobId) ? value.jobId : null, request: object(value.request) ? value.request as unknown as Request : null, pendingRequest: object(value.pendingRequest) && typeof value.pendingRequest.request_id === "string" && REQUEST_ID.test(value.pendingRequest.request_id) ? value.pendingRequest as unknown as Request : null }; } catch { /* Invalid local drafts never trigger a write. */ }
  return { jobId: null, request: null, pendingRequest: null };
}
function accepted(record: StockVibeRequestRecord, requestId: string): { operationId?: string; rejected?: boolean } {
  if (record.request_id?.replace(/-/g, "").toLowerCase() !== requestId.toLowerCase() || record.method !== "POST" || record.path !== "/mona/operations") return {};
  const signed = /^[a-f\d]{64}$/i.test(record.receipt_sha256 ?? ""), code = record.receipt?.status_code;
  if (record.status === "completed" && signed && code && code >= 200 && code < 300 && object(record.receipt?.body) && typeof record.receipt.body.operation_id === "string" && OBJECT_ID.test(record.receipt.body.operation_id)) return { operationId: record.receipt.body.operation_id };
  return { rejected: record.status === "rejected" && ((record.error_category === "not_dispatched" && record.receipt === null && record.source === null) || Boolean(signed && code && code >= 400 && code < 500)) };
}

/** Original AlphaJob UI contract backed by durable Mona operations. Recovery is GET-only. */
export function useAlphaJob<T extends AlphaBenchResult | AlphaCompareResult>(kind: "bench" | "compare", context = "default") {
  const key = `mona.stock-vibe.native-alpha-job.v1:${kind}:${context}`;
  const [saved, setSaved] = useState(() => stored(key));
  const savedRef = useRef(saved); savedRef.current = saved;
  const [status, setStatus] = useState<AlphaJobStatus>(() => saved.jobId || saved.pendingRequest ? "streaming" : "idle");
  const [progress, setProgress] = useState<AlphaProgress | null>(null), [result, setResult] = useState<T | null>(null), [formError, setFormError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const submitting = useRef(false), toast = useNativeToast(), notifyRef = useRef(toast.error); notifyRef.current = toast.error;
  const persist = useCallback((next: Saved, required = false) => {
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { if (required) { notifyRef.current("无法保存因子评测的提交凭据，本次没有执行。请检查本机存储后重试。"); return false; } }
    savedRef.current = next; setSaved(next); return true;
  }, [key]);
  const accept = useCallback((record: StockVibeRequestRecord, requestId: string) => {
    const receipt = accepted(record, requestId);
    if (receipt.operationId) { persist({ ...savedRef.current, jobId: receipt.operationId, pendingRequest: null }); setStatus("streaming"); }
    else if (receipt.rejected) { persist({ ...savedRef.current, pendingRequest: null }); setStatus("error"); notifyRef.current("因子评测请求未被接受，请核对因子、范围和时间设置后重新发起。"); }
    else setStatus("disconnected");
  }, [persist]);
  useEffect(() => {
    if (!saved.jobId && !saved.pendingRequest) return;
    let active = true, reading = false, done = false, warned = false;
    const poll = async () => {
      if (reading || submitting.current || done) return; reading = true;
      try {
        if (saved.pendingRequest?.request_id) { const record = await getStockVibeRequest(saved.pendingRequest.request_id); if (active) accept(record, saved.pendingRequest.request_id); }
        else if (saved.jobId) {
          const response = await getStockVibeOperation(saved.jobId), operation = response.native;
          if (!active) return;
          if (!object(operation) || operation.operation_id !== saved.jobId || operation.operation !== `alpha_${kind}`) throw new Error();
          const phase = object(operation.references) && object(operation.references.progress) ? operation.references.progress : null;
          if (phase && typeof phase.n_done === "number" && typeof phase.n_total === "number") setProgress(phase as unknown as AlphaProgress);
          if (operation.status === "completed") {
            let output: unknown = operation.tool_result; if (typeof output === "string") output = JSON.parse(output);
            if (!object(output)) throw new Error();
            setResult(output as unknown as T); setStatus("done"); done = true;
          } else if (["failed", "interrupted", "rejected"].includes(String(operation.status))) {
            setStatus("error"); done = true; notifyRef.current("因子评测未完成，请核对所选市场、时间范围和行情权限。已有记录已保留。");
          } else setStatus("streaming");
        }
      } catch { if (active) { setStatus("disconnected"); if (!warned) { warned = true; notifyRef.current("暂时无法核对因子评测进度，原请求已保留，系统不会重复执行。"); } } }
      finally { reading = false; }
    };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 2000); return () => { active = false; window.clearInterval(timer); };
  }, [accept, kind, revision, saved.jobId, saved.pendingRequest]);
  const submit = async (body: Request) => {
    if (submitting.current || ["submitting", "streaming", "disconnected"].includes(status)) return;
    const request = { ...body, request_id: crypto.randomUUID().replace(/-/g, "") };
    if (!persist({ jobId: null, request, pendingRequest: request }, true)) return;
    submitting.current = true; setStatus("submitting"); setFormError(null); setResult(null); setProgress(null);
    try { accept(await (kind === "bench" ? api.createAlphaBench(request as AlphaBenchRequest) : api.createAlphaCompare(request as AlphaCompareRequest)), request.request_id); }
    catch { setStatus("disconnected"); notifyRef.current("因子评测提交结果暂未确认，系统会核对原请求，请勿重复提交。"); }
    finally { submitting.current = false; }
  };
  return { status, jobId: saved.jobId, request: saved.request, pendingRequest: saved.pendingRequest, progress, result, formError, submit, setFormError, reconnect: () => setRevision((value) => value + 1), busy: ["submitting", "streaming", "disconnected"].includes(status) };
}
