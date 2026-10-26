import {access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../mona/skills/mona-video');
for (const file of ['runtime/mona-player.js', 'assets/huashu-motion/runtime/om.js',
  'assets/huashu-motion/runtime/om-engine.js', 'assets/huashu-motion/templates/blank/vendor/gsap.min.js']) {
  await access(path.join(root, file));
}
console.log('Huashu Motion runtime resources verified.');
