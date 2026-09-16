import { useEffect, useRef, useState } from "react";
import { ChevronDown, Code2, Download, Guitar, Pause, Play, RotateCcw } from "lucide-react";
import * as alphaTab from "@coderline/alphatab";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const FONT_DIRECTORY = `${import.meta.env.BASE_URL}alphatab/font/`;
const SOUNDFONT_URL = `${import.meta.env.BASE_URL}alphatab/soundfont/sonivox.sf3`;
const MIN_BPM = 40;
const MAX_BPM = 220;
const POSITION_UPDATE_INTERVAL_MS = 100;
type AlphaTabSettingsJson = Exclude<
  ConstructorParameters<typeof alphaTab.AlphaTabApi>[1],
  alphaTab.Settings
>;

function formatTime(milliseconds: number): string {
  const seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds / 1000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const GUITAR_TAB_SETTINGS: AlphaTabSettingsJson = {
  core: {
    engine: "svg",
    enableLazyLoading: false,
    fontDirectory: FONT_DIRECTORY,
    useWorkers: false,
  },
  display: {
    layoutMode: alphaTab.LayoutMode.Page,
    scale: 0.9,
    stretchForce: 0.85,
    staveProfile: alphaTab.StaveProfile.Tab,
  },
  notation: {
    rhythmMode: alphaTab.TabRhythmMode.ShowWithBars,
  },
  player: {
    playerMode: alphaTab.PlayerMode.Disabled,
    soundFont: null,
    enableCursor: true,
    enableAnimatedBeatCursor: false,
    enableElementHighlighting: true,
  },
};

/** Dedicated AlphaTex tablature preview. It does not parse or render ABC. */
export function GuitarTabPreview({ source }: { source: string; filename: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<alphaTab.AlphaTabApi | null>(null);
  const baseTempoRef = useRef(120);
  const endTimeRef = useRef(0);
  const hasPlaybackStartedRef = useRef(false);
  const playerInitializedRef = useRef(false);
  const playWhenReadyRef = useRef(false);
  const pendingPositionRef = useRef<{ currentTime: number; endTime: number } | null>(null);
  const positionUpdateTimerRef = useRef<number | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [isPreparingPlayer, setIsPreparingPlayer] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [bpm, setBpm] = useState(120);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hasPlaybackStarted, setHasPlaybackStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    setRendered(false);
    setPlayerReady(false);
    setIsPreparingPlayer(false);
    setIsPlaying(false);
    setIsPaused(false);
    setPosition(0);
    setDuration(0);
    setHasPlaybackStarted(false);
    hasPlaybackStartedRef.current = false;
    playerInitializedRef.current = false;
    playWhenReadyRef.current = false;
    pendingPositionRef.current = null;
    if (positionUpdateTimerRef.current !== null) {
      window.clearTimeout(positionUpdateTimerRef.current);
      positionUpdateTimerRef.current = null;
    }
    setError(null);
    const api = new alphaTab.AlphaTabApi(hostRef.current, {
      ...GUITAR_TAB_SETTINGS,
      player: {
        ...GUITAR_TAB_SETTINGS.player,
        scrollElement: scrollerRef.current!,
      },
    });
    apiRef.current = api;
    const flushPosition = () => {
      if (positionUpdateTimerRef.current !== null) {
        window.clearTimeout(positionUpdateTimerRef.current);
        positionUpdateTimerRef.current = null;
      }
      const next = pendingPositionRef.current;
      pendingPositionRef.current = null;
      if (!next) return;
      setPosition(next.currentTime);
      setDuration(next.endTime);
    };
    api.renderFinished.on(() => {
      const tempo = Math.max(1, Math.round(api.score?.tempo ?? 120));
      const boundedTempo = Math.max(MIN_BPM, Math.min(MAX_BPM, tempo));
      baseTempoRef.current = tempo;
      api.playbackSpeed = boundedTempo / tempo;
      setBpm(boundedTempo);
      setRendered(true);
    });
    api.playerReady.on(() => {
      setPlayerReady(true);
      setIsPreparingPlayer(false);
      if (playWhenReadyRef.current) {
        playWhenReadyRef.current = false;
        hasPlaybackStartedRef.current = true;
        setHasPlaybackStarted(true);
        api.play();
      }
    });
    api.playerPositionChanged.on((event) => {
      endTimeRef.current = event.endTime;
      pendingPositionRef.current = {
        currentTime: event.currentTime,
        endTime: event.endTime,
      };
      if (positionUpdateTimerRef.current === null) {
        positionUpdateTimerRef.current = window.setTimeout(
          flushPosition,
          POSITION_UPDATE_INTERVAL_MS,
        );
      }
    });
    api.playerStateChanged.on((event) => {
      const playing = event.state === alphaTab.synth.PlayerState.Playing;
      setIsPlaying(playing);
      if (playing) {
        hasPlaybackStartedRef.current = true;
        setHasPlaybackStarted(true);
      } else {
        flushPosition();
      }
      setIsPaused(!playing && !event.stopped && hasPlaybackStartedRef.current);
      if (event.stopped) {
        hasPlaybackStartedRef.current = false;
        setPosition(0);
      }
    });
    api.playerFinished.on(() => {
      pendingPositionRef.current = null;
      if (positionUpdateTimerRef.current !== null) {
        window.clearTimeout(positionUpdateTimerRef.current);
        positionUpdateTimerRef.current = null;
      }
      setIsPlaying(false);
      setIsPaused(false);
      setPosition(endTimeRef.current);
    });
    api.error.on((cause) => {
      pendingPositionRef.current = null;
      if (positionUpdateTimerRef.current !== null) {
        window.clearTimeout(positionUpdateTimerRef.current);
        positionUpdateTimerRef.current = null;
      }
      setPlayerReady(false);
      setIsPreparingPlayer(false);
      playWhenReadyRef.current = false;
      setIsPlaying(false);
      setError(`六线谱无法渲染或播放：${cause.message}`);
    });
    try {
      api.tex(source);
    } catch (cause) {
      setError(
        cause instanceof Error ? `六线谱无法渲染：${cause.message}` : "六线谱无法渲染。",
      );
    }
    return () => {
      pendingPositionRef.current = null;
      if (positionUpdateTimerRef.current !== null) {
        window.clearTimeout(positionUpdateTimerRef.current);
        positionUpdateTimerRef.current = null;
      }
      playWhenReadyRef.current = false;
      if (playerInitializedRef.current) {
        api.stop();
        api.resetSoundFonts();
        api.settings.player.soundFont = null;
        api.settings.player.playerMode = alphaTab.PlayerMode.Disabled;
        api.updateSettings();
        playerInitializedRef.current = false;
      }
      apiRef.current = null;
      api.destroy();
    };
  }, [source]);

  const prepareAndPlay = () => {
    const api = apiRef.current;
    if (!rendered || !api || isPreparingPlayer) return;
    if (playerReady) {
      hasPlaybackStartedRef.current = true;
      setHasPlaybackStarted(true);
      api.playPause();
      return;
    }
    setError(null);
    setIsPreparingPlayer(true);
    playWhenReadyRef.current = true;
    playerInitializedRef.current = true;
    api.settings.player.soundFont = SOUNDFONT_URL;
    api.settings.player.playerMode = alphaTab.PlayerMode.EnabledSynthesizer;
    api.updateSettings();
  };

  const releasePlayer = () => {
    const api = apiRef.current;
    if (!api || !playerInitializedRef.current) return;
    playWhenReadyRef.current = false;
    api.stop();
    api.resetSoundFonts();
    api.settings.player.soundFont = null;
    api.settings.player.playerMode = alphaTab.PlayerMode.Disabled;
    api.updateSettings();
    playerInitializedRef.current = false;
    setPlayerReady(false);
    setIsPreparingPlayer(false);
    setIsPlaying(false);
    setIsPaused(false);
  };

  const changeBpm = (nextBpm: number) => {
    const bounded = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(nextBpm)));
    setBpm(bounded);
    if (apiRef.current) apiRef.current.playbackSpeed = bounded / baseTempoRef.current;
  };

  const playOrPause = () => {
    prepareAndPlay();
  };

  const restart = () => {
    if (!playerReady || !apiRef.current) {
      prepareAndPlay();
      return;
    }
    setError(null);
    hasPlaybackStartedRef.current = true;
    setHasPlaybackStarted(true);
    apiRef.current.stop();
    apiRef.current.play();
  };

  const seekPlayback = (progress: number) => {
    if (!playerReady || !apiRef.current || endTimeRef.current <= 0) return;
    if (positionUpdateTimerRef.current !== null) {
      window.clearTimeout(positionUpdateTimerRef.current);
      positionUpdateTimerRef.current = null;
    }
    pendingPositionRef.current = null;
    const nextPosition = Math.max(0, Math.min(1, progress)) * endTimeRef.current;
    setPosition(nextPosition);
    apiRef.current.timePosition = nextPosition;
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-editor-surface" data-testid="guitar-tab-preview">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <Button type="button" variant={showSource ? "ghost" : "secondary"} size="sm" onClick={() => setShowSource(false)}>
          <Guitar className="mr-1 h-3.5 w-3.5" />六线谱
        </Button>
        <Button type="button" variant={showSource ? "secondary" : "ghost"} size="sm" onClick={() => { releasePlayer(); setShowSource(true); }}>
          <Code2 className="mr-1 h-3.5 w-3.5" />代码
        </Button>
        <div className="flex-1" />
        {!showSource ? <>
          {rendered ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="gap-1 px-2 tabular-nums" aria-label="设置播放速度">
                  {bpm} BPM
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64 p-3">
                <div className="flex items-center justify-between text-caption">
                  <span className="font-medium text-foreground">播放速度</span>
                  <span className="tabular-nums text-muted-foreground">{bpm} BPM</span>
                </div>
                <input type="range" min={MIN_BPM} max={MAX_BPM} step={1} value={bpm} onChange={(event) => changeBpm(Number(event.target.value))} className="mt-3 w-full accent-primary" aria-label="播放速度" />
                <div className="mt-1 flex justify-between text-micro tabular-nums text-muted-foreground">
                  <span>{MIN_BPM}</span>
                  <span>{MAX_BPM}</span>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button type="button" variant="ghost" size="icon" disabled={!rendered || isPreparingPlayer} onClick={playOrPause} title={isPreparingPlayer ? "正在准备吉他试听" : isPlaying ? "暂停吉他试听" : isPaused ? "继续吉他试听" : "播放吉他试听"} aria-label={isPreparingPlayer ? "正在准备吉他试听" : isPlaying ? "暂停吉他试听" : isPaused ? "继续吉他试听" : "播放吉他试听"}>
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <Button type="button" variant="ghost" size="icon" disabled={!rendered || isPreparingPlayer} onClick={restart} title="从头播放" aria-label="从头播放">
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" disabled={!rendered} onClick={() => apiRef.current?.downloadMidi()} title="导出 MIDI" aria-label="导出 MIDI">
            <Download className="h-4 w-4" />
          </Button>
        </> : null}
      </div>
      {!showSource && rendered && hasPlaybackStarted ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-micro tabular-nums text-muted-foreground">{formatTime(position)}</span>
            <input type="range" min={0} max={1000} step={1} value={duration > 0 ? Math.round((position / duration) * 1000) : 0} disabled={!playerReady || duration <= 0} onChange={(event) => seekPlayback(Number(event.target.value) / 1000)} className="h-1 min-w-0 flex-1 accent-primary disabled:opacity-45" aria-label="播放位置" />
            <span className="w-12 shrink-0 text-right text-micro tabular-nums text-muted-foreground">{formatTime(duration)}</span>
          </div>
        </div>
      ) : null}
      {error ? <div role="alert" className="shrink-0 border-b border-destructive/25 bg-destructive/5 px-3 py-2 whitespace-pre-wrap text-caption text-destructive">{error}</div> : null}
      {showSource ? (
        <pre className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-caption text-foreground">{source}</pre>
      ) : null}
      <div ref={scrollerRef} className={`${showSource ? "hidden" : "scrollbar-hover relative min-h-0 flex-1 overflow-auto bg-white text-black"}`}>
        {!rendered && !error ? <div className="absolute inset-x-0 top-0 h-28 animate-pulse bg-muted/30" data-testid="guitar-tab-loading" /> : null}
        <div ref={hostRef} className="min-h-full min-w-[320px] bg-white" />
      </div>
    </div>
  );
}
