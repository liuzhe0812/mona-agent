import { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./globals.css";
import "./i18n";

const NotificationWindow = lazy(() =>
  import("./components/notification/NotificationWindow").then((module) => ({
    default: module.NotificationWindow,
  })),
);

function isNotificationRoute(): boolean {
  return (
    typeof window !== "undefined" &&
    window.location.hash.startsWith("#/notification")
  );
}

if (typeof globalThis.crypto !== "undefined" && !("randomUUID" in globalThis.crypto)) {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () =>
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }),
    configurable: true,
  });
}

document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === "F5") e.preventDefault();
  if (e.key === "a" && ctrl && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) e.preventDefault();
  if (e.key === "p" && ctrl) e.preventDefault();
  if (e.key === "s" && ctrl) e.preventDefault();
  if (e.key === "f" && ctrl) e.preventDefault();
  if (e.key === "l" && ctrl) e.preventDefault();
  if (e.key === "=" && ctrl) e.preventDefault();
  if (e.key === "-" && ctrl) e.preventDefault();
  if (e.key === "0" && ctrl) e.preventDefault();
  if (e.key === "F12") e.preventDefault();
  if (e.key === "I" && ctrl && e.shiftKey) e.preventDefault();
  if (e.key === "Backspace" && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName) && !(e.target as HTMLElement)?.isContentEditable) e.preventDefault();

  // 诊断快捷键：Ctrl+Shift+D 输出可能导致点击被拦截的 DOM 状态
  if (e.key === "D" && ctrl && e.shiftKey) {
    e.preventDefault();
    const body = document.body;
    const root = document.getElementById("root");
    const radixPortals = body.querySelectorAll("[data-radix-portal]");
    const fixedElements = Array.from(body.querySelectorAll("*")).filter((el) => {
      const style = window.getComputedStyle(el);
      return style.position === "fixed" && style.pointerEvents !== "none";
    });
    const ariaHidden = body.querySelectorAll("[aria-hidden='true']");
    const inertEls = body.querySelectorAll("[inert]");
    console.log("===== 诊断：点击拦截状态 =====");
    console.log("body.pointerEvents:", body.style.pointerEvents);
    console.log("body.overflow:", body.style.overflow);
    console.log("body.paddingRight:", body.style.paddingRight);
    console.log("body[data-scroll-locked]:", body.hasAttribute("data-scroll-locked"));
    console.log("#root aria-hidden:", root?.getAttribute("aria-hidden"));
    console.log("#root inert:", root?.hasAttribute("inert"));
    console.log("#root pointer-events:", root ? window.getComputedStyle(root).pointerEvents : "N/A");
    console.log("Radix portals count:", radixPortals.length);
    radixPortals.forEach((p, i) => {
      const open = p.querySelectorAll('[data-state="open"]').length;
      const closed = p.querySelectorAll('[data-state="closed"]').length;
      console.log(`  Portal[${i}]: open=${open}, closed=${closed}, pointerEvents=${window.getComputedStyle(p).pointerEvents}`);
    });
    console.log("Fixed elements with pointer-events != none:", fixedElements.length);
    fixedElements.forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      console.log(`  Fixed[${i}]:`, {
        tag: el.tagName,
        id: el.id,
        className: (el.className as string)?.slice(0, 80),
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        pointerEvents: window.getComputedStyle(el).pointerEvents,
        zIndex: window.getComputedStyle(el).zIndex,
        opacity: window.getComputedStyle(el).opacity,
        visibility: window.getComputedStyle(el).visibility,
        display: window.getComputedStyle(el).display,
      });
    });
    console.log("aria-hidden='true' elements:", ariaHidden.length);
    ariaHidden.forEach((el, i) => {
      console.log(`  ariaHidden[${i}]:`, el.tagName, el.id, (el.className as string)?.slice(0, 60));
    });
    console.log("inert elements:", inertEls.length);
    console.log("===== 诊断结束 =====");
  }
});

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

// 通知窗口是独立的 Tauri 窗口，跳过 App 的 bootstrap 逻辑，直接渲染通知组件。
// 这样通知窗口加载更快，不依赖 runtime 连接。
if (isNotificationRoute()) {
  ReactDOM.createRoot(root).render(
    <Suspense fallback={null}>
      <NotificationWindow />
    </Suspense>,
  );
} else {
  ReactDOM.createRoot(root).render(<App />);
}
