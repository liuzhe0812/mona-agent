import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import postcss from "postcss";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "src/components/development/zcode");
const cache = path.join(root, "node_modules/.cache/zcode-stream-css");
await fs.mkdir(cache, { recursive: true });
const cliRoot = await fs.realpath(path.join(root, "node_modules/@tailwindcss/cli"));
const upstreamRequire = createRequire(path.join(cliRoot, "package.json"));
const cssPath = (value) => value.replaceAll("\\", "/");
const source = (await fs.readFile(path.join(sourceDir, "upstream-styles.css"), "utf8"))
  .replace('@import "tailwindcss" source(".");', `@import "${cssPath(upstreamRequire.resolve("tailwindcss/index.css"))}" source(none);`)
  .replace('@source "./**/*.{ts,tsx}";', `@source "${cssPath(sourceDir)}/**/*.{ts,tsx}";\n@source "${cssPath(path.dirname(sourceDir))}/DevelopmentTranscript.tsx";`)
  .replace('@source "../../../node_modules/streamdown/dist/*.js";', `@source "${cssPath(root)}/node_modules/streamdown/dist/*.js";`);
const input = path.join(cache, "input.css");
const output = path.join(cache, "output.css");
await fs.writeFile(input, source);
execFileSync(process.execPath, [path.join(cliRoot, "dist/index.mjs"), "-i", input, "-o", output], { cwd: root, stdio: "inherit" });
const tree = postcss.parse(await fs.readFile(output, "utf8"));
tree.walkAtRules("layer", (rule) => { if (rule.nodes) rule.replaceWith(...rule.nodes); else rule.remove(); });
const keyframes = new Map();
tree.walkAtRules(/keyframes$/, (rule) => {
  const original = rule.params;
  keyframes.set(original, `mona-stream-${original}`);
  rule.params = keyframes.get(original);
});
tree.walkRules((rule) => {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === "rule" || (parent.type === "atrule" && /keyframes$/.test(parent.name))) return;
  }
  const selectors = rule.selectors.filter((selector) => !["html", "body", "#root"].includes(selector));
  if (!selectors.length) { rule.remove(); return; }
  rule.selectors = selectors.map((selector) => {
    if ([":root", ":host"].includes(selector)) return ".zcode-stream";
    if (selector === ".dark") return ".dark .zcode-stream";
    if (selector.startsWith(".dark ")) return selector.replace(".dark ", ".dark .zcode-stream ");
    return `.zcode-stream ${selector}`;
  });
});
tree.walkDecls((decl) => {
  if (decl.prop.startsWith("animation") || decl.prop.startsWith("--animate-")) {
    for (const [original, replacement] of keyframes) decl.value = decl.value.replace(new RegExp(`(?<![\\w-])${original}(?![\\w-])`, "g"), replacement);
  }
});
const compiled = tree.toString().replaceAll("--tw-", "--zcode-tw-")
  // Mona uses Tailwind 3; preserve upstream CSS layers without asking its
  // PostCSS plugin to process Tailwind 4's base/utility layer names.
  .replaceAll("@layer theme, base, components, utilities;", "@layer theme, zcode-base, zcode-components, zcode-utilities;")
  .replaceAll("@layer base {", "@layer zcode-base {")
  .replaceAll("@layer components {", "@layer zcode-components {")
  .replaceAll("@layer utilities {", "@layer zcode-utilities {");
const hostTransformReset = `.zcode-stream, .zcode-stream * {
  --tw-translate-x: 0 !important; --tw-translate-y: 0 !important;
  --tw-rotate: 0 !important; --tw-skew-x: 0 !important; --tw-skew-y: 0 !important;
  --tw-scale-x: 1 !important; --tw-scale-y: 1 !important;
}`;
await fs.writeFile(path.join(sourceDir, "zcode-stream.css"), `${compiled}\n/* Neutralize host Tailwind 3 transforms so upstream translate/rotate/scale applies once. */\n${hostTransformReset}\n`);
