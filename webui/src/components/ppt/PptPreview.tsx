import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { fetchPptPreviewPort } from "@/lib/api";
import { useClient } from "@/providers/ClientProvider";

interface PptPreviewProps {
  projectName: string | null;
}

export function PptPreview({ projectName }: PptPreviewProps) {
  const { token } = useClient();
  const [port, setPort] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!projectName) {
      setPort(null);
      setReady(false);
      setError(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const name = projectName;

    async function poll() {
      try {
        const res = await fetchPptPreviewPort(token, name);
        if (cancelled) return;

        if (res.port == null) {
          timer = setTimeout(poll, 3000);
          return;
        }

        setPort(res.port);

        try {
          const resp = await fetch(`http://localhost:${res.port}/api/config`);
          if (!resp.ok) throw new Error();
          if (cancelled) return;
          setReady(true);
        } catch {
          if (cancelled) return;
          timer = setTimeout(poll, 3000);
        }
      } catch {
        if (cancelled) return;
        setError(true);
      }
    }

    setPort(null);
    setReady(false);
    setError(false);
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectName, token]);

  if (!projectName) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        开始生成后将在此展示预览
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        预览服务未就绪
      </div>
    );
  }

  if (!port || !ready) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在连接预览服务…
      </div>
    );
  }

  return (
    <iframe
      src={`http://localhost:${port}`}
      className="h-full w-full border-0"
      sandbox="allow-scripts allow-same-origin"
    />
  );
}
