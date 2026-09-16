import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as abcjs from "abcjs";

import { isTauri } from "@/lib/tauri";

export const LOCAL_SOUNDFONT_URL = "/soundfonts/FluidR3_GM";
export const MIN_BPM = 40;
export const MAX_BPM = 220;

export type Tune = ReturnType<typeof abcjs.renderAbc>[number];
type Synth = Pick<
  InstanceType<typeof abcjs.synth.CreateSynth>,
  "init" | "prime" | "start" | "pause" | "resume" | "seek" | "stop"
>;

export function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

export function safeMidiFilename(name: string): string {
  const stem = name.replace(/\.abc$/i, "").trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 64) || "乐谱";
  return `${stem}.mid`;
}

function clearHighlightedNotes(root: HTMLElement | null) {
  root?.querySelectorAll(".abcjs-note_selected").forEach((element) => {
    element.classList.remove("abcjs-note_selected");
  });
}

/** What a pipeline hands back when it engraves a score into the pane. */
export interface ScoreRenderContext {
  /** Empty container to engrave into. */
  node: HTMLElement;
  /** Available width in CSS pixels. */
  width: number;
}

export interface AbcScorePreviewOptions {
  source: string;
  filename: string;
  /**
   * Engrave the score with this pipeline's own abcjs options. Returning a tune
   * (rather than null) enables playback, the tempo picker and MIDI export for it.
   */
  renderScore: (context: ScoreRenderContext) => Tune | null;
  /**
   * Elements to mark while a note sounds. Defaults to the elements abcjs reports,
   * which is right for a notation staff; tablature pipelines map them to the
   * fret numbers they actually draw.
   */
  selectHighlightTargets?: (event: abcjs.NoteTimingEvent, root: HTMLElement | null) => Element[];
}

/**
 * Playback, cursor, progress and MIDI export for an engraved ABC score.
 *
 * Engraving itself is delegated to the caller so the notation pipeline and the
 * tablature pipeline stay independent: they differ in abcjs options and in the
 * DOM they produce, and neither one's changes reach the other through here.
 */
