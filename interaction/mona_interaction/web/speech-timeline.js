const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const silent = () => ({ mouthOpen: 0, mouthForm: 0 });

export class SpeechTimeline {
  constructor() {
    this.current = null;
    this.generation = 0;
  }

  begin({ utteranceId, visemes } = {}) {
    if (typeof utteranceId !== "string" || !utteranceId.trim() || !Array.isArray(visemes)) {
      throw new TypeError("Invalid utterance");
    }
    let previousAt = 0;
    let previousEnd = 0;
    const cues = visemes.map((cue) => {
      const { at, duration, open, form } = cue || {};
      const end = at + duration;
      if (!Number.isFinite(at) || at < 0 || !Number.isFinite(duration) || duration < 0
          || !Number.isFinite(end) || at < previousAt || at + 1e-9 < previousEnd
          || !inRange(open, 0, 1) || !inRange(form, -1, 1)) {
        throw new TypeError("Invalid viseme timing or value");
      }
      previousAt = at;
      previousEnd = end;
      return { at, end, open, form };
    });
    if (this.generation >= Number.MAX_SAFE_INTEGER) throw new RangeError("Playback generation exhausted");
    const token = Object.freeze({ utteranceId, generation: ++this.generation });
    this.current = { token, cues };
    return token;
  }

  sample(token, actualPlaybackSeconds) {
    if (!token || typeof token !== "object") throw new TypeError("Playback token is required");
    if (!Number.isFinite(actualPlaybackSeconds) || actualPlaybackSeconds < 0) {
      throw new TypeError("Invalid playback time");
    }
    if (this.current?.token !== token) return silent();
    const { cues } = this.current;
    let low = 0;
    let high = cues.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (cues[middle].at <= actualPlaybackSeconds) low = middle + 1;
      else high = middle;
    }
    const cue = cues[low - 1];
    return cue && actualPlaybackSeconds < cue.end
      ? { mouthOpen: cue.open, mouthForm: cue.form }
      : silent();
  }

  interrupt(token) {
    if (!token || typeof token !== "object") throw new TypeError("Playback token is required");
    if (this.current?.token !== token) return false;
    this.current = null;
    return true;
  }
}
