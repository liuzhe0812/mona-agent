import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { shellPath, shellQuote } from "./shellQuote";

function findShell(): string | undefined {
  if (process.platform !== "win32") return existsSync("/bin/sh") ? "/bin/sh" : undefined;
  try {
    const gitCore = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    const gitRoot = resolve(gitCore, "../../..");
    return [join(gitRoot, "usr", "bin", "sh.exe"), join(gitRoot, "bin", "sh.exe")].find(existsSync);
  } catch {
    return undefined;
  }
}

const shell = findShell();

describe("remote shell arguments", () => {
  it.skipIf(!shell)("preserves quotes, substitutions and leading dashes as data", () => {
    for (const value of ["a'b;$(printf injected)", "-file", "line 1\nline 2", "a`echo injected`b"]) {
      const result = spawnSync(shell!, ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(value);
    }
  });

  it.skipIf(!shell)("expands the remote home while keeping its path literal", () => {
    const result = spawnSync(shell!, ["-c", `printf '%s' ${shellPath("~/a'b;$(printf injected)")}`], {
      encoding: "utf8",
      env: { ...process.env, HOME: "/tmp/remote home" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("/tmp/remote home/a'b;$(printf injected)");
  });
});
