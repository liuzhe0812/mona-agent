const WINDOW_MS = 5_000;
const MIN_SPAN_MS = 2_000;
const MIN_TOKENS = 5;
const BUCKET_MS = 100;

interface TokenSample {
  bucket: number;
  time: number;
  tokens: number;
}

/** Estimates output speed for display from the current model stream only. */
export class LiveTokenSampler {
  private samples: TokenSample[] = [];

  push(text: string, nowMs: number): void {
    if (!text || !Number.isFinite(nowMs)) return;

    let tokens = 0;
    // ASCII letters and digits average four characters per token; count each
    // other non-whitespace Unicode code point as one display-only token unit.
    for (const match of text.matchAll(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu)) {
      tokens += /^[A-Za-z0-9_]/.test(match[0]) ? match[0].length / 4 : 1;
    }
    if (tokens === 0) return;

    const last = this.samples[this.samples.length - 1];
    if (last && (nowMs < last.time || nowMs - last.time > WINDOW_MS)) this.reset();
    this.prune(nowMs);

    const bucket = Math.floor(nowMs / BUCKET_MS);
    const current = this.samples[this.samples.length - 1];
    if (current?.bucket === bucket) {
      current.time = nowMs;
      current.tokens += tokens;
    } else {
      this.samples.push({ bucket, time: nowMs, tokens });
    }
  }

  rate(nowMs: number): number | undefined {
    if (!Number.isFinite(nowMs)) return undefined;
    const last = this.samples[this.samples.length - 1];
    if (!last || nowMs < last.time || nowMs - last.time > WINDOW_MS) return undefined;

    this.prune(nowMs);
    const first = this.samples[0];
    if (!first) return undefined;
    const span = last.time - first.time;
    if (span < MIN_SPAN_MS) return undefined;

    // The first point is the interval's boundary, so its tokens have no
    // observed generation time and must not be included in the rate.
    const tokens = this.samples.slice(1).reduce((total, sample) => total + sample.tokens, 0);
    return tokens >= MIN_TOKENS ? tokens * 1_000 / span : undefined;
  }

  reset(): void {
    this.samples = [];
  }

  private prune(nowMs: number): void {
    const earliest = nowMs - WINDOW_MS;
    this.samples = this.samples.filter((sample) => sample.time >= earliest);
  }
}
