// Projects session events into presentation only; it never dispatches work.
const REPLY_HOLD_MS = 1500;

export class PoseState {
  constructor({ sessionId, onChange = () => {}, schedule = setTimeout, cancel = clearTimeout } = {}) {
    if (typeof sessionId !== "string" || !sessionId.trim() || typeof onChange !== "function"
        || typeof schedule !== "function" || typeof cancel !== "function") {
      throw new TypeError("A session ID and change callback are required");
    }
    this.sessionId = sessionId;
    this.onChange = onChange;
    this.schedule = schedule;
    this.cancel = cancel;
    this.connectionToken = null;
    this.connection = "offline";
    this.mode = null;
    this.pose = "rest";
    this.activeId = null;
    this.replyPresenting = false;
    this.replyHold = null;
    this.replySeenId = null;
    this.listening = null;
    this.playback = null;
    this.settledIds = new Set();
  }

  clearReplyHold() {
    const hold = this.replyHold;
    this.replyHold = null;
    this.replyPresenting = false;
    if (hold) this.cancel(hold.timer);
  }

  holdReply(id, token) {
    if (this.replyHold?.id === id) return;
    this.clearReplyHold();
    const hold = { id, timer: null };
    this.replyHold = hold;
    this.replyPresenting = true;
    hold.timer = this.schedule(() => {
      if (this.replyHold !== hold || this.connectionToken !== token) return;
      this.replyHold = null;
      this.replyPresenting = false;
      this.updatePose();
    }, REPLY_HOLD_MS);
  }

  get state() {
    return Object.freeze({ pose: this.pose, connection: this.connection, mode: this.mode });
  }

  updatePose() {
    this.pose = this.listening || this.playback || this.replyPresenting ? "dialogue"
      : this.activeId ? "work" : "rest";
    this.onChange(this.state);
  }

  listeningStarted(id) { return this.startVoice("listening", id); }
  listeningEnded(token) { return this.endVoice("listening", token); }
  playbackStarted(id) { return this.startVoice("playback", id); }
  playbackEnded(token) { return this.endVoice("playback", token); }

  startVoice(kind, id) {
    if (typeof id !== "string" || !id.trim()) throw new TypeError("A voice event ID is required");
    if (this[kind]) return null;
    const token = Object.freeze({ id });
    this[kind] = token;
    this.updatePose();
    return token;
  }

  endVoice(kind, token) {
    if (!token || token !== this[kind]) return false;
    this[kind] = null;
    this.updatePose();
    return true;
  }

  connected() {
    this.clearReplyHold();
    this.replySeenId = null;
    const token = Object.freeze({});
    this.connectionToken = token;
    this.connection = "syncing";
    this.onChange(this.state);
    return token;
  }

  disconnected(token) {
    if (token !== this.connectionToken || !token) return false;
    this.clearReplyHold();
    this.replySeenId = null;
    this.connectionToken = null;
    this.connection = "offline";
    this.onChange(this.state);
    return true;
  }

  handle(token, message) {
    if (!token || token !== this.connectionToken || !message || message.version !== 1
        || message.session_id !== this.sessionId || !message.payload || typeof message.payload !== "object") {
      return false;
    }
    const payload = message.payload;
    if (message.type === "session.snapshot") {
      if (!["mona", "demo", "unconfigured"].includes(payload.mode)
          || !["thinking", "idle"].includes(payload.state)
          || !(payload.pending_id === null || typeof payload.pending_id === "string")) return false;
      if ((payload.state === "thinking") !== Boolean(payload.pending_id)) return false;
      if (Array.isArray(payload.records)) {
        for (const record of payload.records.slice(-100)) {
          if (["completed", "failed", "unknown", "closed_unknown"].includes(record?.state)
              && typeof record.message_id === "string") this.rememberSettled(record.message_id);
        }
      }
      if (payload.pending_id && this.settledIds.has(payload.pending_id)) return false;
      this.mode = payload.mode;
      if (payload.pending_id && payload.pending_id !== this.replyHold?.id) this.clearReplyHold();
      if (payload.pending_id && payload.pending_id !== this.activeId) this.replySeenId = null;
      this.activeId = payload.pending_id || null;
      this.connection = "ready";
      this.updatePose();
      return true;
    }
    if (this.connection !== "ready" || this.mode === "unconfigured") return false;
    const id = message.message_id;
    if (typeof id !== "string" || !id.trim()) return false;
    if (message.type === "input.accepted" || (message.type === "turn.state" && payload.state === "thinking")) {
      if (this.settledIds.has(id)) return false;
      if (this.activeId && this.activeId !== id) return false;
      if (this.activeId !== id) {
        this.clearReplyHold();
        this.replySeenId = null;
      }
      this.activeId = id;
    } else if (message.type === "reply.completed") {
      if (id !== this.activeId) return false;
      if (this.replySeenId === id) return false;
      this.replySeenId = id;
      this.holdReply(id, token);
    } else if (message.type === "turn.state" && payload.state === "idle") {
      if (id !== this.activeId) return false;
      this.activeId = null;
      this.rememberSettled(id);
    } else {
      return false;
    }
    this.updatePose();
    return true;
  }

  dispose() {
    this.clearReplyHold();
    this.connectionToken = null;
  }

  rememberSettled(id) {
    this.settledIds.add(id);
    if (this.settledIds.size > 100) this.settledIds.delete(this.settledIds.values().next().value);
  }
}
