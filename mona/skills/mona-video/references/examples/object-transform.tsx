import {MotionCanvas} from 'mona-video';

export default function Scene() {
  return <MotionCanvas draw={(ctx, seconds, {DG, MO, CAM}, {fps, width, height, theme, cue}) => {
    const spoken = cue('改变形状');
    const at = spoken.startFrame / fps;
    const end = spoken.endFrame / fps;
    const p = MO.smooth(MO.seg(seconds, at, end));
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);
    const center = [width * .5, height * .42];
    const radius = Math.min(width, height) * .19;
    const circle = DG.circlePts(center[0], center[1], radius, 64);
    const square = DG.rectPts(center[0], center[1], radius * 1.8, radius * 1.8, 64);
    const points = DG.morph(circle, square, p);
    const camera = CAM.track({x: width / 2, y: height / 2, z: 1}, [
      {at: end, kind: 'push', x: center[0], y: center[1], k: .12, dur: 1},
      {at: end + 2, kind: 'pull', x: width / 2, y: height / 2, z: 1, dur: 1.2},
    ], seconds);
    CAM.with(ctx, camera, (g) => DG.shape(g, points, {fill: theme.primary}));
    ctx.fillStyle = theme['text-primary'];
    ctx.textAlign = 'center';
    ctx.font = `600 ${Math.min(width, height) * .065}px ${theme['heading-family']}, sans-serif`;
    ctx.fillText(p < .5 ? '同一个对象' : '发生改变', width * .5, height * .74);
  }} />;
}
