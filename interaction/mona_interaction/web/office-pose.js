import { PoseState } from "./pose-state.js";
import { mountOfficeModels } from "./office-models.js";

// The office is an observer: it can request snapshots, never submit input.
export function mountOfficePoses(frame, config, sessionId, onError, onIdleError = () => {}, onModelError = () => {},
  createModels = mountOfficeModels) {
  const images = {};
  let disposed = false;
  let socket = null;
  let retryTimer = null;
  let pollTimer = null;
  let fadeTimer = null;
  let retryDelay = 500;
  let current = null;
  let desired = "rest";
  let connected = false;
  let reconnectPending = false;
  const failed = new Set();
  const names = ["rest", "dialogue", "work"].filter((name) => config[name]);
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const unavailableIdle = new Set(Array.isArray(config.idleUnavailable) ? config.idleUnavailable : []);
  const failedIdle = new Set();
  const idleFailures = new Map();
  const idleIssues = new Set();
  let idle = null;
  let idleRetryTimer = null;
  let idleErrorReported = false;
  let modelErrorReported = false;
  const modelIssues = new Set();
  const models = config.realtime ? createModels(frame, config.realtime, {
    onReady(pose, canvas) {
      if (disposed || current !== pose || fadeTimer !== null || document.hidden || motion.matches) return false;
      // Commit the already-drawn model before removing its animated fallback.
      // Normal pose changes still use the stylesheet's opacity transition.
      canvas.style.transition = "none";
      canvas.style.opacity = "1";
      void canvas.offsetWidth;
      canvas.style.transition = "";
      cancelIdleRetry();
      stopIdle();
      images[pose].element.style.opacity = "0";
      modelIssues.delete(pose);
      if (!modelIssues.size) modelErrorReported = false;
      return true;
    },
    onUnavailable(pose) {
      if (!disposed && current === pose) syncIdle();
    },
    onError(pose) {
      if (disposed || current !== pose) return;
      if (images[pose]?.loaded) images[pose].element.style.opacity = "1";
      syncIdle();
      modelIssues.add(pose);
      if (!modelErrorReported) {
        modelErrorReported = true;
        onModelError();
      }
    },
  }) : null;

  function cancelIdleRetry() {
    if (idleRetryTimer !== null) window.clearTimeout(idleRetryTimer);
    idleRetryTimer = null;
  }

  function stopIdle() {
    if (!idle) return;
    const previous = idle;
    idle = null;
    if (images[previous.pose]?.loaded) images[previous.pose].element.style.opacity = "1";
    previous.element.removeAttribute("src");
    previous.element.remove();
  }

  function syncIdle() {
    if (disposed || document.hidden || fadeTimer !== null || !current) {
      stopIdle();
      return;
    }
    if (models?.isActive(current)) {
      stopIdle();
      images[current].element.style.opacity = "0";
      return;
    }
    if (unavailableIdle.has(current)) {
      stopIdle();
      if (models?.isLoading(current)) return;
      idleIssues.add(current);
      if (!idleErrorReported) {
        idleErrorReported = true;
        onIdleError();
      }
      return;
    }
    if (motion.matches || !config.idle?.[current] || failedIdle.has(current)) {
      stopIdle();
      return;
    }
    if (idle?.pose === current) return;
    stopIdle();
    const element = document.createElement("img");
    element.className = "office-character-art";
    element.alt = "";
    element.draggable = false;
    element.setAttribute("aria-hidden", "true");
    element.style.opacity = "0";
    const pending = { element, pose: current, loaded: false };
    idle = pending;
    element.addEventListener("load", () => {
      if (idle !== pending || disposed || document.hidden || motion.matches || current !== pending.pose) return;
      failedIdle.delete(pending.pose);
      idleFailures.delete(pending.pose);
      idleIssues.delete(pending.pose);
      if (!idleIssues.size) idleErrorReported = false;
      pending.loaded = true;
      element.style.opacity = "1";
      images[pending.pose].element.style.opacity = "0";
    }, { once: true });
    element.addEventListener("error", () => {
      if (idle !== pending) return;
      failedIdle.add(pending.pose);
      const count = (idleFailures.get(pending.pose) || 0) + 1;
      idleFailures.set(pending.pose, count);
      stopIdle();
      if (count === 1) {
        cancelIdleRetry();
        idleRetryTimer = window.setTimeout(() => {
          idleRetryTimer = null;
          if (disposed || document.hidden || motion.matches || current !== pending.pose) return;
          failedIdle.delete(pending.pose);
          syncIdle();
        }, 2000);
      } else {
        idleIssues.add(pending.pose);
        if (!idleErrorReported) {
          idleErrorReported = true;
          onIdleError();
        }
      }
    }, { once: true });
    frame.append(element);
    element.src = config.idle[current];
  }

  function renderPose(pose) {
    if (disposed) return;
    // A faster-loading keyboard or speaking image is not a change of attention.
    // While the requested still loads, keep the current pose (or the empty room).
    if (images[pose] && !images[pose].loaded && !failed.has(pose)) return;
    const choices = pose === "rest" ? ["rest", "dialogue", "work"]
      : pose === "dialogue" ? ["dialogue", "rest", "work"] : ["work", "rest", "dialogue"];
    const selected = choices.find((name) => images[name]?.loaded);
    if (!selected) return;
    if (fadeTimer !== null && selected === desired) return;
    if (fadeTimer !== null && desired !== current) images[desired].element.style.opacity = "0";
    desired = selected;
    if (fadeTimer !== null) window.clearTimeout(fadeTimer);
    fadeTimer = null;
    if (current === desired) {
      frame.dataset.pose = current;
      images[current].element.style.opacity = models?.isActive(current) || (idle?.pose === current && idle.loaded) ? "0" : "1";
      syncModel();
      syncIdle();
      return;
    }
    models?.beginTransition();
    cancelIdleRetry();
    failedIdle.delete(desired);
    idleFailures.delete(desired);
    if (idle?.loaded && current) {
      // Replace the APNG with its matching still before dropping the animation.
      const still = images[current].element;
      still.style.transition = "none";
      still.style.opacity = "1";
      void still.offsetWidth;
      still.style.transition = "";
    }
    stopIdle();
    if (current) images[current].element.style.opacity = "0";
    // Crossfade the already loaded incoming pose during the same paint.
    // Waiting for the outgoing fade to end briefly left an empty chair.
    images[desired].element.style.opacity = "1";
    frame.dataset.pose = desired;
    const show = () => {
      fadeTimer = null;
      if (disposed) return;
      current = desired;
      frame.dataset.pose = current;
      images[current].element.style.opacity = "1";
      syncModel();
      syncIdle();
    };
    if (current && !motion.matches) fadeTimer = window.setTimeout(show, 140);
    else show();
  }

  const controller = new PoseState({ sessionId, onChange: ({ pose }) => renderPose(pose),
    schedule: (fn, delay) => window.setTimeout(fn, delay), cancel: (id) => window.clearTimeout(id) });
  function syncModel() {
    if (!models) return;
    if (disposed || document.hidden || motion.matches || fadeTimer !== null || !current) {
      if (current && models.isActive(current) && images[current]?.loaded) images[current].element.style.opacity = "1";
      models.setPose(null);
      return;
    }
    models.setPose(current, controller.state.pose);
  }
  const resetIdleAfterResume = () => {
    cancelIdleRetry();
    if (!document.hidden && !motion.matches && current) {
      failedIdle.delete(current);
      idleFailures.delete(current);
    }
    syncModel();
    syncIdle();
  };
  document.addEventListener("visibilitychange", resetIdleAfterResume);
  motion.addEventListener("change", resetIdleAfterResume);
  function connect() {
    if (disposed) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
    socket = ws;
    let token = null;
    const observe = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
        version: 1, type: "session.observe", session_id: sessionId,
        message_id: crypto.randomUUID(), payload: {},
      }));
    };
    const schedulePoll = () => {
      window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(observe, 5000);
    };
    ws.onopen = () => {
      if (disposed || socket !== ws) return;
      token = controller.connected();
      retryDelay = 500;
      if (reconnectPending) models?.serviceReconnected();
      reconnectPending = false;
      observe();
    };
    ws.onmessage = (event) => {
      if (disposed || socket !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { ws.close(); return; }
      const applied = controller.handle(token, message);
      if (message.type === "error" && message.payload?.code === "sync_failed") schedulePoll();
      else if (applied && message.type === "session.snapshot" && message.payload.state === "thinking") schedulePoll();
      else if (applied && message.type === "session.snapshot") { window.clearTimeout(pollTimer); pollTimer = null; }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      window.clearTimeout(pollTimer);
      pollTimer = null;
      controller.disconnected(token);
      if (!disposed) {
        reconnectPending = true;
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 8000);
      }
    };
    ws.onerror = () => ws.close();
  }

  function connectWhenReady() {
    if (connected || !names.every((name) => images[name].loaded || failed.has(name))) return;
    if (names.filter((name) => images[name].loaded).length < 2) return;
    connected = true;
    connect();
  }

  for (const name of names) {
    const element = document.createElement("img");
    element.className = "office-character-art office-character-art--pose";
    element.alt = name === "dialogue" ? "面向你的 Mona" : name === "work" ? "正在工作的 Mona" : "休息中的 Mona";
    element.draggable = false;
    element.style.opacity = "0";
    images[name] = { element, loaded: false };
    element.addEventListener("load", () => {
      if (disposed) return;
      images[name].loaded = true;
      renderPose(controller.state.pose);
      connectWhenReady();
    }, { once: true });
    element.addEventListener("error", () => {
      if (disposed) return;
      failed.add(name);
      renderPose(controller.state.pose);
      renderPose(controller.state.pose);
      connectWhenReady();
      onError();
    }, { once: true });
    frame.append(element);
    element.src = config[name];
  }

  return {
    listeningStarted(id) { return disposed ? null : controller.listeningStarted(id); },
    listeningEnded(token) { return !disposed && controller.listeningEnded(token); },
    playbackStarted(id, readMouth) {
      const token = disposed ? null : controller.playbackStarted(id);
      if (token) models?.setMouthSource?.(readMouth);
      return token;
    },
    playbackEnded(token) {
      if (disposed || !controller.playbackEnded(token)) return false;
      models?.setMouthSource?.(null);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(pollTimer);
      window.clearTimeout(fadeTimer);
      cancelIdleRetry();
      controller.dispose();
      if (socket) socket.close();
      document.removeEventListener("visibilitychange", resetIdleAfterResume);
      motion.removeEventListener("change", resetIdleAfterResume);
      models?.dispose();
      stopIdle();
      for (const { element } of Object.values(images)) element.remove();
    },
  };
}
