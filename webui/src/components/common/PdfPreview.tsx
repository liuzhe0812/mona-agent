import { useEffect, useRef, useState } from "react";

export function PdfPreview({ filename, fetchBuffer }: {
  filename: string;
  fetchBuffer: () => Promise<ArrayBuffer>;
}) {
  const fetchRef = useRef(fetchBuffer);
  fetchRef.current = fetchBuffer;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    void fetchRef.current().then((bytes) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      setUrl(objectUrl);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "PDF 加载失败。");
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filename]);
  if (error) return <div role="alert" className="p-4 text-caption text-destructive">{error}</div>;
  if (!url) return <div role="status" className="p-4 text-caption text-muted-foreground">正在读取 PDF…</div>;
  return <iframe src={url} title={filename} className="h-full min-h-0 w-full flex-1 border-0" />;
}
