import { useEffect, useRef, useState } from "react";
import { LayoutGrid, FileImage, Image as ImageIcon, Maximize2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getGatewayHttpBase } from "@/lib/api";

/** draw.io postMessage JSON 协议消息体 */
type DrawioMessage = {
  event?: string;
  action?: string;
  xml?: string;
  format?: string;
  data?: string;
  modified?: boolean;
  [key: string]: unknown;
};

/** draw.io embed postMessage JSON 协议封装 */
class DrawioProtocol {
  private iframe: HTMLIFrameElement;
  private listeners = new Map<string, Set<(data: DrawioMessage) => void>>();
  private handler: (event: MessageEvent) => void;

  constructor(iframe: HTMLIFrameElement) {
    this.iframe = iframe;
    this.handler = (event: MessageEvent) => {
      if (event.source !== this.iframe.contentWindow) return;
      let msg: DrawioMessage;
      if (typeof event.data === "string") {
        try {
          msg = JSON.parse(event.data) as DrawioMessage;
        } catch {
          return;
        }
      } else if (typeof event.data === "object" && event.data !== null) {
        msg = event.data as DrawioMessage;
      } else {
        return;
      }
      const evt = msg.event;
      if (typeof evt !== "string") return;
      const cbs = this.listeners.get(evt);
      if (cbs) {
        for (const cb of cbs) cb(msg);
      }
    };
    window.addEventListener("message", this.handler);
  }

  /** 向 iframe 发送 JSON 指令 */
  send(action: string, data?: Record<string, unknown>): void {
    const win = this.iframe.contentWindow;
    if (!win) return;
    const msg = JSON.stringify({ action, ...data });
    win.postMessage(msg, "*");
  }

  /** 监听 draw.io 回传事件 */
  on(event: string, callback: (data: DrawioMessage) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
  }

  /** 加载 mxGraph XML 到编辑器 */
  load(xml: string): void {
    this.send("load", { xml });
  }

  /** 请求导出为指定格式 */
  export(format: string): void {
    this.send("export", { format });
  }

  /** 执行自动布局 */
  layout(type: string): void {
    this.send("layout", { layouts: [{ type }] });
  }

  /** 移除事件监听,释放资源 */
  destroy(): void {
    window.removeEventListener("message", this.handler);
    this.listeners.clear();
  }
}

export interface DrawioEditorProps {
  /** 初始 mxGraph XML,null 则显示空图 */
  xml: string | null;
  onSave: (xml: string) => void;
  onExport?: (format: string, data: string) => void;
  onReady?: () => void;
}

export function DrawioEditor({ xml, onSave, onExport, onReady }: DrawioEditorProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const protoRef = useRef<DrawioProtocol | null>(null);
  const xmlRef = useRef<string | null>(xml);
  const onSaveRef = useRef(onSave);
  const onExportRef = useRef(onExport);
  const onReadyRef = useRef(onReady);

  const [editorUrl, setEditorUrl] = useState<string>("");
  const [ready, setReady] = useState(false);

  xmlRef.current = xml;
  onSaveRef.current = onSave;
  onExportRef.current = onExport;
  onReadyRef.current = onReady;

  // 解析 gateway HTTP 地址,构建 draw.io embed URL
  useEffect(() => {
    let cancelled = false;
    getGatewayHttpBase().then((base) => {
      if (cancelled || !base) return;
      setEditorUrl(`${base}/drawio/index.html?embed=1&proto=json&offline=1`);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // iframe 就绪后初始化 DrawioProtocol 并注册事件监听
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !editorUrl) return;

    const proto = new DrawioProtocol(iframe);
    protoRef.current = proto;

    proto.on("init", () => {
      setReady(true);
      if (xmlRef.current) {
        proto.load(xmlRef.current);
      }
      onReadyRef.current?.();
    });

    proto.on("autosave", (data) => {
      if (typeof data.xml === "string") {
        onSaveRef.current?.(data.xml);
      }
    });

    proto.on("export", (data) => {
      if (data.format && data.data) {
        onExportRef.current?.(data.format, data.data);
      }
    });

    return () => {
      proto.destroy();
      protoRef.current = null;
    };
  }, [editorUrl]);

  const handleLayout = () => {
    protoRef.current?.layout("mxHierarchicalLayout");
  };

  const handleExportSvg = () => {
    protoRef.current?.export("svg");
  };

  const handleExportPng = () => {
    protoRef.current?.export("png");
  };

  const handleFit = () => {
    protoRef.current?.send("fit");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/70 px-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-[12px]"
          disabled={!ready}
          onClick={handleLayout}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          自动布局
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-[12px]"
          disabled={!ready}
          onClick={handleExportSvg}
        >
          <FileImage className="h-3.5 w-3.5" />
          导出 SVG
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-[12px]"
          disabled={!ready}
          onClick={handleExportPng}
        >
          <ImageIcon className="h-3.5 w-3.5" />
          导出 PNG
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-[12px]"
          disabled={!ready}
          onClick={handleFit}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          适配视图
        </Button>
      </div>
      {editorUrl ? (
        <iframe
          ref={iframeRef}
          src={editorUrl}
          className="h-full w-full border-0"
          title="draw.io editor"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
          正在连接 draw.io 服务...
        </div>
      )}
    </div>
  );
}
