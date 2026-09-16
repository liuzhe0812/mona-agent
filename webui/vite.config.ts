import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { alphaTab } from "@coderline/alphatab-vite";
import path from "node:path";
import { officeEditorDev } from "./scripts/office-editor-dev.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.mona_API_URL ?? "http://127.0.0.1:8765";
  const gatewayTarget = env.mona_GATEWAY_URL ?? "http://127.0.0.1:18790";
  const isTauriBuild = mode === "tauri";

  return {
    plugins: [
      alphaTab({ assetOutputDir: false }),
      officeEditorDev(path.resolve(__dirname, "office-editor")),
      react(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    optimizeDeps: {
      entries: ["index.html"],
      include: ["@xyflow/react", "@dagrejs/dagre", "html-to-image"],
      exclude: ["@radix-ui/react-dialog", "@novnc/novnc"],
    },
    build: {
      target: "esnext",
      outDir: isTauriBuild
        ? path.resolve(__dirname, "../src-tauri/dist")
        : path.resolve(__dirname, "./dist"),
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/refractor/lang/")) {
              return;
            }
            if (
              id.includes("node_modules/react-syntax-highlighter")
              || id.includes("node_modules/refractor/core")
            ) {
              return "syntax-highlight";
            }
            if (
              id.includes("node_modules/react-markdown")
              || id.includes("node_modules/remark-")
              || id.includes("node_modules/rehype-")
              || id.includes("node_modules/unified")
              || id.includes("node_modules/mdast-")
              || id.includes("node_modules/hast-")
              || id.includes("node_modules/micromark")
              || id.includes("node_modules/unist-")
            ) {
              return "markdown-vendor";
            }
            if (id.includes("node_modules/katex")) {
              return "katex";
            }
          },
        },
      },
    },
    server: {
      host: "127.0.0.1",
      port: 9527,
      strictPort: true,
      watch: {
        ignored: ["**/office-editor/**"],
      },
      proxy: {
        // Sidebar-state writes only exist on the gateway (aiohttp, JSON body);
        // the ws server's process_request cannot read POST bodies, so in dev
        // this route must bypass the generic /api target or every read marker
        // write fails with 400 and all sessions flip back to unread.
        "/api/webui/sidebar-state/update": {
          target: gatewayTarget,
          changeOrigin: true,
        },
        "/webui": { target, changeOrigin: true },
        "/api": { target, changeOrigin: true },
        "/auth": { target, changeOrigin: true },
      },
    },
    test: {
      environment: "happy-dom",
      globals: true,
      setupFiles: ["./src/tests/setup.ts"],
    },
  };
});
