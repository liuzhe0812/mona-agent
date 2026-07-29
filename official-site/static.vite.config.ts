import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 纯静态打包配置：把 app/page.tsx 当作普通 React SPA 入口，输出到 dist-static/
// 用于部署到 VPS nginx 静态服务器（绕过 vinext/cloudflare worker 依赖）
export default defineConfig({
  root: ".",
  publicDir: "public",
  plugins: [react()],
  build: {
    outDir: "dist-static",
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: "static-index.html",
    },
  },
  server: {
    port: 5174,
  },
});
