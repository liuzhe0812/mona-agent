import { afterEach, describe, expect, it, vi } from "vitest";
import { createMotionToolkit } from "../../huashu-runtime";

class Path2DStub {
  rect() {}
}

describe("createMotionToolkit", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the upstream namespace, stage, caches, and voice envelope per instance", () => {
    vi.stubGlobal("Path2D", Path2DStub);
    const host = window as unknown as Record<string, unknown>;
    const hostNames = ["U", "PAINT", "CAM", "TOON"].map((name) => host[name]);
    const firstImage = {} as CanvasImageSource;
    const secondImage = {} as CanvasImageSource;

    const first = createMotionToolkit(1920, 1080, {
      images: { hero: firstImage },
      voiceEnvelope: { fps: 60, a: [0.2, 0.8] },
    });
    const second = createMotionToolkit(1080, 1920, {
      images: { hero: secondImage },
      voiceEnvelope: { fps: 30, a: [0.9] },
    });

    expect(first.CAM.toScreen({ x: 0, y: 0 }, 0, 0)).toEqual([960, 540]);
    expect(second.CAM.toScreen({ x: 0, y: 0 }, 0, 0)).toEqual([540, 960]);
    first.U.setStage(640, 480);
    expect(first.CAM.toScreen({ x: 0, y: 0 }, 0, 0)).toEqual([320, 240]);
    expect(second.CAM.toScreen({ x: 0, y: 0 }, 0, 0)).toEqual([540, 960]);

    expect(first.U.rng(42)()).toBe(first.U.rng(42)());
    expect(first.PAINT).not.toBe(second.PAINT);
    expect(first.IMG.hero).toBe(firstImage);
    expect(first.images).toBe(first.IMG);
    expect(second.IMG.hero).toBe(secondImage);
    expect(first.TOON.env(1 / 60)).toBe(0.8);
    expect(second.TOON.env(0)).toBe(0.9);
    expect(Object.keys(first.TOON.LOOKS)).toEqual(["neutral", "bun"]);
    expect(() => first.TOON.look("author")).toThrow();
    expect(first.TOON.look({ base: "neutral", shirt: "#000000" }).shirt).toBe("#000000");
    const board = first.DG.board();
    expect(board.penAt(0.5, { x: 0, y: 0, z: 1 }, [12, 8])).toEqual([332, 248]);
    expect(["U", "PAINT", "CAM", "TOON"].map((name) => host[name])).toEqual(hostNames);
  });
});
