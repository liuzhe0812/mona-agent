import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// 纯静态打包配置：以 static-index.html 为入口，用 react-router 客户端路由承载
// app/ 下所有页面（首页、changelog、tutorial、quick-start），输出到 dist-static/
// 用于部署到 VPS nginx 静态服务器（绕过 vinext/cloudflare worker 依赖）
export default defineConfig({
  root: ".",
  publicDir: "public",
  plugins: [react()],
  resolve: {
    alias: {
      "next/link": fileURLToPath(new URL("./shims/next-link.tsx", import.meta.url)),
      "next/navigation": fileURLToPath(new URL("./shims/next-navigation.tsx", import.meta.url)),
    },
  },
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
