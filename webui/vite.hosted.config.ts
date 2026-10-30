import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "/work/",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  cacheDir: path.resolve(__dirname, "node_modules/.vite/hosted-work"),
  build: {
    outDir: path.resolve(__dirname, "dist-hosted-work"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: path.resolve(__dirname, "hosted-work.html") },
  },
});
