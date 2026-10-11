import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("ZCode CSS compiles with the CLI's Tailwind 4 while Mona keeps Tailwind 3", { timeout: 60000 }, async () => {
  const script = fileURLToPath(new URL("./build-zcode-stream-css.mjs", import.meta.url));
  execFileSync(process.execPath, [script], { stdio: "pipe", timeout: 60000 });

  const host = JSON.parse(await readFile(new URL("../node_modules/tailwindcss/package.json", import.meta.url), "utf8"));
  const css = await readFile(new URL("../src/components/development/zcode/zcode-stream.css", import.meta.url), "utf8");
  assert.match(host.version, /^3\./);
  assert.match(css, /tailwindcss v4\./);
  assert.match(css, /\.zcode-stream/);
});
