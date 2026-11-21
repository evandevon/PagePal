// Finding the words printed on a worksheet, so students can tap them to hear
// them read aloud.
//
// PDFs made on a computer carry their own text, which is exact and instant.
// Photos, Word files (shown as pictures) and scanned PDFs are read with
// on-device text recognition (Tesseract, lib/tesseract), which takes a few
// seconds a page and never sends the picture anywhere.
//
// Every word is stored as fractions of its page: {t, x, y, w, h}. Words are
// grouped into blocks (a heading, a question, a paragraph); a tap reads from
// the tapped word to the end of its block. Results are saved with the
// worksheet so each page is only read once.

import { openPdf, renderPage } from './pdf-doc.js';
import { blobToCanvas } from './image-tools.js';

export const TEXT_VERSION = 11;
const HAS_LETTER = /[\p{L}\p{N}]/u;

// ── Grouping words into lines and blocks ─────────────

/**
 * Words (any order) → blocks of words in reading order.
 * Words on the same row are a line unless there's a wide gap (columns,
 * tables); lines close together with matching size and position are a block.
 * `words` are {t, x, y, w, h} in page fractions; `aspect` = page height / width,
 * so horizontal and vertical gaps can be compared. `rules` are ruled lines
 * found on the page ({y, x0, x1}); text either side of one is kept apart.
 */
export function groupWords(words, aspect = 1.414, rules = []) {
  const ws = words
    .filter(w => w && w.t && HAS_LETTER.test(w.t) && w.w > 0 && w.h > 0)
    .map(w => ({ ...w, cy: w.y + w.h / 2 }))
    .sort((a, b) => a.cy - b.cy || a.x - b.x);

  // Rows: words whose middles line up.
  const rows = [];
  for (const w of ws) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(w.cy - row.cy) < 0.5 * Math.min(row.h, w.h)) {
      row.words.push(w);
      row.h = Math.max(row.h, w.h);
    } else {
      rows.push({ cy: w.cy, h: w.h, words: [w] });
    }
  }

  // Lines: split rows at wide gaps; join pieces of one word split by the PDF.
  const lines = [];
  for (const row of rows) {
    row.words.sort((a, b) => a.x - b.x);
    let line = null;
    for (const w of row.words) {
      const hx = w.h * aspect; // the word's height, in page-width units
      const last = line && line.words[line.words.length - 1];
      const gap = last ? w.x - (last.x + last.w) : Infinity;
      if (last && gap < 0.12 * hx && !last.space) {
        // "frac" + "tions" drawn as two pieces: one word
        last.t += w.t;
        last.w = w.x + w.w - last.x;
        last.space = w.space;
        continue;
      }
      if (!line || gap > 2.2 * hx) {
        line = { words: [] };
        lines.push(line);
      }
      line.words.push({ ...w });
    }
  }
  lines.forEach(l => {
    l.x = Math.min(...l.words.map(w => w.x));
    l.r = Math.max(...l.words.map(w => w.x + w.w));
    l.y = Math.min(...l.words.map(w => w.y));
    l.b = Math.max(...l.words.map(w => w.y + w.h));
    l.h = median(l.words.map(w => w.h));
  });
  lines.sort((a, b) => a.y - b.y || a.x - b.x);

  // Blocks: a line joins the block above it if it's close below, a similar
  // size, and overlaps it sideways.
  const blocks = [];
  for (const l of lines) {
    let best = null;
    for (const bl of blocks) {
      const prev = bl.lines[bl.lines.length - 1];
      const gap = l.y - prev.b;
      const similar = Math.max(l.h, prev.h) / Math.min(l.h, prev.h) < 1.4;
      const overlaps = l.x < prev.r && l.r > prev.x;
      const ruled = rules.some(r => r.y > prev.b - prev.h * 0.25 && r.y < l.y + l.h * 0.25 &&
        r.x0 < Math.min(l.r, prev.r) && r.x1 > Math.max(l.x, prev.x));
      // Lines of one paragraph sit close: the gap is under about half a line.
      // (Word boxes include tails like g and y, so heights vary a little.)
      // Single words stacked up are a list (answer choices, spelling words):
      // each is read on its own.
      const list = l.words.length === 1 && prev.words.length === 1;
      if (gap > -0.3 * l.h && gap < 0.5 * Math.min(l.h, prev.h) && similar && overlaps && !ruled && !list) { best = bl; break; }
    }
    if (best) best.lines.push(l);
    else blocks.push({ lines: [l] });
  }
  return blocks.map(bl => bl.lines.flatMap(l => l.words.map(({ t, x, y, w, h }) => ({ t, x: r4(x), y: r4(y), w: r4(w), h: r4(h) }))));
}

