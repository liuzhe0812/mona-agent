import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function officeEditorDev(officeRoot) {
  let editor;
  return {
    name: "mona-office-editor-dev",
    apply: "serve",
    async configureServer(host) {
      if (host.config.mode === "test") return;
      // Keep the editor's Vite/React plugins and aliases in its own package.
      const { createServer } = await import(pathToFileURL(
        resolve(officeRoot, "node_modules/vite/dist/node/index.js"),
      ).href);
      editor = await createServer({
        configFile: resolve(officeRoot, "vite.config.ts"),
        cacheDir: resolve(host.config.cacheDir, "office-editor"),
        base: "/office-editor/",
        appType: "mpa",
        server: {
          middlewareMode: true,
          hmr: host.httpServer ? { server: host.httpServer, path: "office-editor-hmr" } : false,
        },
      });
      host.middlewares.use((request, response, next) => {
        if (request.url?.startsWith("/office-editor/")) {
          editor.middlewares(request, response, next);
        } else {
          next();
        }
      });
    },
    async closeBundle() {
      await editor?.waitForRequestsIdle();
      const optimizer = editor?.environments.client.depsOptimizer;
      await optimizer?.scanProcessing;
      await Promise.resolve();
      await Promise.all(
        Object.values(optimizer?.metadata.discovered ?? {})
          .map((dependency) => dependency.processing)
          .filter(Boolean),
      );
      await editor?.close();
    },
  };
}
