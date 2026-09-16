import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MusicScorePreview } from "./MusicScorePreview";

const playback = vi.hoisted(() => ({
  beatCallback: null as ((beat: number, total: number, time: number) => void) | null,
  eventCallback: null as ((event: { left: number; top: number; height: number; elements: Element[][] } | null) => void) | null,
  init: vi.fn().mockResolvedValue({ status: "created" }),
  prime: vi.fn().mockResolvedValue({ status: "running", duration: 60 }),
  start: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  seek: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("abcjs", () => {
  const tune = {
    lines: [{ staff: [{ voices: [[{ el_type: "note" }]] }] }],
    warnings: [],
    getBpm: () => 72,
  };
  return {
    renderAbc: (target: HTMLElement) => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const note = document.createElementNS("http://www.w3.org/2000/svg", "path");
      note.classList.add("abcjs-note");
      svg.appendChild(note);
      target.appendChild(svg);
      return [tune];
    },
    TimingCallbacks: class {
      constructor(_tune: unknown, options: {
        beatCallback?: typeof playback.beatCallback;
        eventCallback?: typeof playback.eventCallback;
      }) {
        playback.beatCallback = options.beatCallback ?? null;
        playback.eventCallback = options.eventCallback ?? null;
      }
      start() {}
      pause() {}
      stop() {}
      setProgress() {}
    },
    synth: {
      CreateSynth: class {
        init = playback.init;
        prime = playback.prime;
        start = playback.start;
        pause = playback.pause;
        resume = playback.resume;
        seek = playback.seek;
        stop = playback.stop;
      },
      getMidiFile: vi.fn(),
    },
  };
});

describe("MusicScorePreview playback controls", () => {
  beforeEach(() => {
    playback.beatCallback = null;
    playback.eventCallback = null;
    vi.clearAllMocks();
  });

  it("updates the position scale from playback timing", async () => {
    render(<MusicScorePreview source="X:1\nT:Test\nM:4/4\nL:1/8\nK:C\nCDEF GABc|" filename="test.abc" />);

    fireEvent.click(await screen.findByLabelText("播放钢琴试听"));
    const position = await screen.findByLabelText("播放位置") as HTMLInputElement;
    await waitFor(() => expect(position).toBeEnabled());

    act(() => playback.beatCallback?.(18, 72, 60_000));

    expect(position.value).toBe("250");
    expect(screen.getByText("0:15")).toBeInTheDocument();
    expect(screen.getByText("1:00")).toBeInTheDocument();
  });

  it("moves a visible cursor line across the rendered score", async () => {
    const { container } = render(<MusicScorePreview source="X:1\nT:Test\nM:4/4\nL:1/8\nK:C\nCDEF GABc|" filename="test.abc" />);

    fireEvent.click(await screen.findByLabelText("播放钢琴试听"));
    await waitFor(() => expect(playback.eventCallback).not.toBeNull());
    const note = container.querySelector(".abcjs-note")!;

    act(() => playback.eventCallback?.({ left: 42, top: 18, height: 36, elements: [[note]] }));

    const cursor = container.querySelector("[aria-hidden][style*='display: block']") as HTMLElement;
    expect(cursor).toBeInTheDocument();
    expect(cursor.style.left).toBe("42px");
    expect(cursor.style.top).toBe("18px");
    expect(cursor.style.height).toBe("36px");
    expect(cursor).toHaveClass("border-l-2", "border-[hsl(var(--brand-red))]");
    const trail = cursor.querySelector(".music-score-cursor-trail")!;
    expect(trail).not.toHaveClass("is-moving");

    act(() => playback.eventCallback?.({ left: 72, top: 18, height: 36, elements: [[note]] }));

    expect(trail).toHaveClass("is-moving");
  });

  it("scrolls the score when the playback cursor leaves the visible area", async () => {
    render(<MusicScorePreview source="X:1\nT:Test\nM:4/4\nL:1/8\nK:C\nCDEF GABc|" filename="test.abc" />);

    fireEvent.click(await screen.findByLabelText("播放钢琴试听"));
    await waitFor(() => expect(playback.eventCallback).not.toBeNull());
    const scroller = screen.getByTestId("music-score-scroller");
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(scroller, "scrollTo", { configurable: true, value: scrollTo });
    const note = scroller.querySelector(".abcjs-note")!;

    act(() => playback.eventCallback?.({ left: 42, top: 900, height: 36, elements: [[note]] }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 810, behavior: "smooth" });
  });
});