const r4 = v => Math.round(v * 1e4) / 1e4;
const median = a => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)] || 0; };

/**
 * Split one PDF text run into words, sharing its width out by measured
 * letter widths. `measure(text)` gives a relative width.
 */
export function splitRun(str, box, measure = s => s.length) {
  const parts = String(str).split(/(\s+)/);
  const total = parts.reduce((n, p) => n + measure(p), 0) || 1;
  const out = [];
  let at = 0;
  parts.forEach((p, i) => {
    const pw = measure(p);
    if (p && !/^\s+$/.test(p)) {
      out.push({
        t: p,
        x: box.x + (at / total) * box.w,
        y: box.y,
        w: (pw / total) * box.w,
        h: box.h,
        // Does a space follow inside this run (or does the run end in one)?
        space: i < parts.length - 1 || /\s$/.test(str),
      });
    }
    at += pw;
  });
  return out;
}

// ── PDFs that carry text ─────────────────────────────

let measureCtx = null;
function measureFor(font) {
  if (typeof document === 'undefined') return s => s.length;
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  return s => { measureCtx.font = `100px ${font}`; return measureCtx.measureText(s).width; };
}

/** The words on PDF page n (1-based), or [] if it has no usable text. */
export async function pdfWords(doc, n) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const words = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const [a, b, c, d, e, f] = item.transform;
    const fontH = Math.hypot(c, d);
    const len = Math.hypot(a, b) || 1;
    const ux = a / len, uy = b / len; // text direction
    const corners = [
      [e, f], [e + ux * item.width, f + uy * item.width],
      [e - uy * fontH, f + ux * fontH], [e + ux * item.width - uy * fontH, f + uy * item.width + ux * fontH],
    ].map(([x, y]) => vp.convertToViewportPoint(x, y));
    const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    if (box.w <= 0 || box.h <= 0) continue;
    if (item.str.trim().length > 1 && box.h > box.w * 1.5) continue; // sideways text
    // A little extra height so descenders (g, y, p) are covered.
    const style = content.styles[item.fontName] || {};
    const font = style.fontFamily || 'sans-serif';
    const pad = box.h * 0.12;
    const run = { x: box.x / vp.width, y: (box.y - pad) / vp.height, w: box.w / vp.width, h: (box.h + pad * 2) / vp.height };
    words.push(...splitRun(item.str, run, measureFor(font)));
  }
  return words;
}

// ── The Tesseract worker (loaded only when needed) ───

const TESS = new URL('../lib/tesseract/', import.meta.url);
let workerPromise = null;
let idleTimer = null;

function simdSupported() {
  try {
    // The smallest module using a SIMD instruction (from wasm-feature-detect).
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch {
    return false;
  }
}

/**
 * Download the text-recognition files in the background (the service worker
 * keeps them), so photos can be read later without wifi. About 7 MB, once.
 */
export async function warmUpOcr() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const core = simdSupported() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
  for (const f of ['tesseract.esm.min.js', 'worker.min.js', core, 'eng.traineddata.gz']) {
    try { await fetch(new URL(f, TESS).href); } catch { return; }
  }
}

async function getWorker() {
  clearTimeout(idleTimer);
  if (!workerPromise) {
    workerPromise = (async () => {
      const { default: Tesseract } = await import(new URL('tesseract.esm.min.js', TESS).href);
      const core = simdSupported() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
      const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
        workerPath: new URL('worker.min.js', TESS).href,
        corePath: new URL(core, TESS).href,
        langPath: TESS.href.replace(/\/$/, ''),
        workerBlobURL: false,
      });
      return worker;
    })().catch(err => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

/** Free the recogniser's memory (about 100 MB) once it's been idle a while. */
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = workerPromise;
    workerPromise = null;
    if (p) { try { (await p).terminate(); } catch { /* already gone */ } }
  }, 60000);
}

