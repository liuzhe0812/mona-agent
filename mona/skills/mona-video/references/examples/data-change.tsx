import {MotionCanvas} from 'mona-video';

// Demonstration values only; replace with verified data from the approved plan.
const values = [2, 4, 7];
export default function Scene() {
  return <MotionCanvas draw={(ctx, seconds, {CH, MO}, {fps, width, height, theme, cue}) => {
    const spoken = cue('增长');
    const p = MO.seg(seconds, spoken.startFrame / fps, spoken.endFrame / fps);
    const box = {x: width * .15, y: height * .18, w: width * .65, h: height * .48};
    const scale = CH.lin(0, 10, box.y + box.h, box.y);
    const font = `${height * .04}px ${theme['body-family']}, sans-serif`;
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);
    CH.grid(ctx, box, [0, 5, 10], scale, 1, {col: theme.border, zeroCol: theme['text-primary'], font, labelCol: theme['text-secondary']});
    CH.bars(ctx, values.map((v, i) => ({x: width * (.27 + i * .2), v})), scale, width * .1, p, {
      col: theme.primary, lag: .1, hi: 2, hiP: MO.seg(p, .8, 1),
      hiCol: theme.accent, dimCol: theme.border, font, labelCol: theme['text-primary'],
    });
    ctx.fillStyle = theme['text-secondary'];
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.fillText('示意数据', width * .5, height * .76);
  }} />;
}
