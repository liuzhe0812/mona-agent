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
import {bindMotionCanvas} from './motion-canvas';
import {createMotionToolkit} from './huashu-runtime';
import {dashiMotionEffects} from './dashi/motion-effects';

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
const styleVariablesWithoutFallback = (source: string) => {
  const variables = new Set<string>();
  const matches = source.matchAll(/var\s*\(\s*(--mona-[\w-]+)/gi);
  for (const match of matches) {
    const opening = match.index! + match[0].lastIndexOf('(');
    let depth = 1;
    let hasFallback = false;
    for (let index = opening + 1; index < source.length && depth; index++) {
      if (source[index] === '(') depth++;
      else if (source[index] === ')') depth--;
      else if (source[index] === ',' && depth === 1) hasFallback = true;
    }
    if (!hasFallback) variables.add(match[1]);
  }
  return [...variables];
};
const cue = (phrase: string) => {
  const entries = config.track.words?.length ? config.track.words : (config.track.cues || [])
    .flatMap((item: any) => item.words?.length ? item.words : [item]);
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
  'mona-video': {asset, cue, MotionCanvas: bindMotionCanvas(asset, cue), createMotionToolkit, Dashi: dashiMotionEffects},
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
  const spokenText = current?.text || '', words = current?.words || [];
  const displayedWords = Array.isArray(current?.displayWords) ? current.displayWords : words.map((word: any) => word.text);
  const displayText = displayedWords.length > 1 && displayedWords.every((word: unknown) => typeof word === 'string') && displayedWords.join('') === spokenText
    ? displayedWords.map((word: string) => Array.from(word).join('\u2060')).join('') : spokenText;
  caption.textContent = config.showCaptions ? displayText : '';
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
  const captionIsVisible = Boolean(caption.textContent?.trim()) && bounds.width > 0 && bounds.height > 0;
  const textObservations = visible
    .filter((node) => /^(H[123]|P|LI|TEXT)$/.test(node.tagName.toUpperCase()))
    .filter((node) => {
      let opacity = 1;
      for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
        opacity *= Number(getComputedStyle(ancestor).opacity);
        if (opacity <= .1) return false;
      }
      return true;
    })
    .map((node) => {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return null;
      const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
      const overlapWidth = captionIsVisible ? Math.max(0, Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left)) : 0;
      const overlapHeight = captionIsVisible ? Math.max(0, Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top)) : 0;
      return {
        text: text.length > 120 ? `${text.slice(0, 120)}…` : text,
        fontSizePx: Number.parseFloat(css.fontSize) || null,
        overlapsCaption: overlapWidth > 0 && overlapHeight > 0,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .slice(0, 40);
  const scope = [document.documentElement, document.body, document.getElementById('root'), ...nodes];
  const undefinedStyleVariables = styleVariablesWithoutFallback(config.source).filter((variable) =>
    !scope.some((node) => node && getComputedStyle(node).getPropertyValue(variable).trim()),
  );
  const invalidSvgPaths = nodes.filter((node) => node.tagName.toUpperCase() === 'PATH')
    .map((node) => node.getAttribute('d') || '').filter((d) => d.includes('${')).map((d) => d.slice(0, 200));
  const captionRange = document.createRange();
  captionRange.selectNodeContents(caption);
  report({seconds, frame, outside, motionSignature: signature >>> 0,
    captionBounds: bounds.width && bounds.height ? [bounds.left, bounds.top, bounds.right, bounds.bottom] : null,
    captionLineWidths: captionIsVisible ? [...captionRange.getClientRects()].map((rect) => rect.width) : [],
    undefinedStyleVariables, invalidSvgPaths, textObservations});
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