export function useAbcScorePreview({
  source,
  filename,
  renderScore,
  selectHighlightTargets,
}: AbcScorePreviewOptions) {
  const scoreRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const cursorTrailRef = useRef<HTMLDivElement>(null);
  const lastCursorPositionRef = useRef<{ left: number; top: number } | null>(null);
  const synthRef = useRef<Synth | null>(null);
  const timerRef = useRef<abcjs.TimingCallbacks | null>(null);
  const sourceRef = useRef<string | null>(null);
  const [width, setWidth] = useState(0);
  const [tune, setTune] = useState<Tune | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [bpm, setBpm] = useState(120);
  const [progress, setProgress] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [hasPlaybackStarted, setHasPlaybackStarted] = useState(false);

  const stopPlayback = useCallback(() => {
    timerRef.current?.stop();
    timerRef.current = null;
    synthRef.current?.stop();
    synthRef.current = null;
    clearHighlightedNotes(paperRef.current);
    if (cursorRef.current) cursorRef.current.style.display = "none";
    cursorTrailRef.current?.classList.remove("is-moving");
    lastCursorPositionRef.current = null;
    setIsPlaying(false);
    setIsPaused(false);
    setIsPreparing(false);
    setProgress(0);
    setDurationSeconds(0);
    setHasPlaybackStarted(false);
  }, []);

  useLayoutEffect(() => {
    const node = scoreRef.current;
    if (!node) return;
    if (typeof ResizeObserver === "undefined") {
      setWidth(node.clientWidth || 360);
      return;
    }
    setWidth(node.clientWidth || 360);
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.floor(entry.contentRect.width) || node.clientWidth || 360);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = paperRef.current;
    if (!node || width <= 0 || showSource) return;
    stopPlayback();
    node.replaceChildren();
    try {
      const nextTune = renderScore({ node, width });
      const warnings = nextTune?.warnings?.filter(Boolean) ?? [];
      const hasNotes = (nextTune?.lines ?? []).some((line) =>
        line.staff?.some((staff) =>
          staff.voices?.some((voice) => voice.some((element) => element.el_type === "note")),
        ),
      );
      setTune(hasNotes ? nextTune : null);
      if (hasNotes && sourceRef.current !== source) {
        sourceRef.current = source;
        setBpm(Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(nextTune!.getBpm()))));
      }
      setError(
        warnings.length
          ? warnings.join("\n")
          : hasNotes
            ? null
            : "未解析到谱表正文。ABC 文件内部不能包含空行，双声部需要按同长度片段交替书写。",
      );
    } catch (cause) {
      setTune(null);
      setError(cause instanceof Error ? cause.message : "未能解析乐谱。");
    }
  }, [renderScore, showSource, source, stopPlayback, width]);

  useEffect(() => stopPlayback, [stopPlayback]);

  const highlightEvent = useCallback((event: abcjs.NoteTimingEvent | null) => {
    clearHighlightedNotes(paperRef.current);
    const cursor = cursorRef.current;
    const scroller = scoreRef.current;
    if (!event) {
      if (cursor) cursor.style.display = "none";
      cursorTrailRef.current?.classList.remove("is-moving");
      lastCursorPositionRef.current = null;
      return;
    }
    const elements = selectHighlightTargets
      ? selectHighlightTargets(event, paperRef.current)
      : event.elements?.flat() ?? [];
    elements.forEach((element) => element.classList.add("abcjs-note_selected"));
    if (
      !cursor
      || !scroller
      || event.left == null
      || event.top == null
      || event.height == null
    ) return;
    const svg = event.elements?.flat()[0]?.closest("svg");
    const scrollerRect = scroller.getBoundingClientRect();
    const svgRect = svg?.getBoundingClientRect();
    const cursorLeft = event.left + (svgRect ? svgRect.left - scrollerRect.left + scroller.scrollLeft : 0);
    const cursorTop = event.top + (svgRect ? svgRect.top - scrollerRect.top + scroller.scrollTop : 0);
    cursor.style.left = `${cursorLeft}px`;
    cursor.style.top = `${cursorTop}px`;
    cursor.style.height = `${event.height}px`;
    cursor.style.display = "block";
    const lastPosition = lastCursorPositionRef.current;
    if (
      lastPosition
      && (lastPosition.left !== cursorLeft || lastPosition.top !== cursorTop)
      && cursorTrailRef.current
    ) {
      cursorTrailRef.current.classList.remove("is-moving");
      void cursorTrailRef.current.offsetWidth;
      cursorTrailRef.current.classList.add("is-moving");
    }
    lastCursorPositionRef.current = { left: cursorLeft, top: cursorTop };
    const followMargin = Math.min(80, scroller.clientHeight * 0.18);
    const viewportTop = scroller.scrollTop + followMargin;
    const viewportBottom = scroller.scrollTop + scroller.clientHeight - followMargin;
    if (cursorTop < viewportTop || cursorTop + event.height > viewportBottom) {
      const nextTop = Math.max(0, cursorTop - scroller.clientHeight * 0.3);
      if (typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: nextTop, behavior: "smooth" });
      } else {
        scroller.scrollTop = nextTop;
      }
    }
  }, [selectHighlightTargets]);

  const playOrPause = useCallback(async () => {
    if (!tune || isPreparing) return;
    if (synthRef.current && timerRef.current) {
      if (isPlaying) {
        synthRef.current.pause();
        timerRef.current.pause();
        setIsPlaying(false);
        setIsPaused(true);
      } else {
        synthRef.current.resume();
        timerRef.current.start();
        setIsPlaying(true);
        setIsPaused(false);
      }
      return;
    }

    setError(null);
    setIsPreparing(true);
    setHasPlaybackStarted(true);
    try {
      const synth = new abcjs.synth.CreateSynth();
      setProgress(0);
      await synth.init({
        visualObj: tune,
        options: {
          soundFontUrl: LOCAL_SOUNDFONT_URL,
          soundFontVolumeMultiplier: 1,
          qpm: bpm,
        },
      });
      const primed = await synth.prime();
      setDurationSeconds(primed.duration);
      const timer = new abcjs.TimingCallbacks(tune, {
        qpm: bpm,
        beatCallback: (beatNumber, totalBeats, totalTime) => {
          setProgress(clampProgress(totalBeats > 0 ? beatNumber / totalBeats : 0));
          if (totalTime > 0) setDurationSeconds(totalTime / 1000);
        },
        eventCallback: (event): undefined => {
          highlightEvent(event);
          if (!event) {
            synth.stop();
            synthRef.current = null;
            timerRef.current = null;
            setIsPlaying(false);
            setIsPaused(false);
            setProgress(1);
          }
          return undefined;
        },
      });
      synthRef.current = synth;
      timerRef.current = timer;
      synth.start();
      timer.start(0);
      setIsPlaying(true);
    } catch (cause) {
      stopPlayback();
      setError(cause instanceof Error ? `钢琴试听不可用：${cause.message}` : "钢琴试听不可用。");
    } finally {
      setIsPreparing(false);
    }
  }, [bpm, highlightEvent, isPlaying, isPreparing, stopPlayback, tune]);

  const changeBpm = useCallback((nextBpm: number) => {
    stopPlayback();
    setBpm(Math.max(MIN_BPM, Math.min(MAX_BPM, nextBpm)));
  }, [stopPlayback]);

  const seekPlayback = useCallback((nextProgress: number) => {
    const position = clampProgress(nextProgress);
    setProgress(position);
    synthRef.current?.seek(position);
    timerRef.current?.setProgress(position);
  }, []);

  const restart = useCallback(() => {
    stopPlayback();
    void playOrPause();
  }, [playOrPause, stopPlayback]);

  const exportMidi = useCallback(async () => {
    if (!tune) return;
    try {
      const bytes = abcjs.synth.getMidiFile(tune, { midiOutputType: "binary", qpm: bpm }) as Uint8Array;
      const fileName = safeMidiFilename(filename);
      if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        const path = await save({ defaultPath: fileName, filters: [{ name: "MIDI", extensions: ["mid", "midi"] }] });
        if (path) await writeFile(path, bytes);
        return;
      }
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([data], { type: "audio/midi" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? `导出 MIDI 失败：${cause.message}` : "导出 MIDI 失败。");
    }
  }, [bpm, filename, tune]);

  return {
    refs: { scoreRef, paperRef, cursorRef, cursorTrailRef, synthRef },
    tune,
    showSource,
    setShowSource,
    error,
    bpm,
    changeBpm,
    isPlaying,
    isPaused,
    isPreparing,
    progress,
    durationSeconds,
    hasPlaybackStarted,
    playOrPause,
    restart,
    seekPlayback,
    exportMidi,
    stopPlayback,
  };
}

export type AbcScorePreviewState = ReturnType<typeof useAbcScorePreview>;
