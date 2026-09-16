import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MusicScorePreview } from "./MusicScorePreview";

const SCORE = "X:1\nT:Preview\nM:4/4\nL:1/8\nK:C\nCDEF GABc|";
const CURRENT_TWO_STAFF_SCORE = `X:1
T:Autumn Memories
C:Mona Musician
M:3/4
L:1/8
Q:1/4=72
K:F
%%staves {RH LH}
V:RH clef=treble name="右手"
V:LH clef=bass name="左手"
V:RH
"F" !mp! a4 c'2 |
V:LH
"F" F,2 A,2 C2 |]
`;

describe("MusicScorePreview", () => {
  it("renders notation from a valid ABC source", async () => {
    const { container } = render(<MusicScorePreview source={SCORE} filename="preview.abc" />);

    await waitFor(() => expect(container.querySelector("svg")).toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "设置播放速度" })).toHaveTextContent("180 BPM");
    expect(screen.queryByLabelText("播放位置")).not.toBeInTheDocument();
    expect(screen.getByLabelText("导出 MIDI")).toBeInTheDocument();
    expect(screen.getByTestId("music-score-scroller")).toHaveClass("scrollbar-hover", "overflow-y-auto");
  });

  it("shows the score tempo and lets the user adjust it", async () => {
    render(<MusicScorePreview source={CURRENT_TWO_STAFF_SCORE} filename="autumn.abc" />);

    const trigger = await screen.findByRole("button", { name: "设置播放速度" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    const tempo = await screen.findByLabelText("播放速度");
    expect(screen.getAllByText("72 BPM").length).toBeGreaterThan(0);
    fireEvent.change(tempo, { target: { value: "96" } });
    expect(screen.getAllByText("96 BPM").length).toBeGreaterThan(0);
  });

  it("renders notes for the two-staff format produced by the musician", async () => {
    const { container } = render(<MusicScorePreview source={CURRENT_TWO_STAFF_SCORE} filename="autumn.abc" />);

    await waitFor(() => expect(container.querySelector(".abcjs-note")).toBeInTheDocument());
  });

  it("explains when a blank line terminated the score before its notes", async () => {
    const broken = "X:1\nT:Broken\nM:4/4\nL:1/8\nK:C\n\nCDEF GABc|";
    const { container } = render(<MusicScorePreview source={broken} filename="broken.abc" />);

    await waitFor(() => expect(container.querySelector("[role='alert']")).toHaveTextContent("未解析到谱表正文"));
    expect(container.querySelector(".abcjs-note")).not.toBeInTheDocument();
  });
});
