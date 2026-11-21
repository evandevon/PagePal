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

export const TEXT_VERSION = 6;
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

// ── Text recognition for pictures ────────────────────

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

/**
 * Paint out long straight lines (answer lines, table borders, boxes) so the
 * letters touching them can be read. Changes only the copy being read.
 */
export function eraseRules(canvas) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, W, H);
  const px = img.data;
  // Dark = clearly darker than this page's paper.
  let sum = 0, n = 0;
  for (let i = 0; i < px.length; i += 4 * 97) { sum += px[i] + px[i + 1] + px[i + 2]; n++; }
  const cut = (sum / n) * 0.62;
  const dark = new Uint8Array(W * H);
  for (let i = 0, j = 0; j < dark.length; i += 4, j++) dark[j] = px[i] + px[i + 1] + px[i + 2] < cut ? 1 : 0;
  const erase = new Uint8Array(W * H);
  const minH = Math.max(40, Math.round(W * 0.06)), minV = Math.max(40, Math.round(H * 0.04));
  const rules = [];
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x <= W; x++) {
      if (x < W && dark[y * W + x]) { run++; continue; }
      if (run >= minH) {
        for (let k = x - run; k < x; k++) erase[y * W + k] = 1;
        const x0 = (x - run) / W, x1 = x / W, last = rules[rules.length - 1];
        // one rule for each line, however many pixels thick
        if (!(last && y / H - last.y < 4 / H && Math.abs(last.x0 - x0) < 0.02 && Math.abs(last.x1 - x1) < 0.02)) rules.push({ y: y / H, x0, x1 });
        else last.y = y / H;
      }
      run = 0;
    }
  }
  for (let x = 0; x < W; x++) {
    let run = 0;
    for (let y = 0; y <= H; y++) {
      if (y < H && dark[y * W + x]) { run++; continue; }
      if (run >= minV) for (let k = y - run; k < y; k++) erase[k * W + x] = 1;
      run = 0;
    }
  }
  for (let j = 0, i = 0; j < erase.length; j++, i += 4) if (erase[j]) { px[i] = px[i + 1] = px[i + 2] = 255; }
  ctx.putImageData(img, 0, 0);
  return rules;
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
    const prev = texts[i - 1];
    if (prev && /[\p{L}\p{N}]$/u.test(prev) && /^[A-Z0-9]/.test(prev) === false && t === 'l') return t; // "a l b"? leave
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

/** fn(x0, y0, x1, y1) → share of that box that is paper-coloured. */
function paperCheck(canvas) {
  const W = canvas.width, H = canvas.height;
  const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const vals = [];
  for (let i = 0; i < px.length; i += 4 * 211) vals.push(px[i] + px[i + 1] + px[i + 2]);
  vals.sort((a, b) => a - b);
  const paper = vals[Math.floor(vals.length * 0.97)] || 765;
  const light = paper * 0.7;
  return (x0, y0, x1, y1) => {
    let n = 0, ok = 0;
    const sx = Math.max(1, Math.floor((x1 - x0) / 24)), sy = Math.max(1, Math.floor((y1 - y0) / 8));
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, y1); y += sy) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, x1); x += sx) {
        const i = (y * W + x) * 4;
        n++;
        if (px[i] + px[i + 1] + px[i + 2] > light) ok++;
      }
    }
    return n ? ok / n : 0;
  };
}

/** Recognise the words in a canvas. Returns blocks (Tesseract's paragraphs, tidied). */
export async function ocrWords(canvas) {
  const worker = await getWorker();
  // Small print reads much better enlarged: aim for a page about 3000 px wide.
  const k = Math.min(2, 3000 / canvas.width);
  if (k > 1.15) {
    const big = document.createElement('canvas');
    big.width = Math.round(canvas.width * k);
    big.height = Math.round(canvas.height * k);
    const ctx = big.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, big.width, big.height);
    canvas = big;
  } else {
    const copy = document.createElement('canvas');
    copy.width = canvas.width; copy.height = canvas.height;
    copy.getContext('2d', { willReadFrequently: true }).drawImage(canvas, 0, 0);
    canvas = copy;
  }
  const W0 = canvas.width, H0 = canvas.height;
  const angle = estimateSkew(canvas);
  if (angle) canvas = straighten(canvas, angle);
  const rules = eraseRules(canvas);
  try {
    const W = canvas.width, H = canvas.height;
    const lightness = paperCheck(canvas);
    const collect = data => {
      const out = [];
      for (const block of data.blocks || []) {
        for (const para of block.paragraphs || []) {
          for (const line of para.lines || []) {
            const texts = fixCapitalI((line.words || []).map(x => String(x.text || '').trim()));
            (line.words || []).forEach((w, wi) => {
              const bb = w.bbox, hgt = bb.y1 - bb.y0, pad = hgt * 0.12;
              for (const piece of splitNumber(texts[wi], bb.x0, bb.x1)) {
                if (!keepWord(piece.t, w.confidence)) continue;
                // A box far too flat or wide for its letters is a bit of a line, not a word.
                if (hgt < 8 || (piece.x1 - piece.x0) / hgt > 1.1 * piece.t.length + 1) continue;
                // Printed words sit on paper: most of the box is light. "Words" seen in a
                // dark desk, shadow or picture aren't.
                if (lightness(piece.x0 - hgt * 0.3, bb.y0 - hgt * 0.3, piece.x1 + hgt * 0.3, bb.y1 + hgt * 0.3) < 0.5) continue;
                out.push({ t: piece.t, x: piece.x0 / W, y: (bb.y0 - pad) / H, w: (piece.x1 - piece.x0) / W, h: (hgt + pad * 2) / H, space: true });
              }
            });
          }
        }
      }
      return out;
    };
    // Two readings: the normal one follows lines of text well (titles,
    // instructions); "sparse text" finds words scattered among pictures and
    // boxes that the normal one skips. Keep the first, add what only the second saw.
    await worker.setParameters({ tessedit_pageseg_mode: '3' });
    const words = collect((await worker.recognize(canvas, {}, { blocks: true, text: false })).data);
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    for (const w of collect((await worker.recognize(canvas, {}, { blocks: true, text: false })).data)) {
      if (!words.some(v => overlaps(v, w))) words.push(w);
    }
    const blocks = groupWords(words, H / W, rules);
    if (!angle) return blocks;
    // (Straightening adds white corners; anything "read" out there is noise.)
    // Back to the tilted page: move each word's centre, and keep its slant.
    const cs = Math.cos(angle), sn = Math.sin(angle);
    return blocks.map(b => b.map(w => {
      const vx = (w.x + w.w / 2) * W - W / 2, vy = (w.y + w.h / 2) * H - H / 2;
      const cx = (W0 / 2 + vx * cs - vy * sn) / W0, cy = (H0 / 2 + vx * sn + vy * cs) / H0;
      const ww = w.w * W / W0, hh = w.h * H / H0;
      return { t: w.t, x: r4(cx - ww / 2), y: r4(cy - hh / 2), w: r4(ww), h: r4(hh), r: r4(angle), cx, cy };
    }).filter(w => w.cx > 0.015 && w.cx < 0.985 && w.cy > 0.015 && w.cy < 0.985)
      .map(({ cx, cy, ...w }) => w)).filter(b => b.length);
  } finally {
    scheduleIdle();
  }
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
