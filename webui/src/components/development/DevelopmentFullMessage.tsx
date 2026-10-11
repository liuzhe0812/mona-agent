import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { developmentApi } from "@/lib/development-api";

export function DevelopmentFullMessage({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [next, setNext] = useState<number | null>(0);
  const [sha, setSha] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const read = async (offset: number) => {
    setBusy(true); setError("");
    try {
      const result = await developmentApi.message(sessionId, messageId, offset, offset ? sha : undefined);
      setText(result.content); setNext(result.nextOffset); setSha(result.sha256);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败"); }
    finally { setBusy(false); }
  };
  return <>
    <Button variant="ghost" size="sm" className="h-7 text-caption" onClick={() => { setOpen(true); void read(0); }}>读取完整记录</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="flex max-h-[85vh] max-w-3xl flex-col">
      <DialogHeader><DialogTitle>原始执行记录</DialogTitle><DialogDescription>按段读取同一条消息；内容更新后需要从头重新读取。</DialogDescription></DialogHeader>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-caption">{text}</pre>
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void read(0)}>从头读取</Button>
        {next != null && <Button size="sm" disabled={busy} onClick={() => void read(next)}>读取下一段</Button>}</div>
    </DialogContent></Dialog>
  </>;
}