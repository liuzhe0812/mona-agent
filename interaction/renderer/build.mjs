import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const output = fileURLToPath(new URL("../mona_interaction/web/vendor/", import.meta.url));
await mkdir(output, { recursive: true });
const shaderFiles = [
  'vertshadersrc.vert', 'vertshadersrcmasked.vert', 'vertshadersrcsetupmask.vert',
  'fragshadersrcsetupmask.frag', 'fragshadersrcpremultipliedalpha.frag',
  'fragshadersrcmaskpremultipliedalpha.frag', 'fragshadersrcmaskinvertedpremultipliedalpha.frag',
  'vertshadersrccopy.vert', 'fragshadersrccopy.frag', 'fragshadersrccolorblend.frag',
  'fragshadersrcalphablend.frag', 'vertshadersrcblend.vert', 'fragshadersrcpremultipliedalphablend.frag',
];
await mkdir(`${output}shaders`, { recursive: true });
for (const name of shaderFiles) {
  await copyFile(new URL(`node_modules/@live2d/framework/Shaders/WebGL/${name}`, import.meta.url),
    `${output}shaders/${name}`);
}
await build({
  absWorkingDir: root,
  entryPoints: ["src/cubism-renderer.js"],
  outfile: `${output}cubism-runtime.js`,
  bundle: true,
  format: "esm",
  target: "chrome120",
  legalComments: "external",
});
await copyFile(new URL("node_modules/@live2d/framework/LICENSE.md", import.meta.url),
  `${output}CubismFramework-LICENSE.md`);
