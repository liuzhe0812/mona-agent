// Mona's isolated bridge around the Mona Motion clock.
(() => {
  const film = window.__monaFilm;
  let failed = '';
  const send = value => window.parent.postMessage(value, '*');
  const fail = error => {failed = String(error?.message || error);send({type: 'mona-scene-report', error: failed});};
  window.addEventListener('error', event => fail(event.error || event.message));
  window.addEventListener('unhandledrejection', event => fail(event.reason));
  const ready = new Promise((resolve, reject) => {
    window.addEventListener('load', async () => {
      const deadline = performance.now() + 20000;
      while (!window.__omReady) {
        if (failed || window.__omBootFailed) {reject(new Error(failed || window.__omBootFailed));return;}
        if (performance.now() > deadline) {reject(new Error('动画素材准备超时'));return;}
        await new Promise(done => setTimeout(done, 10));
      }
      const caption = document.createElement('div');caption.id = 'mona-subtitles';document.body.appendChild(caption);
      send({type: 'mona-scene-ready'});resolve();
    });
  });
  ready.catch(fail);
  let queue = Promise.resolve();
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'mona-scene-seek') return;
    const {seconds, requestId} = event.data;
    queue = queue.catch(() => {}).then(async () => {
      try {
        await ready;if (failed) throw new Error(failed);
        await window.__omEngine.seek(seconds);
        if (window.CLIP?.problems?.length) throw new Error(window.CLIP.problems.join('; '));
        const caption = document.getElementById('mona-subtitles');
        const cue = film.cues.find(item => seconds * 1000 >= item.startMs && seconds * 1000 < item.endMs);
        caption.textContent = cue?.text || '';
        const bounds = caption.getBoundingClientRect();
        const nodes = [...document.querySelectorAll('body *')].filter(node => {
          if (node === caption || caption.contains(node) || /^(SCRIPT|STYLE)$/.test(node.tagName)) return false;
          const css = getComputedStyle(node), box = node.getBoundingClientRect();
          return css.display !== 'none' && css.visibility !== 'hidden' && Number(css.opacity) > .1 && box.width > 0 && box.height > 0;
        });
        const texts = nodes.filter(node => /^(H[1-6]|P|LI|TEXT|SPAN|DIV)$/.test(node.tagName) && node.childElementCount === 0 && node.textContent.trim());
        const outside = texts.filter(node => {const r = node.getBoundingClientRect();return r.left < -1 || r.top < -1 || r.right > film.width + 1 || r.bottom > film.height + 1;}).map(node => node.textContent);
        const textObservations = texts.slice(0, 40).map(node => {
          const r = node.getBoundingClientRect();return {text: node.textContent.slice(0, 120),fontSizePx: parseFloat(getComputedStyle(node).fontSize),overlapsCaption: !!cue && r.left < bounds.right && r.right > bounds.left && r.top < bounds.bottom && r.bottom > bounds.top};
        });
        const state = nodes.map(node => {
          const r = node.getBoundingClientRect(), css = getComputedStyle(node);
          return [node.tagName,r.x,r.y,r.width,r.height,css.opacity,css.transform,css.color,css.backgroundColor,node.getAttribute('d'),node instanceof HTMLCanvasElement ? node.toDataURL() : node.childElementCount ? '' : node.textContent];
        });
        let signature = 2166136261;for (const char of JSON.stringify(state)) signature = Math.imul(signature ^ char.charCodeAt(0),16777619);
        const range = document.createRange();range.selectNodeContents(caption);
        const scope = [document.documentElement, document.body, ...nodes];
        const undefinedStyleVariables = film.styleVariables.filter(name => !scope.some(node => getComputedStyle(node).getPropertyValue(name).trim()));
        const invalidSvgPaths = nodes.filter(node => node.tagName.toLowerCase() === 'path')
          .map(node => node.getAttribute('d') || '').filter(path => path.includes('${'));
        send({type: 'mona-scene-report',seconds,outside,motionSignature: signature >>> 0,textObservations,
          captionBounds: cue ? [bounds.left,bounds.top,bounds.right,bounds.bottom] : null,
          captionLineWidths: cue ? [...range.getClientRects()].map(r => r.width) : [],undefinedStyleVariables,invalidSvgPaths});
        send({type: 'mona-scene-seeked',requestId});
      } catch (error) {fail(error);send({type: 'mona-scene-seeked',requestId,error: failed});}
    });
  });
})();
