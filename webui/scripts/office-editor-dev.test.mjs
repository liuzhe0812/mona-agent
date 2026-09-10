import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import { officeEditorDev } from "./office-editor-dev.mjs";

test("one dev server serves every Office entry and its modules", { timeout: 60000 }, async () => {
  const webuiRoot = fileURLToPath(new URL("../", import.meta.url));
  const cacheDir = await mkdtemp(resolve(tmpdir(), "mona-office-dev-"));
  const server = await createServer({
    configFile: false,
    root: webuiRoot,
    cacheDir,
    plugins: [officeEditorDev(resolve(webuiRoot, "office-editor"))],
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    const address = server.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    for (const kind of ["docs", "sheets", "slides"]) {
      const response = await fetch(`${origin}/office-editor/${kind}/index.html`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /\/office-editor\/@vite\/client/);
      const entry = await fetch(`${origin}/office-editor/${kind}/index.tsx`);
      assert.equal(entry.status, 200);
      assert.match(entry.headers.get("content-type"), /javascript/);
      const source = await entry.text();
      const editorModule = source.match(/"(\/office-editor\/@fs\/[^"\n]+)"/);
      assert.ok(editorModule);
      const moduleResponse = await fetch(new URL(editorModule[1], origin));
      assert.equal(moduleResponse.status, 200);
      assert.match(moduleResponse.headers.get("content-type"), /javascript/);
    }
    const client = await fetch(`${origin}/office-editor/@vite/client`);
    assert.equal(client.status, 200);
    assert.match(await client.text(), /office-editor-hmr/);
    const refresh = await fetch(`${origin}/office-editor/@react-refresh`);
    assert.equal(refresh.status, 200);
    assert.match(refresh.headers.get("content-type"), /javascript/);
  } finally {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
