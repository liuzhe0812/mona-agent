import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import * as Remotion from 'remotion';
import {Player, type PlayerRef} from '@remotion/player';
import * as Shapes from '@remotion/shapes';
import * as Paths from '@remotion/paths';
import * as Transitions from '@remotion/transitions';
import * as Fade from '@remotion/transitions/fade';
import * as Slide from '@remotion/transitions/slide';
import * as Wipe from '@remotion/transitions/wipe';
import * as Babel from '@babel/standalone';

// This bundle runs only inside an opaque, network-disabled scene iframe.
const config = (window as any).__monaRemotion;
const fps = config.fps;
const player = React.createRef<PlayerRef>();
let failure = '';
const report = (data: object) => window.parent.postMessage({type: 'mona-scene-report', ...data}, '*');
const fail = (error: unknown) => {
  failure = error instanceof Error ? error.message : String(error);
  report({error: failure});
};
window.addEventListener('error', (event) => fail(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => fail(event.reason));

const asset = (id: string) => {
  const source = config.assets[id];
  if (!source) throw new Error(`素材未添加到这个片段: ${id}`);
  return source;
};
const normalize = (text: string) => text.replace(/[\s，。！？、；：,.!?;:]/g, '');
const cue = (phrase: string) => {
  const entries = config.track.words?.length ? config.track.words : config.track.cues || [];
  const text = entries.map((entry: any) => normalize(entry.text)).join('');
  const wanted = normalize(phrase);
  const start = wanted ? text.indexOf(wanted) : -1;
  if (start < 0) throw new Error(`旁白中找不到动画对应的内容: ${phrase}`);
  let offset = 0;
  let startMs = 0;
  let endMs = 0;
  for (const entry of entries) {
    const length = normalize(entry.text).length;
    if (offset <= start && start < offset + length) startMs = entry.startMs;
    if (offset < start + wanted.length && start + wanted.length <= offset + length) endMs = entry.endMs;
    offset += length;
  }
  return {startFrame: Math.floor(startMs * fps / 1000), endFrame: Math.ceil(endMs * fps / 1000)};
};
const modules: Record<string, any> = {
  react: React, remotion: Remotion, '@remotion/shapes': Shapes, '@remotion/paths': Paths,
  '@remotion/transitions': Transitions, '@remotion/transitions/fade': Fade,
  '@remotion/transitions/slide': Slide, '@remotion/transitions/wipe': Wipe,
  'mona-video': {asset, cue},
};
const load = (id: string) => {
  if (!Object.hasOwn(modules, id)) throw new Error(`这个片段不支持导入: ${id}`);
  return modules[id];
};

class SceneBoundary extends React.Component<{children: React.ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() { return {failed: true}; }
  componentDidCatch(error: Error) { fail(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const seek = async (seconds: number) => {
  if (failure) throw new Error(failure);
  if (!player.current) throw new Error('动画场景尚未就绪');
  const frame = Math.max(0, Math.min(config.durationInFrames - 1, Math.floor(seconds * fps)));
  flushSync(() => player.current!.seekTo(frame));
  await document.fonts.ready;
  await nextPaint();
  const deadline = Date.now() + 10000;
  while ((window as any).remotion_delayRenderHandles?.length) {
    if (failure) throw new Error(failure);
    if (Date.now() > deadline) throw new Error('动画素材准备超时');
    await nextPaint();
  }
  await nextPaint();
  await Promise.all([...document.images].map(async (image) => {
    try { await image.decode(); } catch { throw new Error('图片素材加载失败'); }
  }));
  if (document.querySelector('audio') || [...document.querySelectorAll<HTMLVideoElement>('video')].some((media) => !media.muted)) {
    throw new Error('片段内的声音没有进入工作台混音，请使用项目旁白和音乐，视频素材需静音');
  }
  for (const media of document.querySelectorAll<HTMLVideoElement>('video')) {
    if (media.seeking || media.readyState < 2) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {cleanup(); reject(new Error('视频素材定位超时'));}, 10000);
        const ready = () => { if (!media.seeking && media.readyState >= 2) {cleanup(); resolve();} };
        const cleanup = () => {
          clearTimeout(timer); media.removeEventListener('seeked', ready); media.removeEventListener('loadeddata', ready);
        };
        media.addEventListener('seeked', ready); media.addEventListener('loadeddata', ready); ready();
      });
    }
  }
  if (failure) throw new Error(failure);
  const current = (config.track.cues || []).find((item: any) => seconds * 1000 >= item.startMs && seconds * 1000 < item.endMs);
  const caption = document.getElementById('mona-subtitles')!;
  caption.textContent = config.showCaptions ? current?.text || '' : '';
  const nodes = [...document.querySelectorAll<HTMLElement>('#root *')];
  const visible = nodes.filter((node) => {
    const css = getComputedStyle(node), r = node.getBoundingClientRect();
    return Number(css.opacity) > 0.1 && css.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  });
  const outside = visible.filter((node) => /^(H[123]|P|LI|TEXT)$/.test(node.tagName.toUpperCase())).filter((node) => {
    const r = node.getBoundingClientRect();
    return r.left < -1 || r.top < -1 || r.right > config.width + 1 || r.bottom > config.height + 1;
  }).map((node) => node.textContent);
  // Exclude captions: changing subtitle text must not certify a static slide as animation.
  const state = visible.map((node) => {
    const r = node.getBoundingClientRect(), css = getComputedStyle(node);
    return [node.tagName, r.x, r.y, r.width, r.height, css.opacity, css.transform, css.color,
      css.backgroundColor, css.fill, css.stroke, css.strokeDashoffset, node.getAttribute('d'),
      node instanceof HTMLCanvasElement ? node.toDataURL() : node.textContent,
      node instanceof HTMLVideoElement ? node.currentTime : null];
  });
  let signature = 2166136261;
  for (const char of JSON.stringify(state)) signature = Math.imul(signature ^ char.charCodeAt(0), 16777619);
  const bounds = caption.getBoundingClientRect();
  report({seconds, frame, outside, motionSignature: signature >>> 0,
    captionBounds: bounds.width && bounds.height ? [bounds.left, bounds.top, bounds.right, bounds.bottom] : null});
};

