/**
 * 3D 模型安全预览。
 *
 * 生成的 TypeScript 在主页面编译为 JS（compileModelSource），随后仅通过
 * 结构化 postMessage 送入无 allow-same-origin 的沙箱 iframe 执行。
 * 预览与导出共用同一份编译结果。
 *
 * 预览状态机：initializing（沙箱未就绪）→ empty（无模型）→ loading（编译/
 * 加载中）→ ready（模型已加载）/ error。相机、重置视图、截图等操作仅在
 * ready 态可用。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { getServicesHttpBase } from "@/lib/api";
import { cn } from "@/lib/utils";

import { compileModelSource } from "./compileModel";
import { IFRAME_SANDBOX_ATTR, buildSandboxHtml } from "./sandboxHtml";
import {
  FIXED_CAMERAS,
  buildResetViewMessage,
  buildSetCameraMessage,
  buildSetGridMessage,
  type FixedCamera,
} from "./sandboxProtocol";
import { orbitControlsSource, threeCoreSource, threeModuleSource } from "./threeRaw";

const CAMERA_LABELS: Record<FixedCamera, string> = {
  front: "正视",
  side: "侧视",
  top: "顶视",
  iso: "轴测",
};

type PreviewStatus = "initializing" | "empty" | "loading" | "ready" | "error";

const STATUS_LABELS: Record<PreviewStatus, string> = {
  initializing: "正在初始化预览…",
  empty: "暂无模型",
  loading: "正在加载模型…",
  ready: "",
  error: "",
};

interface ThreePreviewProps {
  projectName: string;
  modelSource?: string | null;
  onRenderSaved?: (path: string) => void;
}

export function ThreePreview({ projectName, modelSource, onRenderSaved }: ThreePreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const modelSourceRef = useRef(modelSource);
  modelSourceRef.current = modelSource;
  const autoScreenshotRef = useRef<string | null>(null); // Track auto-captured model source hash
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("initializing");
  const [gridVisible, setGridVisible] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  const srcDoc = useMemo(() => buildSandboxHtml(), []);

  const post = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  const loadModel = useCallback(
    (source: string | null | undefined) => {
      if (!source) {
        setStatus("empty");
        return;
      }
      try {
        const js = compileModelSource(source);
        setError(null);
        setStatus("loading");
        post({ type: "load-model", payload: { code: js } });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    },
    [post],
  );

  const saveRender = useCallback(
    async (dataUrl: string) => {
      setSaving(true);
      try {
        const base = await getServicesHttpBase();
        const resp = await fetch(`${base}/api/three/project/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: projectName, action: "save-render", dataUrl }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as { path?: string };
        if (data.path) onRenderSaved?.(data.path);
        setSavedTick(true);
        setTimeout(() => setSavedTick(false), 2000);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [projectName, onRenderSaved],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string; payload?: Record<string, unknown> } | null;
      if (!data?.type) return;
      switch (data.type) {
        case "ready":
          readyRef.current = true;
          loadModel(modelSourceRef.current);
          break;
        case "model-loaded":
          setStatus("ready");
          setError(null);
          break;
        case "grid-set":
          if (typeof data.payload?.visible === "boolean") setGridVisible(data.payload.visible);
          break;
        case "screenshot":
          if (typeof data.payload?.dataUrl === "string") {
            void saveRender(data.payload.dataUrl);
          }
          break;
        case "error":
          setError(String(data.payload?.message ?? "sandbox error"));
          setStatus("error");
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [loadModel, saveRender]);

  // 模型源码更新且沙箱已就绪时重新加载
  useEffect(() => {
    if (readyRef.current) loadModel(modelSource);
  }, [modelSource, loadModel]);

  // 自动截图：模型加载完成后延迟触发，为 AI 评审提供视觉证据
  useEffect(() => {
    if (status !== "ready" || !modelSource) return;
    // 用 modelSource 长度作为简易 hash，避免重复截图同一模型
    const sourceKey = `${projectName}:${modelSource.length}`;
    if (autoScreenshotRef.current === sourceKey) return;

    const timer = setTimeout(() => {
      post({ type: "capture-screenshot", payload: { auto: true } });
      autoScreenshotRef.current = sourceKey;
    }, 1500); // 等待模型稳定渲染

    return () => clearTimeout(timer);
  }, [status, modelSource, projectName, post]);

  const interactive = status === "ready";
  const statusText = STATUS_LABELS[status];

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border/40 px-2 py-1.5">
        {FIXED_CAMERAS.map((cam) => (
          <Button
            key={cam}
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[13px]"
            disabled={!interactive}
            onClick={() => post(buildSetCameraMessage(cam))}
          >
            {CAMERA_LABELS[cam]}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2.5 text-[13px]"
          disabled={!interactive}
          onClick={() => post(buildResetViewMessage())}
        >
          重置视图
        </Button>
        <Button
          variant={gridVisible ? "secondary" : "ghost"}
          size="sm"
          className="h-7 px-2.5 text-[13px]"
          disabled={status === "initializing" || status === "loading"}
          onClick={() => post(buildSetGridMessage(!gridVisible))}
        >
          网格
        </Button>
        <div className="flex-1" />
        {statusText && (
          <span className="px-1 text-[11px] text-muted-foreground">{statusText}</span>
        )}
        <span
          className={cn(
            "px-1 text-[11px] text-muted-foreground transition-opacity",
            savedTick ? "opacity-100" : "opacity-0",
          )}
        >
          截图已保存
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2.5 text-[13px]"
          disabled={!interactive || saving}
          onClick={() => post({ type: "capture-screenshot", payload: {} })}
        >
          {saving ? "保存中…" : "截图"}
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <iframe
          ref={iframeRef}
          title="3D 预览"
          sandbox={IFRAME_SANDBOX_ATTR}
          srcDoc={srcDoc}
          className="absolute inset-0 h-full w-full border-0"
          onLoad={() =>
            post({
              type: "init",
              payload: { threeSource: threeModuleSource, threeCoreSource, orbitControlsSource },
            })
          }
        />
        {error && (
          <div className="absolute inset-x-0 bottom-0 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