// ── Text recognition for pictures: the steps ─────────
//
//  1. Prepare: enlarge small print; straighten a crooked photo.
//  2. Remove ruled lines (answer lines, table borders), remembering them as
//     dividers between blocks.
//  3. Paint out pictures and dotted guide lines, so they're never read as
//     letters (the standard "text or not text" split of document analysis).
//  4. Read with Tesseract twice, the normal page layout and then "sparse
//     text" (which finds words the first skips), and combine, keeping the
//     surer reading wherever both read the same spot.
//  5. Drop misreads: unsure shapes, boxes not on paper; a capital I read as
//     "|" becomes I.
//  6. Group into lines and blocks; map back onto a crooked photo.
//
// Steps 1 to 3 and 5 are standard OCR clean-up. Reading twice is PagePal's
// own addition, checked against sample worksheets at several sizes.

/** A canvas's pixels, read once and shared by every check. */
function pagePixels(canvas) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, W, H);
  const px = img.data;
  // The paper's colour: the brightest common colour, ignoring pure white
  // (the corners added when a crooked photo is straightened).
  const sample = [];
  for (let i = 0; i < px.length; i += 4 * 211) {
    const v = px[i] + px[i + 1] + px[i + 2];
    if (v < 762) sample.push(i);
  }
  sample.sort((p, q) => (px[p] + px[p + 1] + px[p + 2]) - (px[q] + px[q + 1] + px[q + 2]));
  const top = sample.slice(Math.floor(sample.length * 0.9), Math.floor(sample.length * 0.98));
  const paperRGB = top.length
    ? [0, 1, 2].map(k => Math.round(top.reduce((a, i) => a + px[i + k], 0) / top.length))
    : [255, 255, 255];
  const paper = paperRGB[0] + paperRGB[1] + paperRGB[2]; // brightness of the paper
  const sum = i => px[i] + px[i + 1] + px[i + 2];
  /** Share of a box (sampled) passing test(i). */
  const share = (x0, y0, x1, y1, test) => {
    let n = 0, ok = 0;
    const sx = Math.max(1, Math.floor((x1 - x0) / 24)), sy = Math.max(1, Math.floor((y1 - y0) / 8));
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, y1); y += sy) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, x1); x += sx) {
        n++;
        if (test((y * W + x) * 4)) ok++;
      }
    }
    return n ? ok / n : 0;
  };
  return {
    W, H, px, paper, paperRGB,
    dark: (x, y) => sum((y * W + x) * 4) < paper * 0.6,
    /** Clearly not paper: darker, or coloured. */
    ink: (x, y) => {
      const i = (y * W + x) * 4;
      return sum(i) < paper * 0.75 || Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 60;
    },
    /** Share of a box that is paper-coloured. */
    light: (x0, y0, x1, y1) => share(x0, y0, x1, y1, i => sum(i) > paper * 0.7),
    save: () => ctx.putImageData(img, 0, 0),
  };
}

// ── Step 1: prepare ──────────────────────────────────

/** A copy to read from: small print enlarged to about 3000 px wide. */
function readingCopy(canvas) {
  const k = Math.min(2, 3000 / canvas.width);
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * (k > 1.15 ? k : 1));
  out.height = Math.round(canvas.height * (k > 1.15 ? k : 1));
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/**
 * How far the text on a page is tilted (radians, + = sloping down to the
 * right), from photos taken a little crooked. Tries angles up to 20° and
 * keeps the one where dark pixels line up into the sharpest rows.
 */
export function estimateSkew(canvas) {
  const S = Math.min(1, 900 / canvas.width);
  const w = Math.round(canvas.width * S), h = Math.round(canvas.height * S);
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let j = 0, i = 0; j < g.length; j++, i += 4) g[j] = px[i] + px[i + 1] + px[i + 2];
  // Ink: much darker than the brightest pixel just beside it. A dark desk or
  // shadow is dark all over, so it doesn't count.
  const pts = [];
  const R = 4;
  for (let y = 0; y < h; y++) for (let x = R; x < w - R; x++) {
    const v = g[y * w + x];
    let hi = 0;
    for (let k = -R; k <= R; k++) { const u = g[y * w + x + k]; if (u > hi) hi = u; }
    if (hi > 300 && v < hi * 0.6) pts.push(x - w / 2, y - h / 2);
  }
  if (pts.length < 200) return 0;
  const step = Math.max(2, Math.floor(pts.length / 2 / 60000)) * 2; // at most ~60k points
  const score = a => {
    const sn = Math.sin(a), cs = Math.cos(a);
    const bins = new Float64Array(Math.ceil(Math.hypot(w, h)) + 2);
    const off = bins.length / 2;
    for (let i = 0; i < pts.length; i += step) bins[Math.floor(-pts[i] * sn + pts[i + 1] * cs + off)]++;
    let sq = 0;
    for (let i = 0; i < bins.length; i++) sq += bins[i] * bins[i];
    return sq;
  };
  const deg = Math.PI / 180;
  let best = 0, bestS = score(0);
  for (let a = -20; a <= 20; a += 1) { const sc = score(a * deg); if (sc > bestS) { bestS = sc; best = a * deg; } }
  for (let a = best - deg; a <= best + deg; a += deg / 4) { const sc = score(a); if (sc > bestS) { bestS = sc; best = a; } }
  return Math.abs(best) < 0.8 * deg ? 0 : best;
}