try {
  const compiled = Babel.transform(config.source, {
    filename: 'scene.tsx', presets: [['typescript', {allExtensions: true, isTSX: true}], ['react', {runtime: 'classic'}]],
    plugins: ['transform-modules-commonjs'], sourceType: 'module',
  }).code;
  const exports: Record<string, any> = {};
  const module = {exports};
  new Function('require', 'module', 'exports', 'React', compiled!)(load, module, exports, React);
  const Scene = module.exports.default;
  if (typeof Scene !== 'function') throw new Error('片段需要默认导出一个 React 动画组件');
  createRoot(document.getElementById('root')!).render(
    <SceneBoundary><Player ref={player} component={Scene} inputProps={{scene: config.scene, track: config.track}}
      durationInFrames={config.durationInFrames} fps={fps} compositionWidth={config.width} compositionHeight={config.height}
      numberOfSharedAudioTags={0}
      controls={false} style={{width: config.width, height: config.height}}
      errorFallback={({error}) => {fail(error); return null;}} /></SceneBoundary>,
  );
  window.addEventListener('message', async (event) => {
    if (event.source !== window.parent || event.data?.type !== 'mona-scene-seek') return;
    try {
      await seek(Number(event.data.seconds) || 0);
      window.parent.postMessage({type: 'mona-scene-seeked', requestId: event.data.requestId}, '*');
    } catch (error) { fail(error); window.parent.postMessage({type: 'mona-scene-seeked', requestId: event.data.requestId, error: failure}, '*'); }
  });
  void nextPaint().then(() => {
    if (!failure) window.parent.postMessage({type: 'mona-scene-ready'}, '*');
  });
} catch (error) { fail(error); }
