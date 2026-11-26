import { WakeClient } from "./wake-client.js";
import { AudioPlayback } from "./audio-playback.js";

const PENDING_KEY = "mona-interaction-voice-pending";
const MUTE_KEY = "mona-office-microphone-muted";
const MAX_QUEUED = 20;
const WAKE_LISTENING_GRACE_MS = 8000;

export function mountOfficeVoice({ ui, poses, sessionId, Wake = WakeClient, Player = AudioPlayback, storage = sessionStorage,
  showNotice = null }) {
  let disposed = false;
  let microphone = null;
  let micStarting = false;
  let muted = false;
  let preferenceReadable = true;
  try { muted = window.localStorage.getItem(MUTE_KEY) === "1"; }
  catch { preferenceReadable = false; muted = true; }
  let autoTried = false;
  let voiceProblem = null;
  let voiceRetry = null;
  let retryCount = 0;
  let resumeOnSync = false;
  let awake = false;
  let listeningToken = null;
  let wakeTimer = null;
  let wakeTimerToken = null;
  let microphoneGeneration = 0;
  let observer = null;
  let observeNow = null;
  let writer = null;
  let retryTimer = null;
  let syncTimer = null;
  let retryDelay = 500;
  let connected = false;
  let synced = false;
  let busyId = null;
  let mode = "unconfigured";
  let playback = null;
  let playbackGeneration = 0;
  let audioContext = null;
  let overlapsPlayback = false;
  let echoGuardUntil = 0;
  const recognizedSegments = new Set();
  let reviewRequired = false;
  let remoteUnknown = false;
  let reviewTarget = null;
  let unidentifiedUnknown = false;
  let resolver = null;
  let resolveTimer = null;
  let sending = null;
  let displayedQueue = false;
  const queue = [];
  const failedMessages = new Set();
  const handlers = [];
  let wasReviewRequired = false;

  const listen = (element, event, handler) => {
    element.addEventListener(event, handler);
    handlers.push(() => element.removeEventListener(event, handler));
  };
  const clearSyncTimer = () => {
    if (syncTimer !== null) window.clearTimeout(syncTimer);
    syncTimer = null;
  };
  const status = (text) => { ui.status.textContent = text; };
  const validReviewId = (id) => typeof id === "string" && id.trim().length > 0 && id.length <= 128;
  const describeReview = () => {
    const text = typeof reviewTarget?.text === "string" ? reviewTarget.text.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    status(`${text ? `“${text}”的` : "上次操作的"}结果尚未确认。请先核对实际结果；确认只结束核对，不代表操作成功或取消。`);
  };
  const startListeningPose = () => {
    if (awake && !listeningToken) listeningToken = poses?.listeningStarted(crypto.randomUUID()) || null;
  };
  const clearWakeTimer = () => {
    if (wakeTimer !== null) window.clearTimeout(wakeTimer);
    wakeTimer = null;
    wakeTimerToken = null;
  };
  const endListeningPose = (keepWindow = false) => {
    if (!keepWindow) clearWakeTimer();
    if (listeningToken) poses?.listeningEnded(listeningToken);
    listeningToken = null;
  };
  function syncWakeWindow() {
    // Waiting for a known reply or playing its audio is part of this turn.
    // A failed/unknown task still allows the microphone to return to standby.
    const awaitingReply = connected && synced && !reviewRequired && (busyId || sending);
    if (disposed || !awake || !microphone || playback || awaitingReply) {
      clearWakeTimer();
      return;
    }
    if (wakeTimer !== null) return;
    const token = {};
    wakeTimerToken = token;
    wakeTimer = window.setTimeout(() => {
      if (disposed || wakeTimerToken !== token || !awake || !microphone) return;
      awake = false;
      overlapsPlayback = false;
      endListeningPose();
      ui.partial.textContent = "";
      if (microphone.rearm() && !queue.length && !reviewRequired && connected && synced
          && (!ui.status.textContent || ui.status.textContent === "已唤醒，正在聆听。")) {
        status("等待唤醒 · Hey Mona");
      }
    }, WAKE_LISTENING_GRACE_MS);
  }
  const update = () => {
    syncWakeWindow();
    ui.toggle.hidden = mode === "unconfigured";
    ui.toggle.textContent = microphone || micStarting || voiceRetry !== null ? "静音"
      : muted ? "取消静音" : voiceProblem ? "重试麦克风" : "使用麦克风";
    ui.toggle.disabled = !microphone && (!connected || !synced || mode === "unconfigured");
    ui.send.disabled = !connected || !synced || mode === "unconfigured" || Boolean(busyId)
      || Boolean(sending) || reviewRequired || !ui.text.value.trim();
    ui.text.disabled = Boolean(sending);
    ui.review.hidden = !reviewRequired;
    ui.review.disabled = Boolean(resolver) || !connected || !synced;
    ui.stopSpeech.disabled = !playback;
    ui.stopSpeech.hidden = !playback;
    ui.details.hidden = !(mode === "mona" || microphone || micStarting || queue.length || ui.text.value || reviewRequired || ui.reply.textContent);
    if (ui.details.hidden) ui.details.open = false;
    else if (reviewRequired && !wasReviewRequired) ui.details.open = true;
    wasReviewRequired = reviewRequired;
  };
  const showNext = () => {
    ui.text.value = queue[0]?.text || "";
    displayedQueue = queue.length > 0;
    update();
  };
  const stopSpeech = () => {
    if (!playback) return true;
    const active = playback;
    try {
      active.socket?.close();
      if (active.player && active.audioToken) active.player.interrupt(active.audioToken);
    } catch {
      status("朗读未能停止，请再次点击停止朗读。");
      update();
      return false;
    }
    // Some players can report completion synchronously from cancel().
    if (playback === active) {
      playback = null;
      playbackGeneration += 1;
      echoGuardUntil = Date.now() + 1500;
      active.player?.dispose();
      if (active.poseToken) poses?.playbackEnded(active.poseToken);
    }
    update();
    return true;
  };
  const speak = (text, id) => {
    ui.reply.textContent = text || "";
    if (!text || !microphone || !awake) return;
    if (!stopSpeech()) return;
    if (!audioContext || audioContext.state !== "running") {
      status("回复已显示，音频播放尚未启用。");
      return;
    }
    const token = ++playbackGeneration;
    const active = { token, poseToken: null, socket: null, player: null, audioToken: null };
    playback = active;
    const started = () => {
      if (disposed || playback !== active || token !== playbackGeneration) return;
      active.poseToken = poses?.playbackStarted(id, () => active.player.mouthOpening(active.audioToken)) || null;
      update();
    };
    const ended = (error) => {
      if (disposed || playback !== active || token !== playbackGeneration) return;
      playback = null;
      echoGuardUntil = Date.now() + 1500;
      active.player?.dispose();
      if (active.poseToken) poses?.playbackEnded(active.poseToken);
      if (error && error !== "interrupted") status("朗读未完成，回复文字仍可查看。");
      update();
    };
    try {
      const queue = [];
      let streamEnded = false;
      let odd = null;
      const pump = () => {
        while (queue.length && playback === active) {
          const result = active.player.enqueue(active.audioToken, { samples: queue[0], sampleRate: 24000 });
          if (result.status === "backpressure") return;
          queue.shift();
        }
        if (streamEnded && !queue.length && playback === active) active.player.finish(active.audioToken);
      };
      active.player = new Player({ context: audioContext, onStart: started, onEnd: (_t, reason) => ended(reason === "completed" ? null : reason), onDrain: pump, onError: () => ended("failed") });
      active.audioToken = active.player.begin({ utteranceId: id });
      const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/tts`);
      active.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => socket.send(JSON.stringify({ text }));
      socket.onmessage = (event) => {
        if (playback !== active) return;
        try {
          if (typeof event.data === "string") {
            const message = JSON.parse(event.data);
            if (message.type === "error") { stopSpeech(); status(message.message || "朗读未完成。"); }
            if (message.type === "end") { streamEnded = true; pump(); }
            return;
          }
          const input = new Uint8Array(event.data);
          const bytes = new Uint8Array(input.length + (odd === null ? 0 : 1));
          if (odd !== null) bytes[0] = odd;
          bytes.set(input, odd === null ? 0 : 1);
          odd = bytes.length % 2 ? bytes[bytes.length - 1] : null;
          const values = new Int16Array(Math.floor(bytes.length / 2));
          const view = new DataView(bytes.buffer);
          for (let i = 0; i < values.length; i += 1) values[i] = view.getInt16(i * 2, true);
          if (values.length) queue.push(values);
          pump();
        } catch { stopSpeech(); status("朗读未完成，回复文字仍可查看。"); }
      };
      socket.onerror = () => { if (playback === active) { stopSpeech(); status("本地语音暂时不可用。"); } };
      socket.onclose = () => { if (playback === active && !streamEnded) { stopSpeech(); status("朗读未完成，回复文字仍可查看。"); } };
    } catch { ended("failed"); }
    update();
  };

  function onWake() {
    if (disposed) return;
    awake = true;
    startListeningPose();
    clearWakeTimer();
    syncWakeWindow();
    status("已唤醒，正在聆听。");
  }
  function onTranscript(event) {
    if (disposed || !awake) return;
    if (event.type === "asr.partial") {
      if (event.text.trim()) {
        if (playback) {
          overlapsPlayback = true;
          // A recognizable fragment that is not in the reply may be the user
          // interrupting. Similar fragments can be loudspeaker echo.
          const normalize = (text) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
          const heard = normalize(event.text);
          const reply = normalize(ui.reply.textContent || "");
          if (heard.length >= 2 && !reply.includes(heard)) stopSpeech();
        }
        clearWakeTimer();
        syncWakeWindow();
        startListeningPose();
      }
      ui.partial.textContent = event.text ? `正在识别：${event.text}` : "";
    } else if (event.type === "asr.final") {
      endListeningPose(true);
      ui.partial.textContent = "";
      const overlapping = overlapsPlayback || Boolean(playback) || Date.now() < echoGuardUntil;
      overlapsPlayback = false;
      if (!event.text.trim() || /^(?:hey[\s,，]*)?mona[\s.!！?？。]*$/iu.test(event.text.trim())) return;
      clearWakeTimer();
      syncWakeWindow();
      // Real recognition messages carry a stream/generation/segment identity.
      // Never dispatch the same recognized utterance twice.
      const segment = typeof event.stream_id === "string" && Number.isSafeInteger(event.generation)
        && Number.isSafeInteger(event.segment) ? `${event.stream_id}:${event.generation}:${event.segment}` : null;
      if (segment && recognizedSegments.has(segment)) return;
      if (segment) {
        recognizedSegments.add(segment);
        if (recognizedSegments.size > 256) recognizedSegments.delete(recognizedSegments.values().next().value);
      }
      const autoSend = Boolean(segment) && !overlapping && !queue.length && !ui.text.value.trim()
        && connected && synced && mode !== "unconfigured" && !busyId && !sending && !reviewRequired;
      queue.push({ text: event.text });
      if (queue.length === 1 && !ui.text.value) showNext();
      if (autoSend) { send(); return; }
      ui.details.open = true;
      status(busyId ? `Mona 正在处理上一条，已保留 ${queue.length} 条待确认内容。`
        : overlapping ? "播放期间识别到声音，已保留内容，请核对后发送。"
          : `已保留 ${queue.length} 条待确认内容，请核对后发送。`);
      if (queue.length >= MAX_QUEUED) {
        const active = microphone;
        microphone = null;
        if (active) void active.stop().catch(() => status("麦克风未能正常关闭，请检查设备。"));
        endListeningPose();
        awake = false;
        status(`已保留 ${queue.length} 条待确认内容。为避免遗漏，语音已关闭，请先处理这些内容。`);
      }
      update();
    } else if (event.type === "asr.endpoint") {
      overlapsPlayback = false;
      endListeningPose(true);
      ui.partial.textContent = "";
    }
  }

  function clearVoiceRetry() {
    window.clearTimeout(voiceRetry);
    voiceRetry = null;
  }

  function saveMute(value) {
    muted = value;
    try { window.localStorage.setItem(MUTE_KEY, value ? "1" : "0"); return true; }
    catch { return false; }
  }

  async function muteCapture() {
    clearVoiceRetry();
    resumeOnSync = false;
    const active = microphone;
    microphone = null;
    const generation = ++microphoneGeneration;
    micStarting = false;
    const speechStopped = stopSpeech();
    endListeningPose();
    awake = false;
    overlapsPlayback = false;
    ui.partial.textContent = "";
    audioContext = null;
    update();
    let failed = false;
    try { await active?.stop(); } catch { failed = true; }
    if (disposed || generation !== microphoneGeneration) return;
    status(failed
      ? (speechStopped ? "麦克风未能正常关闭，请检查设备。" : "麦克风和朗读未能正常关闭，请检查设备并再次停止朗读。")
      : (speechStopped ? "麦克风已静音" : "语音输入已关闭，但朗读未能停止，请再次点击停止朗读。"));
    update();
  }

  function handleVoiceFailure(error) {
    microphone = null;
    microphoneGeneration += 1;
    micStarting = false;
    stopSpeech();
    audioContext = null;
    endListeningPose();
    awake = false;
    ui.partial.textContent = "";
    voiceProblem = error?.code || "capture_failed";
    const message = error?.message || "请检查麦克风后重试。";
    status(message);
    if (!muted && mode === "mona" && ["wake_busy", "connection_failed", "capture_timeout", "capture_failed"].includes(voiceProblem)
        && retryCount < 3) {
      const delay = 1000 * 2 ** retryCount++;
      clearVoiceRetry();
      voiceRetry = window.setTimeout(() => {
        voiceRetry = null;
        if (!disposed && !muted) {
          if (synced) void startCapture();
          else resumeOnSync = true;
        }
      }, delay);
      status("麦克风连接中断，正在恢复…");
    } else if (showNotice) {
      showNotice("Mona 暂时听不到你", message);
      status("麦克风不可用");
    }
    update();
  }

  async function startCapture() {
    if (disposed || muted || microphone || micStarting || !synced || mode === "unconfigured") return;
    voiceProblem = null;
    micStarting = true;
    const generation = ++microphoneGeneration;
    let asrProblem = null;
    if (!reviewRequired && !queue.length) status("正在准备麦克风。首次使用时，请在权限提示中选择允许。");
    update();
    let active;
    const isCurrent = () => !disposed && generation === microphoneGeneration && microphone === active;
    active = new Wake({
      onWake: () => {
        if (!isCurrent()) return;
        if (active.asrAvailable !== true || asrProblem) {
          awake = false;
          endListeningPose();
          ui.partial.textContent = "";
          status(asrProblem || "已检测到唤醒，但语音识别暂不可用。请检查语音资源。");
          return;
        }
        onWake();
      },
      onTranscript: (event) => { if (isCurrent()) onTranscript(event); },
      onASRUnavailable: (error) => {
        if (!isCurrent()) return;
        endListeningPose();
        awake = false;
        ui.partial.textContent = "";
        asrProblem = error.message || "语音识别资源不可用。";
        status(asrProblem);
      },
      onError: (error) => {
        if (!isCurrent()) return;
        handleVoiceFailure(error);
      },
    });
    try {
      microphone = active;
      const started = await active.start();
      if (!isCurrent()) return;
      if (started) {
        audioContext = active.audioContext;
        retryCount = 0;
        if (!reviewRequired && !queue.length) status(asrProblem || (active.asrAvailable === true
          ? "等待唤醒 · Hey Mona"
          : "语音识别暂不可用，请检查语音资源。"));
      }
      else {
        microphone = null;
        endListeningPose();
        awake = false;
      }
    } catch (error) {
      if (isCurrent()) handleVoiceFailure(error);
    } finally {
      if (generation === microphoneGeneration) {
        micStarting = false;
        update();
      }
    }
  }

  function acknowledgeSending(id) {
    if (failedMessages.has(id) || sending?.id !== id || sending.accepted) return;
    sending.accepted = true;
    if (sending.queued && queue.length) queue.shift();
    showNext();
    status("Mona 正在处理。");
  }

  function connectionFailed(id, code = "connection_failed") {
    if (failedMessages.has(id) || reviewRequired) return;
    const pending = sending?.id === id ? sending : null;
    if (!pending && busyId !== id) return;
    failedMessages.add(id);
    if (failedMessages.size > 100) failedMessages.delete(failedMessages.values().next().value);
    if (busyId === id) busyId = null;
    if (!busyId && synced) clearSyncTimer();
    if (pending) {
      if (pending.accepted) {
        queue.unshift({ text: pending.text });
        showNext();
      } else if (!ui.text.value) {
        ui.text.value = pending.text;
      }
      ui.details.open = true;
      storage.removeItem(PENDING_KEY);
      sending = null;
      const activeWriter = writer;
      writer = null;
      if (activeWriter) activeWriter.close();
    }
    const message = code === "reply_failed" ? "Mona 已收到你的话，但暂时无法生成回复。请检查对话服务连接后再试。"
      : !pending ? "Mona 本次处理失败，请检查连接后再试。"
      : pending.accepted
        ? "Mona 已接收内容，但本次处理失败。原文字已保留，请核对后再决定是否重试。"
        : "连接失败，本次内容未完成。原文字已保留，请检查后再决定是否重试。";
    if (showNotice) {
      status("");
      showNotice("这次对话未完成", message);
    } else status(message);
  }

  function connectObserver() {
    if (disposed) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
    observer = ws;
    observeNow = () => {
      if (observer === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
        version: 1, type: "session.observe", session_id: sessionId, message_id: crypto.randomUUID(), payload: {},
      }));
    };
    const scheduleObservation = (delay) => {
      clearSyncTimer();
      const timer = window.setTimeout(() => {
        if (syncTimer !== timer || disposed || observer !== ws) return;
        syncTimer = null;
        observeNow?.();
      }, delay);
      syncTimer = timer;
    };
    ws.onopen = () => {
      if (disposed || observer !== ws) return;
      connected = true;
      synced = false;
      retryDelay = 500;
      observeNow();
      update();
    };
    ws.onmessage = (event) => {
      if (disposed || observer !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { ws.close(); return; }
      if (message.version !== 1 || message.session_id !== sessionId) return;
      const payload = message.payload || {};
      if (message.type !== "session.snapshot" && failedMessages.has(message.message_id)) return;
      if (message.type === "session.snapshot") {
        clearSyncTimer();
        synced = true;
        mode = payload.mode;
        ui.mode.textContent = mode === "demo" ? "模拟会话：回复仅用于测试" : "";
        busyId = payload.pending_id || null;
        if (busyId) scheduleObservation(5000);
        let saved;
        try { saved = JSON.parse(storage.getItem(PENDING_KEY) || "null"); } catch { saved = null; }
        const row = saved && (payload.records || []).find((record) => record.message_id === saved.message_id);
        if (saved) {
          if (!row || row.state === "unknown") {
            if (!queue.length) { queue.push({ text: saved.text }); showNext(); }
            reviewRequired = true;
            status("上次发送的结果尚未确认。请先在原会话核对，再继续发送。");
          } else if (row.state === "accepted" && sending && !sending.accepted) {
            sending.accepted = true;
            if (sending.queued && queue.length) queue.shift();
            showNext();
          } else if (row.state === "failed" && sending?.id === saved.message_id) {
            connectionFailed(saved.message_id, "reply_failed");
          } else if (row.state === "failed" && !sending) {
            if (!reviewRequired) {
              queue.push({ text: saved.text });
              if (!ui.text.value) showNext();
              storage.removeItem(PENDING_KEY);
              status("上次内容处理失败，原文字已保留。请核对后再决定是否重试。");
            }
          } else if (["completed", "failed", "closed_unknown"].includes(row.state)) {
            storage.removeItem(PENDING_KEY);
            if (sending && !sending.accepted) {
              if (sending.queued && queue.length) queue.shift();
              showNext();
            }
            sending = null;
            const activeWriter = writer;
            writer = null;
            if (activeWriter) activeWriter.close();
          }
        }
        const currentReview = reviewTarget && (payload.records || []).find((record) => record?.message_id === reviewTarget.id);
        if (currentReview && ["completed", "failed", "closed_unknown"].includes(currentReview.state)) reviewTarget = null;
        if ((payload.records || []).some((record) => record?.state === "unknown" && !validReviewId(record.message_id))) {
          unidentifiedUnknown = true;
          reviewRequired = true;
        }
        const unresolved = (payload.records || []).find((record) => record?.state === "unknown" && validReviewId(record.message_id));
        if (!reviewTarget && unresolved) reviewTarget = { id: unresolved.message_id, text: unresolved.text || "" };
        remoteUnknown = Boolean(reviewTarget);
        if (remoteUnknown) {
          reviewRequired = true;
          describeReview();
        }
        if (mode === "unconfigured") status("请先完成与 Mona 的连接配置。");
        if (mode === "mona" && (!autoTried || resumeOnSync)) {
          autoTried = true;
          resumeOnSync = false;
          if (!muted) void startCapture();
          else if (!reviewRequired) status(preferenceReadable ? "麦克风已静音" : "此窗口无法读取麦克风偏好，已保持静音。");
        }
      } else if (message.type === "input.accepted") {
        busyId = message.message_id;
        acknowledgeSending(message.message_id);
      } else if (message.type === "reply.completed") {
        speak(typeof payload.text === "string" ? payload.text : "", message.message_id);
      } else if (message.type === "turn.state" && payload.state === "thinking") {
        busyId = message.message_id;
      } else if (message.type === "turn.state" && payload.state === "idle" && busyId === message.message_id) {
        busyId = null;
        if (synced) clearSyncTimer();
        if (sending?.id === message.message_id && !reviewRequired) {
          storage.removeItem(PENDING_KEY);
          sending = null;
          if (writer) writer.close();
          writer = null;
        }
        if (queue.length) status(`已保留 ${queue.length} 条待确认内容，请核对后发送。`);
        else if (!reviewRequired && ui.status.textContent === "Mona 正在处理。") status("");
      } else if (message.type === "error" && payload.code === "result_unknown") {
        reviewRequired = true;
        if (validReviewId(message.message_id)) {
          reviewTarget = { id: message.message_id, text: sending?.id === message.message_id ? sending.text : "" };
          remoteUnknown = true;
        } else unidentifiedUnknown = true;
        describeReview();
      } else if (message.type === "error" && ["connection_failed", "reply_failed"].includes(payload.code)) {
        connectionFailed(message.message_id, payload.code);
      } else if (message.type === "error" && payload.code === "sync_failed") {
        synced = false;
        status("暂时无法确认会话状态，正在恢复。待确认内容不会自动发送。");
        scheduleObservation(3000);
      }
      update();
    };
    ws.onclose = () => {
      if (observer !== ws) return;
      connected = false;
      synced = false;
      observer = null;
      observeNow = null;
      clearSyncTimer();
      if (!disposed) {
        status("会话连接中断，已保留待确认内容，正在恢复。");
        retryTimer = window.setTimeout(connectObserver, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 8000);
      }
      update();
    };
    ws.onerror = () => ws.close();
  }

  function send() {
    const text = ui.text.value.trim();
    if (!text || !connected || !synced || mode === "unconfigured" || busyId || sending || reviewRequired) return;
    const id = crypto.randomUUID();
    try { storage.setItem(PENDING_KEY, JSON.stringify({ message_id: id, text })); } catch {
      status("无法保存发送状态，内容尚未发送。请检查存储权限。");
      return;
    }
    let ws;
    try { ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`); } catch {
      storage.removeItem(PENDING_KEY);
      status("会话连接失败，内容尚未发送，可稍后重试。");
      return;
    }
    writer = ws;
    const pending = { id, text, accepted: false, sent: false, queued: displayedQueue && queue.length > 0 };
    sending = pending;
    ws.onopen = () => {
      if (disposed || writer !== ws) return;
      try {
        ws.send(JSON.stringify({ version: 1, type: "input.text", session_id: sessionId,
          message_id: id, payload: { text } }));
        pending.sent = true;
      } catch {
        reviewRequired = true;
        status("发送结果尚未确认，请在原会话核对。");
        update();
      }
    };
    ws.onmessage = (event) => {
      if (disposed || writer !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.session_id !== sessionId) return;
      if (message.type === "input.accepted" && message.message_id === pending.id) {
        acknowledgeSending(pending.id);
        update();
        return;
      }
      if (message.type !== "error") return;
      if (message.payload?.code === "invalid_input" && !pending.accepted) {
        storage.removeItem(PENDING_KEY);
        sending = null;
        status(message.payload.message || "发送失败，请检查后重试。");
        if (writer === ws) writer = null;
        ws.close();
      } else if (message.payload?.code === "result_unknown" && message.message_id === pending.id) {
        reviewRequired = true;
        reviewTarget = { id: pending.id, text: pending.text };
        remoteUnknown = true;
        describeReview();
      } else if (["connection_failed", "reply_failed"].includes(message.payload?.code) && message.message_id === pending.id) {
        connectionFailed(pending.id, message.payload.code);
      }
      update();
    };
    ws.onclose = () => {
      if (disposed || writer !== ws) return;
      writer = null;
      if (!pending.accepted) {
        if (pending.sent) {
          reviewRequired = true;
          status("发送结果尚未确认，请先在原会话核对。");
        } else {
          storage.removeItem(PENDING_KEY);
          sending = null;
          status("会话连接失败，内容尚未发送，可稍后重试。");
        }
      }
      update();
    };
    ws.onerror = () => ws.close();
    status(mode === "demo" ? "正在发送到模拟会话。" : "正在发送，请稍候。");
    update();
  }

  function resolveReview() {
    if (!reviewRequired || !connected || !synced || resolver) return;
    if (unidentifiedUnknown) {
      status("无法确定需要核对的请求，请先在原会话核对并重新打开页面。");
      return;
    }
    if (!remoteUnknown || !reviewTarget) {
      reviewRequired = false;
      storage.removeItem(PENDING_KEY);
      sending = null;
      const activeWriter = writer;
      writer = null;
      if (activeWriter) activeWriter.close();
      status("已记录核对。原结果仍未确认；如需重试，请确认内容后自行发送。");
      update();
      return;
    }
    const target = reviewTarget.id;
    let ws;
    try { ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`); }
    catch {
      status("核对状态未能记录，请检查连接后重试。");
      return;
    }
    resolver = ws;
    let sent = false;
    resolveTimer = window.setTimeout(() => finish(false), 15000);
    const finish = (confirmed) => {
      if (resolver !== ws) return;
      resolver = null;
      window.clearTimeout(resolveTimer);
      resolveTimer = null;
      ws.onclose = null;
      ws.close();
      if (!confirmed) {
        status(sent ? "核对状态尚未确认，正在刷新；请勿重复发送原请求。" : "核对状态未能记录，请检查连接后重试。");
        if (sent) { synced = false; observeNow?.(); }
      }
      update();
    };
    ws.onopen = () => {
      if (disposed || resolver !== ws) return;
      if (!reviewTarget || reviewTarget.id !== target || !connected || !synced) { finish(false); return; }
      try {
        ws.send(JSON.stringify({ version: 1, type: "input.resolve", session_id: sessionId,
          message_id: crypto.randomUUID(), payload: { message_id: target, acknowledged: true } }));
        sent = true;
        status("正在记录核对结果。");
      } catch { finish(false); }
    };
    ws.onmessage = (event) => {
      if (disposed || resolver !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { finish(false); return; }
      if (message.version !== 1 || message.session_id !== sessionId) return;
      if (message.type === "error") { finish(false); return; }
      if (message.type !== "session.snapshot") return;
      const records = message.payload?.records;
      if (!Array.isArray(records)) { finish(false); return; }
      const row = records.find((record) => record?.message_id === target);
      if (!row || !["closed_unknown", "completed", "failed"].includes(row.state)) { finish(false); return; }
      let saved;
      try { saved = JSON.parse(storage.getItem(PENDING_KEY) || "null"); } catch { saved = null; }
      if (saved?.message_id === target) storage.removeItem(PENDING_KEY);
      if (sending?.id === target) {
        sending = null;
        const activeWriter = writer;
        writer = null;
        if (activeWriter) activeWriter.close();
      }
      if (records.some((record) => record?.state === "unknown" && !validReviewId(record.message_id))) unidentifiedUnknown = true;
      const unresolved = records.find((record) => record?.state === "unknown" && validReviewId(record.message_id));
      reviewTarget = unresolved ? { id: unresolved.message_id, text: unresolved.text || "" } : null;
      remoteUnknown = Boolean(reviewTarget);
      reviewRequired = remoteUnknown || unidentifiedUnknown;
      if (reviewRequired) describeReview();
      else status(row.state === "closed_unknown"
        ? "已记录核对。原结果仍未确认；如需重试，请确认内容后自行发送。"
        : "请求状态已更新；请核对当前会话后再继续。");
      // Do not enable a new input until the observer has refreshed the session.
      synced = false;
      finish(true);
      observeNow?.();
    };
    ws.onclose = () => finish(false);
    ws.onerror = () => ws.close();
    update();
  }

  listen(ui.toggle, "click", async () => {
    if (microphone || micStarting || voiceRetry !== null) {
      const saved = saveMute(true);
      await muteCapture();
      if (!saved && !disposed) status("本次已静音。此窗口无法保存下次启动的偏好。");
    } else if (connected && synced && mode !== "unconfigured") {
      saveMute(false);
      retryCount = 0;
      await startCapture();
    }
  });
  listen(window, "storage", (event) => {
    if (event.key !== MUTE_KEY) return;
    muted = event.newValue === "1";
    if (muted) void muteCapture();
    else update(); // Only the window where the user unmuted opens the device.
  });
  if (globalThis.navigator?.mediaDevices?.addEventListener) {
    listen(navigator.mediaDevices, "devicechange", () => {
      if (!muted && voiceProblem === "device_unavailable") void startCapture();
    });
  }
  listen(ui.stopSpeech, "click", stopSpeech);
  listen(ui.send, "click", send);
  listen(ui.text, "input", update);
  listen(ui.review, "click", resolveReview);
  connectObserver();
  update();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      microphoneGeneration += 1;
      window.clearTimeout(retryTimer);
      clearVoiceRetry();
      clearSyncTimer();
      stopSpeech();
      audioContext = null; // Owned and closed by the microphone.
      endListeningPose();
      awake = false;
      if (microphone) void microphone.stop().catch(() => {});
      microphone = null;
      if (observer) observer.close();
      if (writer) writer.close();
      if (resolveTimer !== null) window.clearTimeout(resolveTimer);
      if (resolver) { const activeResolver = resolver; resolver = null; activeResolver.close(); }
      for (const remove of handlers) remove();
    },
  };
}
