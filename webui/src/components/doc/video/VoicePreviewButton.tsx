import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Square, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError, fetchVoicePreviewBytes } from "@/lib/api";
import { useClient } from "@/providers/ClientProvider";
import type { TtsProvider } from "./video-tts-options";

export function VoicePreviewButton({provider, voice, rate, disabled = false}: {
  provider: TtsProvider; voice: string; rate: string; disabled?: boolean;
}) {
  const {token} = useClient();
  const [state, setState] = useState<"idle" | "preparing" | "playing">("idle");
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const generation = useRef(0);

  const release = useCallback(() => {
    generation.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  useEffect(() => {
    release();
    setState("idle");
    setError(null);
    return release;
  }, [provider, voice, rate, token, release]);

  const preview = async () => {
    if (state === "playing") {release(); setState("idle"); return;}
    if (state === "preparing") return;
    release();
    const id = generation.current;
    const request = new AbortController();
    requestRef.current = request;
    setState("preparing");
    try {
      const blob = await fetchVoicePreviewBytes(token, {ttsProvider: provider, ttsVoice: voice, ttsRate: rate}, request.signal);
      if (id !== generation.current) return;
      urlRef.current = URL.createObjectURL(blob);
      const audio = new Audio(urlRef.current);
      audioRef.current = audio;
      audio.onended = () => {if (id === generation.current) {release(); setState("idle");}};
      audio.onerror = () => {if (id === generation.current) {release(); setState("idle"); setError("试音未能播放，请重试。");}};
      await audio.play();
      if (id === generation.current) setState("playing");
    } catch (cause) {
      if (id !== generation.current) return;
      release();
      setState("idle");
      setError(cause instanceof ApiError && cause.code?.startsWith("TTS_") ? cause.message : "试音未能播放，请重试。");
    }
  };

  return <>
    <Button type="button" variant="outline" size="sm" aria-busy={state === "preparing"} aria-label={state === "preparing" ? "正在准备试音" : state === "playing" ? "停止试音" : "试音"} disabled={disabled || state === "preparing"} onClick={() => void preview()}>
      {state === "preparing" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : state === "playing" ? <Square className="mr-1.5 h-3.5 w-3.5" /> : <Volume2 className="mr-1.5 h-3.5 w-3.5" />}
      {state === "playing" ? "停止" : "试音"}
    </Button>
    <Dialog open={error !== null} onOpenChange={(open) => {if (!open) setError(null);}}>
      <DialogContent><DialogHeader><DialogTitle>试音未能播放</DialogTitle><DialogDescription>{error}</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" size="sm" onClick={() => setError(null)}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