/** A copy of the canvas turned by -angle (straightened), grown to fit. */
function straighten(canvas, angle) {
  const cs = Math.abs(Math.cos(angle)), sn = Math.abs(Math.sin(angle));
  const W = canvas.width, H = canvas.height;
  const out = document.createElement('canvas');
  out.width = Math.ceil(W * cs + H * sn);
  out.height = Math.ceil(W * sn + H * cs);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(-angle);
  ctx.drawImage(canvas, -W / 2, -H / 2);
  return out;
}

// ── Step 2: ruled lines ──────────────────────────────

/**
 * Paint out long straight lines (answer lines, table borders, boxes) so
 * letters touching them can be read, keeping the bits where a letter's tail
 * touches a line (g, p on an underline). Returns the horizontal lines found,
 * as {y, x0, x1} fractions.
 */
export function eraseRules(pix) {
  const { W, H, px } = pix;
  const dark = new Uint8Array(W * H);
  // Lines may be grey or coloured (a thin blue underline), so anything
  // clearly not paper counts here.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dark[y * W + x] = pix.ink(x, y) ? 1 : 0;
  const minH = Math.max(40, Math.round(W * 0.06)), minV = Math.max(40, Math.round(H * 0.04));
  const maxThick = Math.max(6, Math.round(H * 0.004)); // lines are thin; a solid patch isn't a line
  // Long runs across, then down.
  const across = new Uint8Array(W * H), down = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x <= W; x++) {
      if (x < W && dark[y * W + x]) { run++; continue; }
      if (run >= minH) for (let k = x - run; k < x; k++) across[y * W + k] = 1;
      run = 0;
    }
  }
  for (let x = 0; x < W; x++) {
    let run = 0;
    for (let y = 0; y <= H; y++) {
      if (y < H && dark[y * W + x]) { run++; continue; }
      if (run >= minV) for (let k = y - run; k < y; k++) down[k * W + x] = 1;
      run = 0;
    }
  }
  // Keep only the thin ones: a run across that's also many pixels deep is
  // part of a picture or a filled box.
  const thinOnly = (mask, along, steps, len) => {
    for (let a = 0; a < along; a++) {
      let b = 0;
      while (b < steps) {
        if (!mask[len(a, b)]) { b++; continue; }
        let e = b;
        while (e + 1 < steps && mask[len(a, e + 1)]) e++;
        if (e - b + 1 > maxThick) for (let k = b; k <= e; k++) mask[len(a, k)] = 0;
        b = e + 1;
      }
    }
  };
  thinOnly(across, W, H, (x, y) => y * W + x); // depth of each run across, column by column
  thinOnly(down, H, W, (y, x) => y * W + x);   // width of each run down, row by row
  const erase = new Uint8Array(W * H);
  for (let j = 0; j < erase.length; j++) erase[j] = across[j] | down[j];
  // The horizontal lines, as dividers between blocks (one per line, however thick).
  const rules = [];
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x <= W; x++) {
      if (x < W && across[y * W + x]) { run++; continue; }
      if (run >= minH) {
        const x0 = (x - run) / W, x1 = x / W, last = rules[rules.length - 1];
        if (last && y / H - last.y < 4 / H && Math.abs(last.x0 - x0) < 0.02 && Math.abs(last.x1 - x1) < 0.02) last.y = y / H;
        else rules.push({ y: y / H, x0, x1 });
      }
      run = 0;
    }
  }
  // Keep a line's pixels where a letter stroke meets it from above or below.
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (!erase[y * W + x]) { y++; continue; }
      let y2 = y;
      while (y2 + 1 < H && erase[(y2 + 1) * W + x]) y2++;
      if (y2 - y < 12) {
        const above = y > 1 && dark[(y - 1) * W + x] && dark[(y - 2) * W + x];
        const below = y2 < H - 2 && dark[(y2 + 1) * W + x] && dark[(y2 + 2) * W + x];
        if (above || below) for (let k = y; k <= y2; k++) erase[k * W + x] = 0;
      }
      y = y2 + 1;
    }
  }
  const [pr, pg, pb] = pix.paperRGB;
  for (let j = 0, i = 0; j < erase.length; j++, i += 4) if (erase[j]) { px[i] = pr; px[i + 1] = pg; px[i + 2] = pb; }
  pix.save();
  return rules;
}

