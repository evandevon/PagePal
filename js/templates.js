// Blank pages students can write on: lined, handwriting, story, grids, dots.
// Drawn on the device as A4 portrait pictures (200 dots per inch), so they
// need no downloads and print at the right size.

export const A4 = { width: 1654, height: 2339 }; // 210 × 297 mm at 200 dpi
const MM = A4.width / 210;

const INK = '#9DB8D9';        // soft blue printed lines
const DARK = '#6C8EBF';
const MARGIN_RED = '#E8A0A0';

function header(ctx, w) {
  // "Name ____  Date ____" across the top, like school exercise paper.
  ctx.fillStyle = '#7A8794';
  ctx.font = `${4.5 * MM}px Arial, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  const y = 16 * MM;
  ctx.fillText('Name', 15 * MM, y);
  ctx.fillText('Date', w - 75 * MM, y);
  ctx.strokeStyle = '#B9C3CC';
  ctx.lineWidth = 2;
  line(ctx, 32 * MM, y + 1, w - 85 * MM, y + 1);
  line(ctx, w - 62 * MM, y + 1, w - 15 * MM, y + 1);
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function ruled(ctx, w, h, { gapMm, topMm = 30, margin = true, from = 0 }) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.5;
  for (let y = Math.max(from, topMm * MM); y < h - 12 * MM; y += gapMm * MM) line(ctx, 10 * MM, y, w - 10 * MM, y);
  if (margin) {
    ctx.strokeStyle = MARGIN_RED;
    line(ctx, 25 * MM, (from || topMm * MM) - gapMm * MM, 25 * MM, h - 10 * MM);
  }
}

function handwriting(ctx, w, h, { from = 28 * MM, xMm = 7 } = {}) {
  // Sets of three: top (ascender) line, dashed middle line, solid baseline;
  // the space below the baseline is for descenders.
  const x = xMm * MM, setGap = xMm * 1.2 * MM;
  for (let top = from; top + 3 * x < h - 10 * MM; top += 3 * x + setGap) {
    ctx.setLineDash([]);
    ctx.strokeStyle = INK; ctx.lineWidth = 2.5;
    line(ctx, 10 * MM, top, w - 10 * MM, top);
    ctx.setLineDash([14, 12]);
    ctx.strokeStyle = INK; ctx.lineWidth = 2;
    line(ctx, 10 * MM, top + x, w - 10 * MM, top + x);
    ctx.setLineDash([]);
    ctx.strokeStyle = DARK; ctx.lineWidth = 3.5;
    line(ctx, 10 * MM, top + 2 * x, w - 10 * MM, top + 2 * x);
    ctx.strokeStyle = '#D5E1EF'; ctx.lineWidth = 1.5;
    line(ctx, 10 * MM, top + 3 * x, w - 10 * MM, top + 3 * x);
  }
}

function grid(ctx, w, h, mm, { boldEvery = 0 } = {}) {
  const step = mm * MM;
  const x0 = (w - Math.floor((w - 20 * MM) / step) * step) / 2;
  const y0 = 22 * MM;
  const x1 = w - x0, y1 = y0 + Math.floor((h - y0 - 12 * MM) / step) * step;
  let n = 0;
  for (let x = x0; x <= x1 + 1; x += step, n++) {
    ctx.strokeStyle = boldEvery && n % boldEvery === 0 ? DARK : INK;
    ctx.lineWidth = boldEvery && n % boldEvery === 0 ? 2.5 : 1.5;
    line(ctx, x, y0, x, y1);
  }
  n = 0;
  for (let y = y0; y <= y1 + 1; y += step, n++) {
    ctx.strokeStyle = boldEvery && n % boldEvery === 0 ? DARK : INK;
    ctx.lineWidth = boldEvery && n % boldEvery === 0 ? 2.5 : 1.5;
    line(ctx, x0, y, x1, y);
  }
}

function dots(ctx, w, h, mm) {
  const step = mm * MM;
  ctx.fillStyle = DARK;
  for (let y = 24 * MM; y < h - 12 * MM; y += step) {
    for (let x = 12 * MM; x < w - 10 * MM; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export const TEMPLATES = [
  { id: 'lined-wide', name: 'Lined (wide)', desc: 'Big lines for K–2',
    draw: (c, w, h) => { header(c, w); ruled(c, w, h, { gapMm: 14 }); } },
  { id: 'lined', name: 'Lined', desc: 'Lines for Years 3–6',
    draw: (c, w, h) => { header(c, w); ruled(c, w, h, { gapMm: 9 }); } },
  { id: 'handwriting', name: 'Handwriting', desc: 'Dotted middle line',
    draw: (c, w, h) => { header(c, w); handwriting(c, w, h); } },
  { id: 'story', name: 'Story page', desc: 'Picture box and lines',
    draw: (c, w, h) => {
      header(c, w);
      c.strokeStyle = DARK; c.lineWidth = 3;
      c.strokeRect(15 * MM, 24 * MM, w - 30 * MM, 120 * MM);
      handwriting(c, w, h, { from: 156 * MM, xMm: 7 });
    } },
  { id: 'grid-1cm', name: 'Squares (1 cm)', desc: 'For maths and drawing',
    draw: (c, w, h) => { header(c, w); grid(c, w, h, 10); } },
  { id: 'grid-5mm', name: 'Squares (5 mm)', desc: 'Graph paper',
    draw: (c, w, h) => { header(c, w); grid(c, w, h, 5, { boldEvery: 2 }); } },
  { id: 'dots', name: 'Dot grid', desc: 'Dots every 1 cm',
    draw: (c, w, h) => { header(c, w); dots(c, w, h, 10); } },
  { id: 'blank', name: 'Blank', desc: 'Nothing on it',
    draw: (c, w) => header(c, w) },
];

export function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id) || TEMPLATES[0];
}

/** Draw a template page. `scale` < 1 makes a small preview. */
export function renderTemplate(id, scale = 1) {
  const c = document.createElement('canvas');
  c.width = Math.round(A4.width * scale);
  c.height = Math.round(A4.height * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(scale, scale);
  getTemplate(id).draw(ctx, A4.width, A4.height);
  return c;
}
