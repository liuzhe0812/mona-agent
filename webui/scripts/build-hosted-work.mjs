import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const webui = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const office = path.join(webui, "office-editor");
const output = path.join(webui, "dist-hosted-work");
const officeOutput = path.join(output, "office-editor");

function checkOutput(parent, target) {
  if (path.dirname(target) !== parent) throw new Error(`Invalid build destination: ${target}`);
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(target) !== target) {
    throw new Error(`Build destination must be a real directory: ${target}`);
  }
}

function build(cwd, vite, args) {
  const result = spawnSync(process.execPath, [vite, "build", ...args], { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Vite build failed: ${cwd} (${result.status ?? result.signal})`);
}

checkOutput(webui, output);
checkOutput(output, officeOutput);
build(webui, path.join(webui, "node_modules/vite/bin/vite.js"), ["--config", "vite.hosted.config.ts"]);
checkOutput(webui, output);
checkOutput(output, officeOutput);
build(office, path.join(office, "node_modules/vite/bin/vite.js"), ["--outDir", officeOutput, "--emptyOutDir"]);

for (const entry of ["docs", "sheets", "slides"]) {
  if (!existsSync(path.join(officeOutput, entry, "index.html"))) {
    throw new Error(`Office editor entry missing: ${entry}`);
  }
}