// ── Step 3: pictures ─────────────────────────────────

/**
 * Paint out pictures so Tesseract never tries to read them. The standard
 * "text or not text" split from document analysis: find each separate shape
 * on the page, then sort them. Letters are small, about the same height and
 * sit in rows; pictures are much taller, or solid, or colourful, and stand
 * alone. Dotted guide lines go too. Returns the picture boxes found
 * (fractions), for testing.
 */
export function maskPictures(pix) {
  const { W, H, px, paperRGB } = pix;
  // Work at half size: plenty for shapes, four times faster.
  const w = Math.ceil(W / 2), h = Math.ceil(H / 2);
  const isInk = pix.ink;
  const isColour = (x, y) => {
    const i = (y * W + x) * 4;
    return Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 90;
  };
  const ink = new Uint8Array(w * h), colour = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const X = Math.min(W - 1, x * 2 + dx), Y = Math.min(H - 1, y * 2 + dy);
      if (isInk(X, Y)) ink[y * w + x] = 1;
      if (isColour(X, Y)) colour[y * w + x] = 1;
    }
  }

  // Label touching ink into shapes (two passes with union-find).
  const label = new Int32Array(w * h);
  const parent = [0];
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const j = y * w + x;
    if (!ink[j]) continue;
    const near = [];
    if (x > 0 && label[j - 1]) near.push(label[j - 1]);
    if (y > 0) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < w && label[j - w + dx]) near.push(label[j - w + dx]);
      }
    }
    if (!near.length) { label[j] = parent.length; parent.push(parent.length); continue; }
    let root = find(near[0]);
    for (const n of near) {
      const r = find(n);
      if (r !== root) { const lo = Math.min(r, root); parent[Math.max(r, root)] = lo; root = lo; }
    }
    label[j] = root;
  }
  const shapes = new Map();
  for (let j = 0; j < label.length; j++) {
    if (!label[j]) continue;
    const r = find(label[j]);
    label[j] = r;
    const x = j % w, y = (j / w) | 0;
    let s = shapes.get(r);
    if (!s) { s = { x0: x, x1: x, y0: y, y1: y, n: 0, c: 0 }; shapes.set(r, s); }
    if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x;
    if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
    s.n++; if (colour[j]) s.c++;
  }
  const all = [...shapes.entries()].map(([id, s]) => ({ id, ...s, sw: s.x1 - s.x0 + 1, sh: s.y1 - s.y0 + 1 }));

  // Typical letter height: the middle of the small, upright shapes.
  // (Dots in dotted lines are far smaller than any printed letter: at least
  // 0.4% of the page's height.)
  const letterish = all.filter(s => s.sh >= Math.max(4, h * 0.004) && s.sh < h / 15 && s.n >= 6 && s.sw < s.sh * 3).map(s => s.sh);
  if (letterish.length < 8) return [];
  const th = median(letterish);

  // Letters have neighbours of similar height beside them, in a row.
  const rowmates = s => all.filter(o => o !== s && Math.abs(o.sh - s.sh) < s.sh * 0.3 &&
    Math.abs((o.y0 + o.y1) / 2 - (s.y0 + s.y1) / 2) < s.sh * 0.35 &&
    Math.min(Math.abs(o.x0 - s.x1), Math.abs(s.x0 - o.x1)) < s.sh * 1.5).length;

  const picture = new Set();
  for (const s of all) {
    s.fill = s.n / (s.sw * s.sh);
    // Mostly empty inside its box: a line, border or outline (perhaps with
    // letters touching it), not a picture. Lines were mostly erased already.
    if (s.fill < 0.12) continue;
    const huge = s.sh > th * 4.5 || (s.sw > th * 14 && s.sh > th * 2);
    // (Letters are narrow: even a tall coloured title letter with a tail, like
    // a blue p, is less than about one and a half letter-heights wide.)
    const big = s.sh > th * 2.5 && s.sw > th * 1.6;
    if (huge || (big && (s.c / s.n > 0.35 || s.fill > 0.55) && rowmates(s) < 2)) picture.add(s.id);
  }
  // Loose bits of a picture (a frog's spots, the gaps in a fence, a deer's
  // antler tip): inside a solid picture's box, or colourful and right on its edge.
  // (Not the desk or shadow around a photographed page: that "picture" is
  // the whole page, and everything is inside it.)
  const solid = all.filter(s => picture.has(s.id) && s.fill > 0.2 && s.sw * s.sh < w * h * 0.25 &&
    [s.x0 <= 1, s.y0 <= 1, s.x1 >= w - 2, s.y1 >= h - 2].filter(Boolean).length < 2);
  for (const s of all) {
    if (picture.has(s.id) || s.sh > th * 2.2) continue;
    const within = (b, m) => s.x0 >= b.x0 - m && s.x1 <= b.x1 + m && s.y0 >= b.y0 - m && s.y1 <= b.y1 + m;
    if (solid.some(b => within(b, 0)) || (s.c / s.n > 0.3 && solid.some(b => within(b, th)))) picture.add(s.id);
  }
  // Dotted lines (the middle guide line in handwriting rows): a long row of
  // tiny dots or dashes. (Full stops and the dots on i's never come ten in a row.)
  const tiny = all.filter(s => s.sh < th * 0.45 && s.sw < th * 1.2);
  tiny.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  for (const s of tiny) {
    if (picture.has(s.id)) continue;
    const cy = (s.y0 + s.y1) / 2;
    const row = tiny.filter(o => Math.abs((o.y0 + o.y1) / 2 - cy) < th * 0.25).sort((a, b) => a.x0 - b.x0);
    // runs of dots with small, even gaps
    let run = [row[0]];
    const flush = () => { if (run.length >= 10) run.forEach(o => picture.add(o.id)); };
    for (let k = 1; k < row.length; k++) {
      if (row[k].x0 - row[k - 1].x1 < th * 0.8) run.push(row[k]);
      else { flush(); run = [row[k]]; }
    }
    flush();
  }
  if (!picture.size) return [];

  // Paint them the paper's colour (with a one-pixel margin).
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let hit = false;
    for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1 && !hit; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && picture.has(label[yy * w + xx])) hit = true;
    }
    if (!hit) continue;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const X = x * 2 + dx, Y = y * 2 + dy;
      if (X < W && Y < H) { const i = (Y * W + X) * 4; px[i] = paperRGB[0]; px[i + 1] = paperRGB[1]; px[i + 2] = paperRGB[2]; }
    }
  }
  pix.save();
  return all.filter(s => picture.has(s.id) && s.sh >= th * 0.45).map(s => ({ x: s.x0 / w, y: s.y0 / h, w: s.sw / w, h: s.sh / h }));
}

