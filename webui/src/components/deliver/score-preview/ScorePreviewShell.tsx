import { ChevronDown, Code2, Download, Music2, Pause, Play, RotateCcw } from "lucide-react";

import {
  MAX_BPM,
  MIN_BPM,
  formatTime,
  type AbcScorePreviewState,
} from "@/components/deliver/score-preview/useAbcScorePreview";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ScorePreviewShellProps {
  state: AbcScorePreviewState;
  source: string;
  /** Wrapper test id, unique per pipeline so tests can tell them apart. */
  testId: string;
  /** Class for the scrolling pane, which differs per pipeline. */
  scrollerClassName: string;
}

/**
 * Toolbar, progress bar, source view and playback cursor shared by both score
 * pipelines. The engraved score itself is whatever the pipeline wrote into the
 * paper container, so neither pipeline needs to know about the other's DOM.
 */
export function ScorePreviewShell({ state, source, testId, scrollerClassName }: ScorePreviewShellProps) {
  const {
    refs,
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
  } = state;

  return (
    <div className="flex h-full min-h-0 flex-col bg-editor-surface" data-testid={testId}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <Button type="button" variant={showSource ? "ghost" : "secondary"} size="sm" onClick={() => setShowSource(false)}>
          <Music2 className="mr-1 h-3.5 w-3.5" />乐谱
        </Button>
        <Button type="button" variant={showSource ? "secondary" : "ghost"} size="sm" onClick={() => { stopPlayback(); setShowSource(true); }}>
          <Code2 className="mr-1 h-3.5 w-3.5" />代码
        </Button>
        <div className="flex-1" />
        {!showSource ? <>
          {tune ? (
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
                <input
                  type="range"
                  min={MIN_BPM}
                  max={MAX_BPM}
                  step={1}
                  value={bpm}
                  onChange={(event) => changeBpm(Number(event.target.value))}
                  className="mt-3 w-full accent-primary"
                  aria-label="播放速度"
                />
                <div className="mt-1 flex justify-between text-micro tabular-nums text-muted-foreground">
                  <span>{MIN_BPM}</span>
                  <span>{MAX_BPM}</span>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button type="button" variant="ghost" size="icon" disabled={!tune || isPreparing} onClick={() => void playOrPause()} title={isPlaying ? "暂停钢琴试听" : isPaused ? "继续钢琴试听" : "播放钢琴试听"} aria-label={isPlaying ? "暂停钢琴试听" : isPaused ? "继续钢琴试听" : "播放钢琴试听"}>
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <Button type="button" variant="ghost" size="icon" disabled={!tune || isPreparing} onClick={restart} title="从头播放" aria-label="从头播放">
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" disabled={!tune} onClick={() => void exportMidi()} title="导出 MIDI" aria-label="导出 MIDI">
            <Download className="h-4 w-4" />
          </Button>
        </> : null}
      </div>
      {!showSource && tune && hasPlaybackStarted ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-micro tabular-nums text-muted-foreground">
              {formatTime(progress * durationSeconds)}
            </span>
            <input
              type="range"
              min={0}
              max={1000}
              step={1}
              value={Math.round(progress * 1000)}
              disabled={!refs.synthRef.current || durationSeconds <= 0}
              onChange={(event) => seekPlayback(Number(event.target.value) / 1000)}
              className="h-1 min-w-0 flex-1 accent-primary disabled:opacity-45"
              aria-label="播放位置"
            />
            <span className="w-12 shrink-0 text-right text-micro tabular-nums text-muted-foreground">
              {formatTime(durationSeconds)}
            </span>
          </div>
        </div>
      ) : null}
      {error ? <div role="alert" className="shrink-0 border-b border-destructive/25 bg-destructive/5 px-3 py-2 whitespace-pre-wrap text-caption text-destructive">{error}</div> : null}
      {showSource ? (
        <pre className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-caption text-foreground">{source}</pre>
      ) : (
        <div ref={refs.scoreRef} data-testid="music-score-scroller" className={scrollerClassName}>
          <div ref={refs.paperRef} />
          <div
            ref={refs.cursorRef}
            aria-hidden
            className="pointer-events-none absolute z-10 hidden w-0 border-l-2 border-[hsl(var(--brand-red))] transition-[left,top,height] duration-100 ease-linear"
          >
            <div ref={refs.cursorTrailRef} className="music-score-cursor-trail absolute right-0 top-0 h-full w-7" />
          </div>
        </div>
      )}
    </div>
  );
}
