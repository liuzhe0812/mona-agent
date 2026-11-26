import { mountOfficeScene } from "/office-scene.js";
import { mountOfficePoses } from "/office-pose.js";
import { mountOfficeVoice } from "/office-voice.js";

const host = document.getElementById("office");
const notice = document.getElementById("notice");
let scene;
let poses;
let voice;
let disposed = false;

function showNotice(title, message) {
  if (notice.open) return;
  notice.querySelector("h2").textContent = title;
  notice.querySelector("p").textContent = message;
  notice.showModal();
}
function failed() { showNotice("办公室暂时无法打开", "场景素材未能加载，请检查场景文件后重新打开。"); }
function idleFailed() { showNotice("人物动作暂时不可用", "当前暂时显示静态画面。请检查动作素材，重新启动交互程序后再试。"); }
function modelFailed() { showNotice("人物实时动作暂时不可用", "当前继续显示备用画面。请检查角色资源后重新打开。"); }
host.addEventListener("mona:office-scene-error", failed);

try {
  const response = await fetch("/scene", { credentials: "same-origin", redirect: "error" });
  if (!response.ok) throw new Error("Scene unavailable");
  const config = await response.json();
  if (!config.available) throw new Error("Scene not configured");
  if (disposed) throw new Error("Page closed");
  scene = mountOfficeScene(host, config);
  const key = "mona-interaction-demo-session";
  const sessionId = sessionStorage.getItem(key) || crypto.randomUUID();
  sessionStorage.setItem(key, sessionId);
  if (config.artwork_url || config.work_artwork_url || config.rest_artwork_url) {
    poses = mountOfficePoses(scene.frame, {
      rest: config.rest_artwork_url, dialogue: config.artwork_url, work: config.work_artwork_url,
      idle: { rest: config.rest_idle_url, dialogue: config.dialogue_idle_url, work: config.work_idle_url },
      idleUnavailable: config.idle_unavailable,
      realtime: [config.width, config.height],
    }, sessionId, failed, idleFailed, modelFailed);
  }
  const ids = { toggle: "voice-toggle", stopSpeech: "voice-stop-speech", status: "voice-status", mode: "voice-mode", details: "voice-details",
    partial: "voice-partial", text: "voice-text", send: "voice-send", review: "voice-review", reply: "voice-reply" };
  const ui = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, document.getElementById(id)]));
  voice = mountOfficeVoice({ ui, poses, sessionId, showNotice });
  function appendForeground(points, className) {
    const foreground = document.createElement("img");
    foreground.className = className;
    foreground.alt = "";
    foreground.draggable = false;
    foreground.style.clipPath = `polygon(evenodd, ${points.map(([x, y]) => `${x * 100}% ${y * 100}%`).join(", ")})`;
    foreground.addEventListener("error", failed);
    foreground.src = config.background_url;
    scene.frame.append(foreground);
  }
  if (config.foreground) appendForeground(config.foreground, "office-foreground");
  if (config.rest_foreground) appendForeground(config.rest_foreground, "office-foreground office-foreground--rest");
} catch {
  if (!disposed) failed();
}

window.addEventListener("pagehide", () => { disposed = true; voice?.dispose(); poses?.dispose(); scene?.dispose(); });
