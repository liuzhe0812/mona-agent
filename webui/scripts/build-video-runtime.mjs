import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'node_modules');
const require = createRequire(path.join(moduleRoot, '../package.json'));
const {build} = require('esbuild');
const output = path.resolve(root, '../mona/skills/mona-video/runtime');
await mkdir(output, {recursive: true});
const result = await build({
  entryPoints: [path.join(root, 'video-runtime/scene-host.tsx')],
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
  minify: true, write: false, legalComments: 'linked',
  outfile: path.join(output, 'remotion.js'), nodePaths: [moduleRoot],
  alias: {react: path.join(moduleRoot, 'react'), 'react-dom': path.join(moduleRoot, 'react-dom')},
  define: {'process.env.NODE_ENV': '"production"'},
});
for (const file of result.outputFiles) await writeFile(file.path, file.contents);
console.log('Video animation runtime built.');
