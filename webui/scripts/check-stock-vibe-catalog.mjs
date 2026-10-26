import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const checker = path.join(root, "tools/stock_vibe/export_builtin_catalog.py");
const pythonPaths = process.platform === "win32"
  ? [".venv/Scripts/python.exe", ".venv/bin/python", ".venv/bin/python3"]
  : [".venv/bin/python", ".venv/bin/python3", ".venv/Scripts/python.exe"];
const candidates = [
  ...pythonPaths.map((relative) => path.join(root, relative)),
  process.platform === "win32" ? "python" : "python3",
  "python",
];

for (const python of candidates) {
  if (python.includes(path.sep) && !existsSync(python)) continue;
  const result = spawnSync(python, [checker, "--check"], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error?.code === "ENOENT") continue;
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (process.exitCode !== 0) {
    console.error("To regenerate the catalog, run `python tools/stock_vibe/export_builtin_catalog.py` from the repository root. Generation requires the managed stock-vibe runtime.");
  }
  process.exit();
}

console.error("Python is required to check the built-in stock catalog. Run the repository catalog exporter with --check.");
process.exitCode = 1;
