// The crop screen for photos and pasted pictures: drag the four corners to
// the page edges, rotate, and choose "Clean up" (scanner look). Returns the
// straightened page as a canvas, and whether the student wants another page.

import { $ } from './ui.js';
import { rotateCanvas, warpQuad, enhanceDocument } from './image-tools.js';

const HANDLE_HIT = 36; // finger-friendly grab radius, in screen pixels

/**
 * @param {HTMLCanvasElement} source
 * @param {{fullFrame?: boolean, enhance?: boolean, pageNumber?: number}} opts
 * @returns {Promise<null | {canvas: HTMLCanvasElement, another: boolean}>}
 */
export function cropImage(source, { fullFrame = false, enhance = true, pageNumber = 1 } = {}) {
  return new Promise(resolve => {
    const screen = $('#crop');
    const stage = $('#crop-stage');
    const canvas = $('#crop-canvas');
    const enhanceBox = $('#crop-enhance');
    $('#crop-title').textContent = pageNumber > 1 ? `Page ${pageNumber}: line up the corners` : 'Line up the corners with the page';
    enhanceBox.checked = enhance;

    let src = source;
    let quad;          // corners in source pixels: tl, tr, br, bl
    let view;          // {scale, ox, oy} source → screen
    let dragging = -1;

    const defaultQuad = full => {
      const w = src.width, h = src.height;
      const m = full ? 0 : 0.06;
      return [[w * m, h * m], [w * (1 - m), h * m], [w * (1 - m), h * (1 - m)], [w * m, h * (1 - m)]];
    };

    const layout = () => {
      const r = stage.getBoundingClientRect();
      const pad = 28;
      const scale = Math.min((r.width - pad * 2) / src.width, (r.height - pad * 2) / src.height);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = r.width + 'px';
      canvas.style.height = r.height + 'px';
      view = { scale, ox: (r.width - src.width * scale) / 2, oy: (r.height - src.height * scale) / 2, dpr };
      draw();
    };

    const toScreen = ([x, y]) => [view.ox + x * view.scale, view.oy + y * view.scale];
    const toSource = (sx, sy) => [
      Math.min(src.width, Math.max(0, (sx - view.ox) / view.scale)),
      Math.min(src.height, Math.max(0, (sy - view.oy) / view.scale)),
    ];

    const draw = () => {
      const ctx = canvas.getContext('2d');
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(src, view.ox, view.oy, src.width * view.scale, src.height * view.scale);
      const pts = quad.map(toScreen);
      // Dim everything outside the page.
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.moveTo(...pts[0]); pts.slice(1).forEach(p => ctx.lineTo(...p)); ctx.closePath();
      ctx.fill('evenodd');
      ctx.restore();
      ctx.strokeStyle = '#1D9E75';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(...pts[0]); pts.slice(1).forEach(p => ctx.lineTo(...p)); ctx.closePath();
      ctx.stroke();
      pts.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p[0], p[1], i === dragging ? 18 : 14, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.stroke();
      });
    };

    const pointerPos = e => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    const onDown = e => {
      const [x, y] = pointerPos(e);
      let best = -1, bestD = HANDLE_HIT;
      quad.map(toScreen).forEach((p, i) => {
        const d = Math.hypot(p[0] - x, p[1] - y);
        if (d < bestD) { best = i; bestD = d; }
      });
      if (best < 0) return;
      dragging = best;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      draw();
    };
    const onMove = e => {
      if (dragging < 0) return;
      const [x, y] = pointerPos(e);
      quad[dragging] = toSource(x, y);
      draw();
    };
    const onUp = () => { dragging = -1; draw(); };

    const rotate = dir => {
      src = rotateCanvas(src, dir);
      quad = defaultQuad(fullFrame);
      layout();
    };

    const finish = async another => {
      cleanup();
      const busy = $('#crop-busy');
      busy.hidden = false;
      await new Promise(r => setTimeout(r, 30)); // let "Straightening…" paint
      let out = warpQuad(src, quad);
      if (enhanceBox.checked) out = enhanceDocument(out);
      busy.hidden = true;
      screen.hidden = true;
      resolve({ canvas: out, another });
    };

    const cancel = () => { cleanup(); screen.hidden = true; resolve(null); };

    const handlers = [
      [canvas, 'pointerdown', onDown], [canvas, 'pointermove', onMove],
      [canvas, 'pointerup', onUp], [canvas, 'pointercancel', onUp],
      [window, 'resize', layout],
      [$('#crop-rotate-left'), 'click', () => rotate(-1)],
      [$('#crop-rotate-right'), 'click', () => rotate(1)],
      [$('#crop-full'), 'click', () => { quad = defaultQuad(true); draw(); }],
      [$('#crop-cancel'), 'click', cancel],
      [$('#crop-done'), 'click', () => finish(false)],
      [$('#crop-another'), 'click', () => finish(true)],
    ];
    const cleanup = () => handlers.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
    handlers.forEach(([el, ev, fn]) => el.addEventListener(ev, fn));

    screen.hidden = false;
    quad = defaultQuad(fullFrame);
    requestAnimationFrame(layout);
  });
}
