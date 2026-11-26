// Coordinates externally confirmed voice events; it does not capture audio itself.
// Callbacks are synchronous notifications. The adapter handles async errors and
// reports actual completion or failure using the event methods below.
export class VoiceSession {
  constructor({ onWake, onInput, onStopPlayback, onClose = () => {} } = {}) {
    if (![onWake, onInput, onStopPlayback, onClose].every((callback) => typeof callback === "function")) {
      throw new TypeError("Voice session callbacks are required");
    }
    this.callbacks = { onWake, onInput, onStopPlayback, onClose };
    this.awake = false;
    this.closed = false;
    this.turnId = null;
    this.playback = null;
    this.playbackStatus = "idle";
    this.generation = 0;
  }

  get state() {
    const status = this.closed ? "closed" : !this.awake ? "sleeping"
      : this.playbackStatus === "stop_failed" ? "playback_unknown"
        : this.playback ? "playing" : this.turnId ? "executing" : "listening";
    return Object.freeze({ status, turnId: this.turnId, playbackStatus: this.playbackStatus });
  }

  wake() {
    if (this.closed || this.awake) return false;
    this.callbacks.onWake();
    this.awake = true;
    return true;
  }

  // Only a finalized recognition result is eligible for submission. The caller
  // supplies the stable ID and handles uncertain delivery without resending.
  submit({ messageId, text } = {}) {
    if (typeof messageId !== "string" || !messageId.trim() || typeof text !== "string" || !text.trim()) {
      throw new TypeError("A message ID and recognized text are required");
    }
    if (this.closed || !this.awake || this.turnId || this.playback) return false;
    this.turnId = messageId;
    this.callbacks.onInput({ messageId, text });
    return true;
  }

  turnEnded(messageId) {
    if (typeof messageId !== "string" || !messageId.trim()) throw new TypeError("A message ID is required");
    if (this.turnId !== messageId) return false;
    this.turnId = null;
    return true;
  }

  // Called when the real player starts, not when speech synthesis is requested.
  playbackStarted(utteranceId) {
    if (typeof utteranceId !== "string" || !utteranceId.trim()) throw new TypeError("An utterance ID is required");
    if (this.closed || !this.awake || this.playback) return null;
    if (this.generation >= Number.MAX_SAFE_INTEGER) throw new RangeError("Playback generation exhausted");
    const token = Object.freeze({ utteranceId, generation: ++this.generation });
    this.playback = token;
    this.playbackStatus = "playing";
    return token;
  }

  playbackEnded(token, { failed = false } = {}) {
    if (typeof failed !== "boolean") throw new TypeError("Invalid playback result");
    if (!token || typeof token !== "object") throw new TypeError("A playback token is required");
    if (this.playback !== token) return false;
    this.playback = null;
    this.playbackStatus = failed ? "failed" : "ended";
    return true;
  }

  // Call only after the recognizer has confirmed intentional interruption.
  interrupt() {
    if (this.closed || !this.playback) return false;
    const token = this.playback;
    this.playback = null;
    this.playbackStatus = "interrupted";
    try {
      this.callbacks.onStopPlayback(token);
    } catch (error) {
      this.playback = token;
      this.playbackStatus = "stop_failed";
      throw error;
    }
    return true;
  }

  close() {
    if (this.closed) return false;
    const token = this.playback;
    this.closed = true;
    this.playback = null;
    if (token) this.playbackStatus = "interrupted";
    try {
      if (token) this.callbacks.onStopPlayback(token);
    } catch (error) {
      this.playbackStatus = "stop_failed";
      throw error;
    } finally {
      this.callbacks.onClose();
    }
    return true;
  }
}
