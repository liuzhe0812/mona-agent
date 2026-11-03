const $ = (id) => document.getElementById(id);
const sessionKey = "mona-interaction-demo-session";
const pendingKey = "mona-interaction-demo-pending";
const sessionId = sessionStorage.getItem(sessionKey) || crypto.randomUUID();
sessionStorage.setItem(sessionKey, sessionId);
const records = new Map();
let socket;
let retryTimer;
let pendingId = null;
let connected = false;
let lastReply = "";
let retryDelay = 500;

function updateState(state = "idle") {
  const labels = {idle: "我在这里", thinking: "正在回应", offline: "正在恢复连接"};
  $("status").textContent = labels[connected ? state : "offline"] || labels.idle;
  $("send").disabled = !connected || Boolean(pendingId);
  $("text").disabled = Boolean(pendingId);
}

function showNotice(title, message) {
  $("notice-title").textContent = title;
  $("notice-body").textContent = message;
  if (!$("notice").open) $("notice").showModal();
}

function renderRecords() {
  const panel = $("messages");
  panel.replaceChildren();
  for (const record of records.values()) {
    for (const [label, text] of [["你", record.text], ["Mona · 模拟回复", record.reply]]) {
      if (!text) continue;
      const article = document.createElement("article");
      article.className = "message";
      const name = document.createElement("span");
      name.className = "message-label";
      name.textContent = label;
      const body = document.createElement("p");
      body.className = "message-body";
      body.textContent = text;
      article.append(name, body);
      panel.append(article);
    }
  }
  panel.scrollTop = panel.scrollHeight;
}

function sendCommand(type, payload = {}, messageId = crypto.randomUUID()) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({version: 1, type, session_id: sessionId, message_id: messageId, payload}));
  return true;
}

function reconcileSnapshot(payload) {
  const savedPending = sessionStorage.getItem(pendingKey);
  records.clear();
  for (const record of payload.records || []) records.set(record.message_id, record);
  pendingId = payload.pending_id || null;
  if (savedPending) {
    const saved = JSON.parse(savedPending);
    if (records.has(saved.message_id)) {
      sessionStorage.removeItem(pendingKey);
    } else {
      showNotice("上一条内容需要核对", "连接恢复后未找到上一条内容的处理记录，程序没有自动重发。请核对当前对话后决定是否重新发送。");
      if (!$("text").value) $("text").value = saved.text;
      sessionStorage.removeItem(pendingKey);
    }
  }
  lastReply = [...records.values()].filter((record) => record.state === "completed").at(-1)?.reply || "";
  $("read-reply").disabled = !lastReply || !("speechSynthesis" in window);
  renderRecords();
  updateState(payload.state);
}

function handleEvent(message) {
  if (message.version !== 1 || message.session_id !== sessionId) return;
  const payload = message.payload || {};
  if (message.type === "session.snapshot") return reconcileSnapshot(payload);
  if (message.type === "input.accepted") {
    records.set(message.message_id, {text: payload.text, reply: "", state: "accepted"});
    pendingId = message.message_id;
    sessionStorage.removeItem(pendingKey);
    $("text").value = "";
    renderRecords();
  } else if (message.type === "reply.delta") {
    const record = records.get(message.message_id);
    if (record) record.reply += payload.text;
    renderRecords();
  } else if (message.type === "reply.completed") {
    const record = records.get(message.message_id);
    if (record) Object.assign(record, {reply: payload.text, state: "completed"});
    lastReply = payload.text;
    $("read-reply").disabled = !("speechSynthesis" in window);
    renderRecords();
  } else if (message.type === "turn.state") {
    pendingId = payload.state === "idle" ? null : message.message_id;
    updateState(payload.state);
  } else if (message.type === "error") {
    $("field-error").textContent = payload.message || "发送失败，请检查输入内容。";
    const saved = sessionStorage.getItem(pendingKey);
    if (saved) $("text").value = JSON.parse(saved).text;
    sessionStorage.removeItem(pendingKey);
    pendingId = null;
    updateState();
  }
}

function connect() {
  clearTimeout(retryTimer);
  socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
  socket.onopen = () => {
    connected = true;
    retryDelay = 500;
    sendCommand("session.sync");
  };
  socket.onmessage = (event) => handleEvent(JSON.parse(event.data));
  socket.onclose = () => {
    connected = false;
    updateState("offline");
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 8000);
  };
  socket.onerror = () => socket.close();
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("text").value.trim();
  if (!text || pendingId || !connected) return;
  $("field-error").textContent = "";
  const messageId = crypto.randomUUID();
  sessionStorage.setItem(pendingKey, JSON.stringify({message_id: messageId, text}));
  if (sendCommand("input.text", {text}, messageId)) {
    pendingId = messageId;
    updateState("thinking");
  } else {
    sessionStorage.removeItem(pendingKey);
    $("field-error").textContent = "连接尚未恢复，请稍后发送。";
  }
});
$("text").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("read-reply").addEventListener("click", () => {
  const voices = speechSynthesis.getVoices();
  const voice = voices.find((item) => item.lang.startsWith("zh"));
  if (!voice) return showNotice("暂时无法朗读", "当前系统未提供中文语音。配置中文系统语音后可以再次试听；后续语音服务会独立接入。");
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(lastReply);
  utterance.lang = "zh-CN";
  utterance.voice = voice;
  utterance.onerror = (event) => {
    if (!["canceled", "interrupted"].includes(event.error)) showNotice("朗读未完成", "系统语音暂时不可用，请稍后重试。");
  };
  speechSynthesis.speak(utterance);
});
connect();
