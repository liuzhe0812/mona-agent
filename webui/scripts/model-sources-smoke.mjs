// Isolated visual acceptance host: real production components, synthetic accounts/catalog.
// Never reads user config or connects to a model/CLI. Not a production route.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const cacheDir = mkdtempSync(path.join(tmpdir(), "mona-model-sources-smoke-"));
const model = (id, enabled = true) => ({ id, name: id, enabled, type: "chat", context_window: 128000 });
const provider = (name, label, models, extra = {}) => ({ name, label, models, configured: true, api_base: "https://example.invalid/v1", default_api_base: "https://example.invalid/v1", api_key_required: true, api_base_editable: true, ...extra });
const settings = {
  agent: { provider: "openai", model: "GPT-4.1" },
  chat_providers: [
    provider("mona_managed", "Mona AI", [model("deepseek-v4-pro-0813"), model("deepseek-v4.1-flash"), model("glm-5.3"), model("kimi-k3"), model("qwen3.7-plus"), model("qwen3.8-flash"), { ...model("seedream-4.0", false), type: "image" }, { ...model("seedance-2.0", false), type: "video" }], { is_builtin: true, api_key_required: false }),
    provider("openai", "OpenAI", [], { configured: false }),
    provider("anthropic", "Anthropic", [model("Claude Sonnet"), model("Claude Opus")], { configured: false }),
    provider("custom-team", "团队模型服务", [model("团队 · 编程模型"), model("团队 · 代码审查")], { is_custom: true, base_provider: "custom" }),
    provider("deepseek", "DeepSeek", [model("DeepSeek Chat"), model("DeepSeek Reasoner")]),
  ], image_generation: { providers: [] }, video_generation: { providers: [] },
};
const executors = [
  { id: "codex", name: "Codex", available: true, enabled: true, programAvailable: true, executable: "C:/tools/codex.exe", detection: "path", reason: "", probe: { state: "ready", authentication: "ready", authMode: "chatgpt", source: "path", version: "mona_development/0.162.0-alpha Codex CLI/0.46.2 (Windows NT 10.0; Win64; x64)", reason: "" }, models: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"].map(id => ({ id, label: id, description: "Example model description", contextWindow: 272000 })) },
  { id: "claude", name: "Claude Code", available: false, enabled: true, programAvailable: false, reason: "尚未找到本机程序", probe: { state: "not_detected", authentication: "ready", source: "not_detected", reason: "账号已连接，程序尚未检测到" }, models: [{ id: "claude-sonnet-4", label: "Claude Sonnet 4" }] },
  { id: "codebuddy", name: "CodeBuddy", available: true, enabled: true, programAvailable: true, executable: "C:/Mona/runtimes/components/codebuddy/bin/codebuddy.exe", detection: "managed_runtime", reason: "", probe: { state: "ready", authentication: "ready", source: "managed_runtime", version: "codebuddy/1.8.0", protocolVerified: true, modelCatalogState: "ready", reason: "" }, models: [{ id: "buddy-model", label: "CodeBuddy Model", contextWindow: 192000 }] },
];
const executorSettings = {
  revision: "a".repeat(64),
  values: { codexPath: null, claudePath: null, codebuddyPath: null, codebuddyApiKeyEnv: null },
  credentialPresent: { codex: false, claude: false, codebuddy: false },
  enabledEngines: ["codex", "codebuddy"],
};
let savedPaths = { ...executorSettings.values };
const engineResources = {
  codex: { executor: "codex", source: "path", executable: "C:/tools/codex.exe", systemAvailable: true, systemExecutable: "C:/tools/codex.exe", systemVersion: "0.46.2", managedExecutable: null, managedVersion: null, canDelete: false, installed: true, managedInstalled: false, canPrepare: true, canUpdate: false, repairRequired: false, explicitPath: false, packRef: "codex@0.47.0", version: "0.47.0", installedVersion: "0.46.2", downloadBytes: 7_340_032, reason: "检测到系统程序", job: null },
  claude: { executor: "claude", source: "not_detected", executable: null, systemAvailable: false, systemExecutable: null, systemVersion: null, managedExecutable: null, managedVersion: null, canDelete: false, installed: false, managedInstalled: false, canPrepare: true, canUpdate: false, repairRequired: false, explicitPath: false, packRef: "claude@2.1.0", version: "2.1.0", installedVersion: null, downloadBytes: 48_000_000, reason: "尚未找到本机程序。", job: null },
  codebuddy: { executor: "codebuddy", source: "path", executable: "C:/Users/demo/AppData/Local/Programs/CodeBuddy/codebuddy.exe", systemAvailable: true, systemExecutable: "C:/Users/demo/AppData/Local/Programs/CodeBuddy/codebuddy.exe", systemVersion: "2.157.0", managedExecutable: "C:/Mona/runtimes/components/codebuddy/versions/2.162.0/bin/codebuddy.exe", managedVersion: "2.162.0", canDelete: true, installed: true, managedInstalled: true, canPrepare: false, canUpdate: true, repairRequired: false, explicitPath: false, packRef: "codebuddy@2.163.0", version: "2.163.0", installedVersion: "2.157.0", downloadBytes: 76_000_000, reason: "Mona 管理的程序有可用更新。", job: null },
};
const visualJob = { id: "visual-only-job", state: "running", stage: "downloading", downloadedBytes: 2048, totalBytes: 8192 };
const entry = "/__model_sources_entry.js";
const source = `import React from "react";
import {createRoot} from "react-dom/client";
import {ChatProvidersSettings} from "/src/components/settings/ChatProvidersSettings.tsx";
import {ModelSelector} from "/src/components/models/ModelSelector.tsx";
import i18n from "/src/i18n/index.ts";
import "/src/globals.css";
await i18n.changeLanguage("zh-CN");
const data=${JSON.stringify(settings)};
const opts=data.chat_providers.flatMap(p=>p.models.filter(m=>m.enabled).map(m=>({provider:p.name,providerLabel:p.label,model:m.id,label:m.name,active:m.id===data.agent.model,isBuiltin:p.is_builtin,contextWindow:m.context_window,description:p.name==='mona_managed'?'内置模型，按任务选择使用':undefined})));
function App(){const [tab,setTab]=React.useState('settings');const [selected,setSelected]=React.useState('GPT-4.1');return React.createElement('div',{className:'flex h-full flex-col bg-background'},
 React.createElement('header',{className:'flex h-12 shrink-0 items-center gap-5 border-b border-border px-6 text-ui'}, React.createElement('strong',null,'Mona'),React.createElement('span',{className:'text-caption text-muted-foreground'},'界面验收 · 示例模型与账户'),React.createElement('button',{onClick:()=>setTab('settings')},'模型供应商'),React.createElement('button',{onClick:()=>setTab('picker')},'模型选择器')),
 tab==='settings'?React.createElement('main',{className:'flex min-h-0 flex-1 justify-center p-8'},React.createElement('div',{className:'w-full max-w-6xl min-h-0'},React.createElement(ChatProvidersSettings,{settings:data,token:'synthetic-visual',onSettingsChanged:()=>{},onModelNameChange:()=>{}}))):
 React.createElement('main',{className:'flex min-h-0 flex-1 items-end justify-center p-10'},React.createElement('div',{className:'w-full max-w-3xl rounded-2xl border border-border bg-card p-4'},React.createElement('textarea',{className:'h-20 w-full resize-none bg-transparent text-ui outline-none',placeholder:'描述开发任务…'}),React.createElement('div',{className:'flex justify-end'},React.createElement(ModelSelector,{options:opts.map(o=>({...o,active:o.model===selected})),label:selected,onSelect:o=>setSelected(o.model),onManage:()=>setTab('settings')})))));
}
createRoot(document.getElementById('root')).render(React.createElement(App));`;
const server = await createServer({ configFile: false, root, resolve: { alias: { "@": path.join(root, "src") } }, plugins: [react(), {
  name: "model-sources-visual-host",
  resolveId(id) { if (id === entry) return "\0model-sources-visual"; },
  load(id) { if (id === "\0model-sources-visual") return source; },
  configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (req.url?.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      const url = new URL(req.url, "http://127.0.0.1");
      const pathname = url.pathname;
      const send = (value) => res.end(JSON.stringify(value));
      if (req.method === "GET" && pathname === "/api/development/provider-executors") return send({ executors });
      if (req.method === "GET" && pathname === "/api/development/executor-settings") return send({ ...executorSettings, values: savedPaths });
      if (req.method === "PUT" && pathname === "/api/development/executor-settings") {
        let body = "";
        for await (const chunk of req) body += chunk;
        savedPaths = { ...savedPaths, ...(JSON.parse(body).values ?? {}) };
        return send({ ...executorSettings, revision: "b".repeat(64), values: savedPaths });
      }
      if (req.method === "GET" && pathname === "/api/development/engine-resources") {
        const executor = url.searchParams.get("executor");
        return send({ components: engineResources[executor] ? [engineResources[executor]] : [], catalogAvailable: true });
      }
      if (req.method === "DELETE" && pathname.endsWith("/managed-program")) return send({ deleted: true });
      if (pathname.startsWith("/api/development/executors/") && pathname.endsWith("/prepare") && req.method === "POST") {
        return send({ installed: false, job: visualJob });
      }
      if (/^\/api\/development\/executors\/[^/]+\/install\/[^/]+$/.test(pathname)) {
        if (req.method === "DELETE") return send({ ...visualJob, state: "cancelled", stage: "cancelled" });
        if (req.method === "GET") return send(visualJob);
      }
      if (req.url?.includes("/codex/usage/changes")) {
        const timer = setTimeout(() => res.end(JSON.stringify({ revision: 0, identityChanged: false })), 25000);
        timer.unref(); res.once("close", () => clearTimeout(timer)); return;
      }
      if (req.method === "GET" && req.url?.endsWith("/codex/usage")) return send({ revision: 0, connected: true,
        email: "demo@example.invalid", planType: "pro", limits: [{ limitId: "codex", secondary: { usedPercent: 93, windowDurationMins: 10080, resetsAt: Math.floor(Date.now()/1000) + 244800 } }],
        credits: { balance: "62500.00", hasCredits: true, unlimited: false }, availableResets: 1, resetCreditsExpireAt: Math.floor(Date.now()/1000)+604800, fetchedAt: Date.now(), error: null });
      if (req.method === "POST" && pathname.endsWith("/probe")) return send(executors.find(executor => pathname.includes(`/${executor.id}/probe`))?.probe ?? { state: "not_detected", reason: "尚未找到本机程序" });
      if (req.method === "GET" && pathname.endsWith("/login")) return send({ state: "idle", loginId: null, authUrl: "", reason: "" });
      if (req.method === "POST" && pathname.endsWith("/login")) return send({ state: "failed", loginId: null, authUrl: "", reason: "仅提供本地合成登录状态" });
      if (req.method === "POST" && pathname.endsWith("/logout")) return send({ ok: true });
      res.statusCode = 400; return send({ error: { message: "Visual fixture does not execute requests" } }); }
    if (req.url !== "/__model_sources") return next();
    const html = await vite.transformIndexHtml(req.url, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Mona model sources visual acceptance</title><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`);
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html);
  }); },
}], cacheDir, server: {host:"127.0.0.1",port:0,strictPort:true}, optimizeDeps: { entries: ["src/components/settings/ChatProvidersSettings.tsx", "src/components/models/ModelSelector.tsx"], include: ["react","react-dom/client","lucide-react","zustand"] } });
await server.listen();
console.log(`SMOKE_URL http://127.0.0.1:${server.httpServer.address().port}/__model_sources`);
process.stdin.once("data",async()=>{
  try { await server.close(); }
  finally { rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  process.exit(0);
});
