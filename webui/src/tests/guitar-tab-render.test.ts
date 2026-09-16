import { describe, expect, it } from "vitest";
import { importer } from "@coderline/alphatab";
import { readFileSync } from "node:fs";

const syntax = readFileSync(
  "../expert-library/agents/com.mona.musician/skills/guitar-tab/references/tab-syntax.md",
  "utf8",
);
const SKILL_EXAMPLE = syntax.match(/```text\r?\n([\s\S]*?)```/)?.[1] ?? "";

describe("dedicated guitar tablature format", () => {
  const completeExamples = readFileSync(
    "../expert-library/agents/com.mona.musician/skills/guitar-tab/references/complete-examples.md", "utf8",
  );
  const completeScores = [...completeExamples.matchAll(/```text\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
  it.each(completeScores)("loads complete arrangement %# with valid durations and connected ties", (source) => {
    const score = importer.ScoreLoader.loadAlphaTex(source);
    expect(score.masterBars).toHaveLength(16);
    expect(score.masterBars.filter((bar) => bar.section)).toHaveLength(source.match(/\\section/g)!.length);
    const staff = score.tracks[0].staves[0];
    for (const bar of staff.bars) {
      const beats = bar.voices[0].beats;
      expect(beats.reduce((sum, beat) => sum + beat.playbackDuration, 0)).toBe(3840);
      for (const note of beats.flatMap((beat) => beat.notes)) {
        if (note.isTieDestination) {
          expect(note.tieOrigin).toBeTruthy();
          expect(note.realValue).toBe(note.tieOrigin!.realValue);
        }
      }
    }
  });
  it("keeps melody tied while another string attacks, with native dynamics and accent", () => {
    const score = importer.ScoreLoader.loadAlphaTex(String.raw`\track "Guitar" \staff {tabs}
      . \ts (4 4) (0.1{ac} 3.5).4 {dy mf} (0.1{t} 2.4).4 3.2.4 1.2.4 |`);
    const beats = score.tracks[0].staves[0].bars[0].voices[0].beats;
    const melodyStart = beats[0].notes.find((note) => note.realValue === 64)!;
    const melodyHold = beats[1].notes.find((note) => note.realValue === 64)!;
    expect(melodyHold.isTieDestination).toBe(true);
    expect(melodyHold.tieOrigin).toBe(melodyStart);
    expect(melodyHold.realValue).toBe(melodyStart.realValue);
    expect(beats[1].notes.find((note) => note.realValue === 52)?.isTieDestination).toBe(false);
    expect(melodyStart.accentuated).not.toBe(0);
    expect(beats[0].dynamics).toBe(4);
  });
  const examples = readFileSync(
    "../expert-library/agents/com.mona.musician/skills/guitar-tab/references/examples.md", "utf8",
  );
  const scores = [...examples.matchAll(/```text\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
  it.each(scores)("parses the published practice example %# with complete bars", (source) => {
    const score = importer.ScoreLoader.loadAlphaTex(source);
    expect(score.masterBars).toHaveLength(2);
    const staff = score.tracks[0].staves[0];
    expect(staff.tuning).toHaveLength(6);
    for (const bar of staff.bars) {
      expect(bar.voices[0].beats.reduce((sum, beat) => sum + beat.playbackDuration, 0)).toBe(3840);
    }
  });
  it("preserves hammer/pull-off and bend semantics in the examples", () => {
    const score = importer.ScoreLoader.loadAlphaTex(scores[3]);
    const bars = score.tracks[0].staves[0].bars;
    expect(bars[0].voices[0].beats[2].notes[0].isHammerPullOrigin).toBe(true);
    const bend = bars[1].voices[0].beats[0].notes[0].bendPoints!.map((point) => point.value);
    expect(bend[0]).toBe(0);
    expect(Math.max(...bend)).toBe(4);
    expect(bend[bend.length - 1]).toBe(0);
  });
  it("loads the skill example as a six-string two-bar AlphaTex score", () => {
    const score = importer.ScoreLoader.loadAlphaTex(SKILL_EXAMPLE);
    const staff = score.tracks[0]?.staves[0];

    expect(score.title).toBe("作品标题");
    expect(score.tempo).toBe(90);
    expect(score.masterBars).toHaveLength(2);
    expect(staff?.tuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(staff?.showTablature).toBe(true);
    expect(staff?.showStandardNotation).toBe(false);
  });
});
