import * as React from 'react';
import {continueRender, delayRender, useCurrentFrame, useVideoConfig} from 'remotion';
import {createMotionToolkit} from './huashu-runtime';
import {dashiMotionEffects} from './dashi/motion-effects';

type Cue = (phrase: string) => {startFrame: number; endFrame: number};
type Toolkit = ReturnType<typeof createMotionToolkit> & {DASHI: typeof dashiMotionEffects};
type Theme = Record<string, string>;
type Draw = (context: CanvasRenderingContext2D, seconds: number, toolkit: Toolkit, clock: {
  frame: number; fps: number; width: number; height: number; theme: Theme; cue: Cue;
}) => void;

export type MotionCanvasProps = {
  draw: Draw;
  assets?: Record<string, string>;
  style?: React.CSSProperties;
};

// Asset IDs are resolved by the host, never by the upstream URL/file loaders.
export function bindMotionCanvas(resolveAsset: (id: string) => string, cue: Cue) {
  return function MotionCanvas({draw, assets = {}, style}: MotionCanvasProps) {
    const frame = useCurrentFrame();
    const {fps, width, height} = useVideoConfig();
    const canvas = React.useRef<HTMLCanvasElement>(null);
    const assetKey = JSON.stringify(assets);
    const [loaded, setLoaded] = React.useState<{
      key: string; images: Record<string, HTMLImageElement>; error?: Error;
    }>({key: '{}', images: {}});

    React.useLayoutEffect(() => {
      if (assetKey === '{}') {
        setLoaded({key: assetKey, images: {}});
        return;
      }
      const handle = delayRender('Preparing scene images');
      let active = true;
      let pending = true;
      const release = () => {if (pending) {pending = false; continueRender(handle);}};
      const images = Object.entries(JSON.parse(assetKey) as Record<string, string>).map(async ([alias, id]) => {
        const image = new Image();
        image.src = resolveAsset(id);
        await image.decode();
        return [alias, image] as const;
      });
      void Promise.all(images).then((entries) => {
        if (active) setLoaded({key: assetKey, images: Object.fromEntries(entries)});
      }, (error: unknown) => {
        if (active) setLoaded({key: assetKey, images: {}, error: error instanceof Error ? error : new Error('画面素材加载失败，请检查这个片段的图片')});
      }).finally(release);
      return () => {active = false; release();};
    }, [assetKey]);

    const toolkit = React.useMemo(() => ({...createMotionToolkit(width, height, {images: loaded.images}), DASHI: dashiMotionEffects}), [width, height, loaded.images]);
    React.useLayoutEffect(() => {
      if (loaded.key !== assetKey || loaded.error) return;
      const node = canvas.current!;
      const context = node.getContext('2d');
      if (!context) throw new Error('画面绘制组件不可用');
      context.reset();
      const css = getComputedStyle(node);
      const theme = Object.fromEntries([
        'primary', 'secondary', 'accent', 'bg', 'surface', 'text-primary', 'text-secondary',
        'border', 'heading-family', 'body-family',
      ].map((name) => [name, css.getPropertyValue(`--mona-${name}`).trim()]));
      context.font = `16px ${theme['body-family']}, sans-serif`;
      context.save();
      try {draw(context, frame / fps, toolkit, {frame, fps, width, height, theme, cue});}
      finally {context.restore();}
    }, [frame, fps, width, height, draw, toolkit, assetKey, loaded]);
    if (loaded.error) throw loaded.error;
    return <canvas ref={canvas} width={width} height={height} style={{width, height, ...style}} />;
  };
}
