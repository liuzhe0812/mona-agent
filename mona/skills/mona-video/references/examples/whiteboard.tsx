import {MotionCanvas} from 'mona-video';

export default function Scene() {
  return <MotionCanvas draw={(ctx, seconds, {DG, CAM}, {fps, width, height, theme, cue}) => {
    const at = cue('建立关系').startFrame / fps;
    const unit = Math.min(width, height) / 1080;
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);
    const board = DG.board({ink: theme['text-primary'], lw: 5 * unit, speed: 600 * unit, font: theme['body-family']});
    board.at(at);
    board.line(DG.ellipsePts(width * .25, height * .38, height * .1, height * .1), {amp: unit});
    board.text('问题', width * .25, height * .4, height * .055, {align: 'center'});
    board.segment([width * .37, height * .38], [width * .63, height * .38], {dur: .9, w: 4 * unit});
    board.line(DG.rectPts(width * .75, height * .38, height * .22, height * .2), {amp: unit});
    board.text('结果', width * .75, height * .4, height * .055, {align: 'center'});
    const camera = CAM.track({x: width * .35, y: height * .42, z: 1.2}, [
      {at: at + 2, kind: 'glide', x: width * .65, y: height * .42, dur: 1.1},
      {at: at + 4, kind: 'pull', x: width / 2, y: height / 2, z: 1, dur: 1.2},
    ], seconds);
    let tip;
    CAM.with(ctx, camera, (g) => {tip = board.draw(g, seconds).tip;});
    if (seconds >= at && seconds < board.cur && tip) {
      const [x, y] = board.penAt(seconds, camera, tip);
      ctx.save(); ctx.translate(x, y); ctx.scale(unit, unit);
      DG.pen(ctx, 0, 0, theme.primary);
      ctx.restore();
    }
  }} />;
}