// ── Steps 4 and 5: read twice, combine, drop misreads

/**
 * Keep a recognised word? Sure ones always; unsure ones only if they look
 * like a real word or number (so smudges and drawings don't become "words").
 */
export function keepWord(t, confidence) {
  if (!t || !HAS_LETTER.test(t)) return false;
  if (confidence >= 60) return /[\p{L}\p{N}]{2,}|^[\p{L}\p{N}][.)]?$/u.test(t);
  const core = t.replace(/^[("'‘“]+|[.,!?;:)"'’”]+$/g, '');
  // Short words: only common ones, and only when fairly sure.
  if (core.length <= 2) return confidence >= 50 && (SHORT_WORDS.has(core.toLowerCase()) || /^\d{1,2}[.)]?$/.test(core));
  // Unsure lowercase words are usually real words on a blurry or crooked
  // page. Unsure capitals are usually a picture misread ("SER", "Citi").
  if (/^[a-z]+(?:['’-][a-z]+)*$/.test(core)) return confidence >= 12;
  if (/^[A-Z][a-z]+(?:['’-][a-z]+)*$/.test(core)) return confidence >= 45;
  if (/^\d{1,4}(?:[.,]\d+)?$/.test(core)) return confidence >= 40;
  return false;
}

const SHORT_WORDS = new Set(('i a am an as at be by do go he if in is it me my no of oh ok on or so to up us we ' +
  'hi ox ax yo ma pa mr ms dr').split(' '));

/**
 * A capital I is often read as "|", "l", "1" or "]". Before a lowercase
 * word ("| see the"), it's an I.
 */
export function fixCapitalI(texts) {
  return texts.map((t, i) => {
    if (!/^[|l1\]\[!]$/.test(t)) return t;
    const next = texts[i + 1] || '';
    if (!/^[a-z]/.test(next)) return t;
    if (t === '1' && !I_VERBS.has(next.replace(/[^a-z']/g, ''))) return t; // "1 apple" stays 1
    return 'I';
  });
}

const I_VERBS = new Set(('see saw am can like love have had want went will was got get go do did play think live ' +
  'know need feel found made make think am\'m').split(' '));

/** "3.school" read as one word → "3." and "school", sharing its box. */
export function splitNumber(t, x0, x1) {
  const m = /^(\(?\d{1,3}[.)])(\p{L}.*)$/u.exec(t);
  if (!m) return [{ t, x0, x1 }];
  const cut = x0 + (x1 - x0) * (m[1].length / t.length);
  return [{ t: m[1], x0, x1: cut }, { t: m[2], x0: cut, x1 }];
}

/** Do two word boxes cover much the same spot? */
export function overlaps(a, b) {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ix <= 0 || iy <= 0) return false;
  return ix * iy > 0.3 * Math.min(a.w * a.h, b.w * b.h);
}

/**
 * Tesseract's result → words worth keeping, in page fractions, each with
 * its confidence (c).
 */
function wordsFrom(data, pix) {
  const { W, H } = pix;
  const out = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const texts = fixCapitalI((line.words || []).map(x => String(x.text || '').trim()));
        (line.words || []).forEach((w, wi) => {
          const bb = w.bbox, hgt = bb.y1 - bb.y0, pad = hgt * 0.12;
          for (const piece of splitNumber(texts[wi], bb.x0, bb.x1)) {
            if (isMisread(piece, bb, w.confidence, pix)) continue;
            out.push({ t: piece.t, x: piece.x0 / W, y: (bb.y0 - pad) / H, w: (piece.x1 - piece.x0) / W, h: (hgt + pad * 2) / H, space: true, c: w.confidence });
          }
        });
      }
    }
  }
  return out;
}

/** Is this recognised word (pixels) really a misread smudge, line or picture? */
function isMisread(piece, bb, confidence, pix) {
  const hgt = bb.y1 - bb.y0, wid = piece.x1 - piece.x0;
  if (!keepWord(piece.t, confidence)) return true;
  // Far too flat or wide for its letters: a bit of a line.
  if (hgt < 8 || wid / hgt > 1.1 * piece.t.length + 1) return true;
  // Printed words sit on paper: most of the box (with a margin) is light.
  if (pix.light(piece.x0 - hgt * 0.3, bb.y0 - hgt * 0.3, piece.x1 + hgt * 0.3, bb.y1 + hgt * 0.3) < 0.5) return true;
  return false;
}

/** Combine two readings: add what only the second saw; where both read a spot, keep the surer. */
export function combineReadings(first, second) {
  const words = [...first];
  for (const w of second) {
    const clash = words.filter(v => overlaps(v, w));
    if (!clash.length) words.push(w);
    else if (clash.every(v => v.c < w.c - 8)) {
      // e.g. the first ran "I see the" together as "Iseethe"
      clash.forEach(v => words.splice(words.indexOf(v), 1));
      words.push(w);
    }
  }
  return words;
}

// ── All the steps ────────────────────────────────────

/** Recognise the words in a canvas. Returns blocks of words in reading order. */
export async function ocrWords(source, { onPrepared } = {}) {
  const worker = await getWorker();
  try {
    // 1. Prepare
    let canvas = readingCopy(source);
    const W0 = canvas.width, H0 = canvas.height;
    const angle = estimateSkew(canvas);
    if (angle) canvas = straighten(canvas, angle);
    const pix = pagePixels(canvas);
    // 2. Ruled lines
    const rules = eraseRules(pix);
    // 3. Pictures
    const pictures = maskPictures(pix);
    if (onPrepared) onPrepared(canvas, pictures); // what Tesseract sees (for testing)
    // 4 and 5. Read twice, combine, drop misreads
    const read = async mode => {
      await worker.setParameters({ tessedit_pageseg_mode: mode });
      const data = (await worker.recognize(canvas, {}, { blocks: true, text: false })).data;
      return wordsFrom(data, pix);
    };
    const words = combineReadings(await read('3'), await read('11'));
    // 6. Blocks, back on the original page
    const blocks = groupWords(words, pix.H / pix.W, rules);
    return angle ? unstraighten(blocks, angle, pix.W, pix.H, W0, H0) : blocks;
  } finally {
    scheduleIdle();
  }
}

/**
 * Words found on the straightened copy → the crooked page: move each word's
 * centre back and keep its slant. Straightening added white corners, so
 * anything "read" at the very edge is dropped.
 */
function unstraighten(blocks, angle, W, H, W0, H0) {
  const cs = Math.cos(angle), sn = Math.sin(angle);
  return blocks.map(b => b.map(w => {
    const vx = (w.x + w.w / 2) * W - W / 2, vy = (w.y + w.h / 2) * H - H / 2;
    const cx = (W0 / 2 + vx * cs - vy * sn) / W0, cy = (H0 / 2 + vx * sn + vy * cs) / H0;
    const ww = w.w * W / W0, hh = w.h * H / H0;
    return { t: w.t, x: r4(cx - ww / 2), y: r4(cy - hh / 2), w: r4(ww), h: r4(hh), r: r4(angle), cx, cy };
  }).filter(w => w.cx > 0.015 && w.cx < 0.985 && w.cy > 0.015 && w.cy < 0.985)
    .map(({ cx, cy, ...w }) => w)).filter(b => b.length);
}

// ── Per worksheet page, saved with the worksheet ─────

/**
 * The blocks of words on page i (0-based) of a worksheet record, finding
 * them if they aren't saved yet. `doc` is the open PDF, if it is one.
 * Returns {blocks, source} and stores it in record.pageText[i].
 */
export async function pageText(record, i, doc) {
  record.pageText = record.pageText || [];
  const saved = record.pageText[i];
  if (saved && saved.v === TEXT_VERSION) return saved;
  let blocks = [], source = 'none';
  if (record.template) {
    // Lined and grid paper: nothing printed to read.
  } else if (record.kind === 'pdf') {
    const pdf = doc || await openPdf(record.file);
    const words = await pdfWords(pdf, i + 1);
    if (words.filter(w => HAS_LETTER.test(w.t)).length >= 3) {
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      blocks = groupWords(words, vp.height / vp.width);
      source = 'pdf';
    } else {
      // A scanned PDF: pictures of pages with no text inside.
      const canvas = document.createElement('canvas');
      await renderPage(pdf, i + 1, canvas, 2000 / Math.min(window.devicePixelRatio || 1, 3));
      blocks = await ocrWords(canvas);
      source = 'ocr';
    }
    if (pdf !== doc) pdf.destroy();
  } else {
    const canvas = await blobToCanvas(record.pages[i].blob, 2200);
    blocks = await ocrWords(canvas);
    source = 'ocr';
  }
  const result = { v: TEXT_VERSION, source, blocks };
  record.pageText[i] = result;
  return result;
}

/**
 * The word at a point on a page (fractions), or null.
 * Returns {block, index} into blocks. A little slack around each word helps
 * small fingers.
 */
export function wordAt(blocks, fx, fy, aspect = 1.414) {
  let best = null, bestD = Infinity;
  blocks.forEach((words, bi) => words.forEach((w, wi) => {
    // Work in page-width units, turned to the word's own slant.
    const dx = fx - (w.x + w.w / 2), dy = (fy - (w.y + w.h / 2)) * aspect;
    const r = w.r || 0, ux = dx * Math.cos(r) + dy * Math.sin(r), uy = -dx * Math.sin(r) + dy * Math.cos(r);
    const halfW = w.w / 2, halfH = (w.h * aspect) / 2, pad = halfH * 0.3;
    if (Math.abs(ux) > halfW + pad || Math.abs(uy) > halfH + pad) return;
    const d = Math.hypot(ux, uy);
    if (d < bestD) { bestD = d; best = { block: bi, index: wi }; }
  }));
  return best;
}

/** Text to speak for a word: drop stray quote marks and bullets, keep sentence punctuation. */
export function speakable(t) {
  return String(t).replace(/^[•·▪■□●○*_|~^]+/, '').replace(/[_|~^]+$/, '');
}
