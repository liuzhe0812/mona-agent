import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const alphaTabMock = vi.hoisted(() => ({
  construct: vi.fn(),
  destroy: vi.fn(),
  downloadMidi: vi.fn(),
  play: vi.fn(),
  playPause: vi.fn(),
  resetSoundFonts: vi.fn(),
  stop: vi.fn(),
  updateSettings: vi.fn(),
  settings: null as unknown,
  source: "",
  handlers: {} as Record<string, ((event?: any) => void) | undefined>,
  instance: null as any,
}));

vi.mock("@coderline/alphatab", () => ({
  LayoutMode: { Page: 0 },
  PlayerMode: { Disabled: 0, EnabledSynthesizer: 2 },
  StaveProfile: { Tab: 3 },
  TabRhythmMode: { ShowWithBars: 2 },
  synth: { PlayerState: { Paused: 0, Playing: 1 } },
  AlphaTabApi: class {
    score = { tempo: 70 };
    settings: any;
    playbackSpeed = 1;
    timePosition = 0;
    readonly renderFinished = { on: (handler: () => void) => { alphaTabMock.handlers.renderFinished = handler; } };
    readonly playerReady = { on: (handler: () => void) => { alphaTabMock.handlers.playerReady = handler; } };
    readonly playerPositionChanged = { on: (handler: (event: unknown) => void) => { alphaTabMock.handlers.playerPositionChanged = handler; } };
    readonly playerStateChanged = { on: (handler: (event: unknown) => void) => { alphaTabMock.handlers.playerStateChanged = handler; } };
    readonly playerFinished = { on: (handler: () => void) => { alphaTabMock.handlers.playerFinished = handler; } };
    readonly error = { on: (handler: (event: unknown) => void) => { alphaTabMock.handlers.error = handler; } };

    constructor(_element: HTMLElement, settings: unknown) {
      alphaTabMock.construct();
      alphaTabMock.settings = settings;
      this.settings = settings;
      alphaTabMock.instance = this;
    }

    tex(source: string) {
      alphaTabMock.source = source;
      alphaTabMock.handlers.renderFinished?.();
    }

    playPause() { alphaTabMock.playPause(); }
    resetSoundFonts() { alphaTabMock.resetSoundFonts(); }
    stop() { alphaTabMock.stop(); }
    updateSettings() { alphaTabMock.updateSettings(); }
    play() { alphaTabMock.play(); }
    downloadMidi() { alphaTabMock.downloadMidi(); }
    destroy() { alphaTabMock.destroy(); }
  },
}));

import { GuitarTabPreview } from "./GuitarTabPreview";

const TAB = String.raw`\title "卡农"
\tempo 70
\track "Acoustic Guitar"
\staff {tabs}
\tuning (E4 B3 G3 D3 A2 E2)
.
\ts (4 4)
0.1.4 1.2.4 0.3.4 2.4.4 |`;

describe("GuitarTabPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    alphaTabMock.settings = null;
    alphaTabMock.source = "";
    alphaTabMock.handlers = {};
    alphaTabMock.instance = null;
  });

  it("uses a dedicated tab-only renderer with an offline guitar player", async () => {
    render(<GuitarTabPreview source={TAB} filename="canon.atex" />);

    expect(screen.getByTestId("guitar-tab-preview")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("guitar-tab-loading")).not.toBeInTheDocument());
    expect(alphaTabMock.source).toBe(TAB);
    expect(alphaTabMock.settings).toMatchObject({
      core: { engine: "svg", useWorkers: false },
      display: { staveProfile: 3 },
      notation: { rhythmMode: 2 },
      player: {
        playerMode: 0,
        soundFont: null,
        enableCursor: true,
        enableAnimatedBeatCursor: false,
        enableElementHighlighting: true,
      },
    });
    expect(screen.getByRole("button", { name: "播放吉他试听" })).toBeEnabled();
  });

  it("controls playback, speed, seeking, restart, and MIDI export", async () => {
    render(<GuitarTabPreview source={TAB} filename="canon.atex" />);
    fireEvent.click(screen.getByRole("button", { name: "播放吉他试听" }));
    expect(alphaTabMock.updateSettings).toHaveBeenCalledTimes(1);
    expect(alphaTabMock.instance.settings.player).toMatchObject({
      playerMode: 2,
      soundFont: "/alphatab/soundfont/sonivox.sf3",
    });
    expect(screen.getByRole("button", { name: "正在准备吉他试听" })).toBeDisabled();

    act(() => {
      alphaTabMock.handlers.playerReady?.();
      alphaTabMock.handlers.playerPositionChanged?.({ currentTime: 0, endTime: 60_000 });
    });
    expect(alphaTabMock.play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("slider", { name: "播放位置" })).toBeInTheDocument();

    act(() => alphaTabMock.handlers.playerStateChanged?.({ state: 1, stopped: false }));
    expect(screen.getByRole("button", { name: "暂停吉他试听" })).toBeInTheDocument();
    act(() => alphaTabMock.handlers.playerPositionChanged?.({ currentTime: 30_000, endTime: 60_000 }));
    await waitFor(() => expect(screen.getByText("0:30")).toBeInTheDocument());

    fireEvent.change(screen.getByRole("slider", { name: "播放位置" }), { target: { value: "750" } });
    expect(alphaTabMock.instance.timePosition).toBe(45_000);
    fireEvent.click(screen.getByRole("button", { name: "从头播放" }));
    expect(alphaTabMock.stop).toHaveBeenCalledTimes(1);
    expect(alphaTabMock.play).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "导出 MIDI" }));
    expect(alphaTabMock.downloadMidi).toHaveBeenCalledTimes(1);

    const speedTrigger = screen.getByRole("button", { name: "设置播放速度" });
    fireEvent.pointerDown(speedTrigger, { button: 0, ctrlKey: false });
    fireEvent.click(speedTrigger);
    fireEvent.change(await screen.findByRole("slider", { name: "播放速度" }), { target: { value: "105" } });
    expect(alphaTabMock.instance.playbackSpeed).toBe(1.5);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "代码" }));
    expect(alphaTabMock.resetSoundFonts).toHaveBeenCalledTimes(1);
    expect(alphaTabMock.instance.settings.player).toMatchObject({
      playerMode: 0,
      soundFont: null,
    });
  });

  it("coalesces the high-frequency player position stream", () => {
    vi.useFakeTimers();
    try {
      render(<GuitarTabPreview source={TAB} filename="canon.atex" />);
      fireEvent.click(screen.getByRole("button", { name: "播放吉他试听" }));
      act(() => alphaTabMock.handlers.playerReady?.());

      act(() => {
        for (let second = 1; second <= 50; second += 1) {
          alphaTabMock.handlers.playerPositionChanged?.({
            currentTime: second * 1000,
            endTime: 60_000,
          });
        }
      });
      expect(screen.queryByText("0:50")).not.toBeInTheDocument();

      act(() => vi.advanceTimersByTime(100));
      expect(screen.getByText("0:50")).toBeInTheDocument();
      expect(screen.getByText("1:00")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the editable source without invoking the ABC preview", async () => {
    render(<GuitarTabPreview source={TAB} filename="canon.atex" />);

    fireEvent.click(screen.getByRole("button", { name: "代码" }));

    expect(screen.getByText(/\\title "卡农"/)).toBeInTheDocument();
    expect(alphaTabMock.destroy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "六线谱" }));
    expect(alphaTabMock.construct).toHaveBeenCalledTimes(1);
  });
});
