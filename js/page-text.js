// Reading the words a student highlights on a worksheet, so they can hear
// them read aloud.
//
// The student swipes over the words they want (Hear). Only that area is
// read:
//   - PDFs made on a computer carry their own text: exact and instant.
//   - Photos, pictures, Word files (shown as pictures) and scanned PDFs: the
//     swiped area is cut out, enlarged and read with on-device text
//     recognition (Tesseract, lib/tesseract). Pictures never leave the iPad.
// Reading one line or short block is what Tesseract does best, and the
// student has already chosen where the text is, so no guessing about
// pictures, lines or layout is needed.
//
// Words are {t, x, y, w, h} in fractions of the page, in reading order.

import { renderPage } from './pdf-doc.js';
import { blobToCanvas } from './image-tools.js';

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

// ── Reading a highlighted area ───────────────────────

/** The area a swipe covers: the swipe's box, widened by half the highlighter. */
export function swipeArea(points, size, aspect) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const padX = size / 2, padY = (size / 2) / aspect; // the highlighter is `size` page-widths wide
  return {
    x0: Math.max(0, Math.min(...xs) - padX), x1: Math.min(1, Math.max(...xs) + padX),
    y0: Math.max(0, Math.min(...ys) - padY), y1: Math.min(1, Math.max(...ys) + padY),
  };
}

/** Is a word's middle inside the area? */
const inside = (w, a) => {
  const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
  return cx >= a.x0 && cx <= a.x1 && cy >= a.y0 && cy <= a.y1;
};

const pdfCache = new WeakMap();   // PDF document → page number → words (and drawn scanned pages)
const pageCanvas = new WeakMap(); // page picture (Blob) → canvas

/**
 * The words in an area of page i (0-based) of a worksheet, in reading
 * order. `doc` is the open PDF, if the worksheet is one.
 */
export async function readArea(record, i, area, doc) {
  if (record.kind === 'pdf' && doc) {
    if (!pdfCache.has(doc)) pdfCache.set(doc, new Map());
    const pages = pdfCache.get(doc);
    if (!pages.has(i)) pages.set(i, await pdfWords(doc, i + 1));
    const all = pages.get(i);
    if (all.length >= 3) {
      // A PDF with text: use it (nothing there means nothing to read).
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      return groupWords(all.filter(w => inside(w, area)), vp.height / vp.width).flat();
    }
    // A scanned PDF (pictures of pages, no text): read the picture.
    const key = 'scan' + i;
    if (!pages.has(key)) {
      const canvas = document.createElement('canvas');
      await renderPage(doc, i + 1, canvas, 2000 / Math.min(window.devicePixelRatio || 1, 3));
      pages.set(key, canvas);
    }
    return ocrArea(pages.get(key), area);
  }
  const blob = record.pages && record.pages[i] && record.pages[i].blob;
  if (!blob) return [];
  if (!pageCanvas.has(blob)) pageCanvas.set(blob, await blobToCanvas(blob, 2400));
  return ocrArea(pageCanvas.get(blob), area);
}

/** Cut the area out of a page picture, enlarge it, and read it. */
export async function ocrArea(page, area) {
  // A little extra around the swipe, so letters it only grazed are whole.
  const mx = (area.x1 - area.x0) * 0.04 + 0.01, my = (area.y1 - area.y0) * 0.25 + 0.005;
  const sx = Math.max(0, Math.floor((area.x0 - mx) * page.width));
  const sy = Math.max(0, Math.floor((area.y0 - my) * page.height));
  const sw = Math.min(page.width, Math.ceil((area.x1 + mx) * page.width)) - sx;
  const sh = Math.min(page.height, Math.ceil((area.y1 + my) * page.height)) - sy;
  if (sw < 4 || sh < 4) return [];
  // Small print reads much better enlarged (as if the page were 3000 px wide).
  const k = Math.max(1, Math.min(3, 3000 / page.width));
  const crop = document.createElement('canvas');
  crop.width = Math.round(sw * k);
  crop.height = Math.round(sh * k);
  const ctx = crop.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, crop.width, crop.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(page, sx, sy, sw, sh, 0, 0, crop.width, crop.height);

  const worker = await getWorker();
  try {
    // "A single block of text": what a highlighted area is.
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const { data } = await worker.recognize(crop, {}, { blocks: true, text: false });
    const words = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const texts = fixCapitalI((line.words || []).map(w => String(w.text || '').trim()));
          (line.words || []).forEach((w, wi) => {
            const bb = w.bbox;
            for (const piece of splitNumber(texts[wi], bb.x0, bb.x1)) {
              if (!keepWord(piece.t, w.confidence)) continue;
              const pad = (bb.y1 - bb.y0) * 0.12;
              words.push({
                t: piece.t,
                x: (sx + piece.x0 / k) / page.width,
                y: (sy + (bb.y0 - pad) / k) / page.height,
                w: (piece.x1 - piece.x0) / k / page.width,
                h: (bb.y1 - bb.y0 + pad * 2) / k / page.height,
              });
            }
          });
        }
      }
    }
    // Only words the swipe actually covered (the margin may catch a neighbour).
    return words.filter(w => inside(w, area));
  } finally {
    scheduleIdle();
  }
}

/** Text to speak for a word: drop stray quote marks and bullets, keep sentence punctuation. */
export function speakable(t) {
  return String(t).replace(/^[•·▪■□●○*_|~^]+/, '').replace(/[_|~^]+$/, '');
}
