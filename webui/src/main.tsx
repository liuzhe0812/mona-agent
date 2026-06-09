import ReactDOM from "react-dom/client";

import App from "./App";
import "./globals.css";
import "./i18n";

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
  if (e.key === "F5") e.preventDefault();
});

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

function isMdReaderRoute(): boolean {
  const hash = window.location.hash;
  return hash.startsWith("#/md-reader");
}

function getMdReaderFilePath(): string | null {
  const hash = window.location.hash;
  const match = hash.match(/[?&]file=([^&]+)/);
  if (match) {
    return decodeURIComponent(match[1]);
  }
  return null;
}

if (isMdReaderRoute()) {
  import("./components/md-reader/MdReaderApp").then(({ MdReaderApp }) => {
    const filePath = getMdReaderFilePath();
    ReactDOM.createRoot(root!).render(<MdReaderApp initialFilePath={filePath} />);
  });
} else {
  ReactDOM.createRoot(root).render(<App />);
}
