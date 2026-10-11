// Test host for the real workbench components. No production route or mock API.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.MONA_SMOKE_API;
const token = process.env.MONA_SMOKE_TOKEN;
if (!target || !/^http:\/\/127\.0\.0\.1:\d+$/.test(target) || !token) throw new Error("An isolated local test API is required");
const cacheDir = mkdtempSync(path.join(tmpdir(), "mona-development-smoke-"));
const entry = "/__development_smoke_entry.js";
const server = await createServer({
  configFile: false, root, cacheDir, resolve: { alias: { "@": path.join(root, "src") } },
  plugins: [react(), {
    name: "development-smoke-host",
    resolveId(id) { if (id === entry) return "\0mona-development-smoke"; },
    load(id) {
      if (id !== "\0mona-development-smoke") return;
      if (process.env.MONA_SMOKE_CATALOG === "1") return `import React from "react";
import {createRoot} from "react-dom/client";
import {ChatProvidersSettings} from "/src/components/settings/ChatProvidersSettings.tsx";
import {DevelopmentView} from "/src/components/development/DevelopmentView.tsx";
import i18n from "/src/i18n/index.ts";
import "/src/globals.css";
await i18n.changeLanguage("zh-CN");
const settings = {agent:{provider:"",model:""},chat_providers:[],image_generation:{providers:[]},video_generation:{providers:[]}};
function CatalogWorkbench() {
 const [settingsOpen,setSettingsOpen] = React.useState(true);
 return React.createElement('div',{className:'flex h-full flex-col'},
  React.createElement('header',{className:'p-3'},React.createElement('button',{onClick:()=>setSettingsOpen(!settingsOpen)},settingsOpen?'进入开发任务':'返回模型供应商')),
  React.createElement('main',{className:'min-h-0 flex-1'},settingsOpen
   ? React.createElement(ChatProvidersSettings,{settings,token:'',onSettingsChanged:()=>{},onModelNameChange:()=>{}})
   : React.createElement(DevelopmentView,{visible:true,onOpenModelSettings:()=>setSettingsOpen(true)})));
}
createRoot(document.getElementById('root')).render(React.createElement(CatalogWorkbench));`;
      return `import React, {useCallback, useMemo, useState} from "react";
import {useBrowserTabs} from "/src/hooks/useBrowserTabs.ts";
import {browserHideTabsExcept} from "/src/lib/browser-ipc.ts";
import {createRoot} from "react-dom/client";
import {ClientProvider} from "/src/providers/ClientProvider.tsx";
import {DevelopmentView} from "/src/components/development/DevelopmentView.tsx";
import "/src/components/MarkdownTextRenderer.tsx";
import i18n from "/src/i18n/index.ts";
import "/src/globals.css";
await i18n.changeLanguage("zh-CN");
function NativeWorkbench() {
  const browser = useBrowserTabs();
  const [retained, setRetained] = useState([]);
  const retain = useCallback(id => setRetained(old => old.includes(id) ? old : [...old, id]), []);
  const create = useCallback(() => { const id = browser.addEmptyTab({activate:false}); retain(id); return id; }, [browser.addEmptyTab, retain]);
  const setVisible = useCallback(id => { void browserHideTabsExcept(id); }, []);
  const host = useMemo(() => ({tabs:browser.tabs, create, retain,
    navigate:browser.navigateToUrl, goBack:browser.goBack, goForward:browser.goForward,
    reload:browser.reload, updateUrl:browser.updateTabUrl, openDevtools:browser.openDevtools, setVisible}),
    [browser.tabs, create, retain, browser.navigateToUrl, browser.goBack, browser.goForward, browser.reload, browser.updateTabUrl, browser.openDevtools, setVisible]);
  return React.createElement(ClientProvider, {client:null, token:"", runtimeStatus:"connecting"},
    React.createElement(DevelopmentView, {visible:true, browserHost:host}));
}
createRoot(document.getElementById("root")).render(React.createElement(${process.env.MONA_SMOKE_NATIVE === "1" ? "NativeWorkbench" : "DevelopmentView"}, {visible:true}));`;
    },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__development_smoke") return next();
        const html = await vite.transformIndexHtml(req.url, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mona development acceptance</title><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`);
        res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html);
      });
    },
  }],
  // Never stop an existing dev server or another verifier to claim its port.
  server: { host: "127.0.0.1", strictPort: false, proxy: {
    "/api/development": { target, changeOrigin: true, headers: { "X-Mona-Token": token } },
  } },
  optimizeDeps: { entries: ["src/components/development/DevelopmentView.tsx", "src/components/MarkdownTextRenderer.tsx"], include: ["react", "react-dom/client", "lucide-react", "zustand"] },
});
await server.listen();
console.log(`SMOKE_URL http://127.0.0.1:${server.httpServer.address().port}/__development_smoke`);
process.stdin.once("data", async () => {
  try { await server.close(); }
  finally { rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  process.exit(0);
});
