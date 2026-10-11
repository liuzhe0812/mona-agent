import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer, resolveConfig } from "vite";

test("an auxiliary Vite server cannot invalidate dependencies of unvisited app modules", { timeout: 60000 }, async () => {
  const webuiRoot = fileURLToPath(new URL("../", import.meta.url));
  const configFile = path.join(webuiRoot, "vite.config.ts");
  const appConfig = await resolveConfig({ root: webuiRoot, configFile }, "serve");
  const testConfig = await resolveConfig({ root: webuiRoot, configFile, mode: "test" }, "serve");
  assert.notEqual(appConfig.cacheDir, testConfig.cacheDir);

  const root = await mkdtemp(path.join(tmpdir(), "mona-vite-cache-test-"));
  const servers = [];
  try {
    await writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await writeFile(path.join(root, "app.js"), 'export { createRoot } from "react-dom/client";');
    await writeFile(path.join(root, "auxiliary.js"), 'export { useState } from "react";');
    const shared = {
      configFile: false,
      root,
      logLevel: "silent",
      resolve: { alias: [
        { find: "react-dom/client", replacement: path.join(webuiRoot, "node_modules/react-dom/client.js") },
        { find: /^react$/, replacement: path.join(webuiRoot, "node_modules/react/index.js") },
      ] },
      server: { host: "127.0.0.1", port: 0, hmr: false, preTransformRequests: false, fs: { allow: [root, webuiRoot] } },
    };
    const start = async (options) => {
      const server = await createServer({ ...shared, ...options });
      servers.push(server);
      await server.listen();
      return `http://127.0.0.1:${server.httpServer.address().port}`;
    };
    const loadDependency = async (origin, entry, load = true) => {
      const response = await fetch(`${origin}/${entry}`);
      assert.equal(response.status, 200);
      const source = await response.text();
      const dependency = source.match(/"([^"\n]+\?v=[a-f0-9]+)"/);
      assert.ok(dependency, source);
      const url = new URL(dependency[1], origin);
      if (load) {
        const loaded = await fetch(url);
        assert.equal(loaded.status, 200, url.href);
        await loaded.text();
      }
      return url;
    };

    // Mirror the real app cache layout inside a disposable root.
    const cacheDir = path.resolve(root, path.relative(webuiRoot, appConfig.cacheDir));
    const app = await start({ cacheDir, optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client"] } });
    await loadDependency(app, "auxiliary.js");
    const loadedUrl = await loadDependency(app, "app.js", false);
    const metadataPath = path.join(cacheDir, "deps/_metadata.json");
    const metadata = await readFile(metadataPath, "utf8");

    const auxiliary = await start({ optimizeDeps: { noDiscovery: true, include: ["react"] } });
    await loadDependency(auxiliary, "auxiliary.js");

    const stillLoaded = await fetch(loadedUrl);
    assert.equal(stillLoaded.status, 200, "switching modules must work after another server's pre-bundle");
    await stillLoaded.text();
    assert.equal(await readFile(metadataPath, "utf8"), metadata);
  } finally {
    await Promise.all(servers.map((server) => server.close()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
