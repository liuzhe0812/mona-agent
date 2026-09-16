import { useCallback } from "react";
import * as abcjs from "abcjs";

import {
  useAbcScorePreview,
  type ScoreRenderContext,
  type Tune,
} from "@/components/deliver/score-preview/useAbcScorePreview";
import { ScorePreviewShell } from "@/components/deliver/score-preview/ScorePreviewShell";

/** The five-line-staff pipeline. It knows nothing about tablature. */
const SCROLLER_CLASS = "scrollbar-hover relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-white p-3 text-black [&_.abcjs-note_selected]:fill-primary [&_.abcjs-note_selected]:stroke-primary";

export function MusicScorePreview({ source, filename }: { source: string; filename: string }) {
  const renderScore = useCallback(
    ({ node, width }: ScoreRenderContext): Tune | null =>
      abcjs.renderAbc(node, source, {
        add_classes: true,
        staffwidth: Math.max(280, width - 24),
        wrap: { minSpacing: 1.2, maxSpacing: 2.5, preferredMeasuresPerLine: width < 460 ? 2 : 4 },
        responsive: "resize",
      })[0] ?? null,
    [source],
  );

  const state = useAbcScorePreview({ source, filename, renderScore });

  return (
    <ScorePreviewShell
      state={state}
      source={source}
      testId="music-score-preview"
      scrollerClassName={SCROLLER_CLASS}
    />
  );
}
