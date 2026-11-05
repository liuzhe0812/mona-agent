import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { transform } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";

const widgetChannelPlaceholder = "MONA_HOSTED_WIDGET_CHANNEL_PLACEHOLDER";

function hostedWidgetFrame(): Plugin {
  return {
    name: "mona-hosted-widget-frame",
    async generateBundle() {
      const source = await readFile(path.resolve(__dirname, "src/components/visualizer/widget-sandbox.ts"), "utf8");
      const importLine = /^import htmlToImageUmd from ["']html-to-image\/dist\/html-to-image\.js\?raw["'];\r?\n/;
      if (!importLine.test(source)) throw new Error("Unexpected widget sandbox import");
      const umd = await readFile(path.resolve(__dirname, "node_modules/html-to-image/dist/html-to-image.js"), "utf8");
      const compiled = await transform(source.replace(importLine, `const htmlToImageUmd = ${JSON.stringify(umd)};\n`), {
        loader: "ts", format: "cjs", target: "node18",
      });
      const module: { exports: { createWidgetSrcDoc?: (channel: string) => string } } = { exports: {} };
      runInNewContext(compiled.code, { module, exports: module.exports }, { timeout: 1000 });
      const html = module.exports.createWidgetSrcDoc?.(widgetChannelPlaceholder);
      if (typeof html !== "string" || html.split(widgetChannelPlaceholder).length !== 2
        || Buffer.byteLength(html) > 2 * 1024 * 1024) {
        throw new Error("Invalid hosted widget frame template");
      }
      this.emitFile({ type: "asset", fileName: "widget-frame.html", source: html });
    },
  };
}

export default defineConfig({
  base: "/work/",
  plugins: [react(), hostedWidgetFrame()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  cacheDir: path.resolve(__dirname, "node_modules/.vite/hosted-work"),
  build: {
    outDir: path.resolve(__dirname, "dist-hosted-work"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: path.resolve(__dirname, "hosted-work.html") },
  },
});
