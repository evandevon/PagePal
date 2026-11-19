// The worksheet screen: pages stacked top to bottom, pinch or buttons to
// zoom, page arrows, and a Send button for getting the work to the teacher.
// PDF pages are redrawn sharply after zooming; photo pages are images.

import { $ } from './ui.js';
import { openPdf, pageSizes, renderPage } from './pdf-doc.js';
import * as worksheets from './worksheets.js';
import { canvasToBlob, blobToCanvas } from './image-tools.js';
import { Annotator, drawItems } from './annotate.js';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

let current = null; // { record, doc, sizes, urls, zoom, annot, pages: [{el, canvas, renderedWidth, task}] }
let annotCallbacks = {};

export function currentWorksheet() {
  return current && current.record;
}

/** The text boxes and stamps on the open worksheet. */
export function currentAnnotator() {
  return current && current.annot;
}

/** Fit width in CSS pixels for zoom = 1. */
function fitWidth() {
  const scroller = $('#viewer-scroll');
  return Math.min(scroller.clientWidth - 32, 1100);
}

function applyZoom(z, focus) {
  if (!current) return;
  const scroller = $('#viewer-scroll');
  const old = current.zoom;
  z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  if (Math.abs(z - old) < 0.001) return;
  // Keep the point under the fingers (or the middle of the screen) still.
  const r = scroller.getBoundingClientRect();
  const fx = focus ? focus.x - r.left : scroller.clientWidth / 2;
  const fy = focus ? focus.y - r.top : scroller.clientHeight / 2;
  const cx = scroller.scrollLeft + fx, cy = scroller.scrollTop + fy;
  current.zoom = z;
  layoutPages();
  const k = z / old;
  scroller.scrollLeft = cx * k - fx;
  scroller.scrollTop = cy * k - fy;
  $('#viewer-zoom-label').textContent = Math.round(z * 100) + '%';
  scheduleSharpen();
}

function layoutPages() {
  const w = fitWidth() * current.zoom;
  current.pages.forEach((p, i) => {
    const size = current.sizes[i];
    p.el.style.width = w + 'px';
    p.el.style.height = (w * size.height / size.width) + 'px';
    p.el.style.setProperty('--pw', w + 'px'); // text box sizes are fractions of this
  });
  if (current.annot) current.annot.relayout();
}

let sharpenTimer = null;
function scheduleSharpen() {
  clearTimeout(sharpenTimer);
  sharpenTimer = setTimeout(renderVisible, 250);
}

/** Draw (or redraw at the new zoom) the PDF pages that are on screen. */
async function renderVisible() {
  if (!current || !current.doc) return;
  const scroller = $('#viewer-scroll');
  const view = scroller.getBoundingClientRect();
  const width = fitWidth() * current.zoom;
  for (let i = 0; i < current.pages.length; i++) {
    const p = current.pages[i];
    const r = p.el.getBoundingClientRect();
    const near = r.bottom > view.top - view.height && r.top < view.bottom + view.height;
    if (!near || Math.abs(p.renderedWidth - width) < 2) continue;
    if (p.task) { try { p.task.cancel(); } catch { /* finished */ } }
    const canvas = document.createElement('canvas');
    const rec = current;
    try {
      p.renderedWidth = width;
      p.task = null;
      await renderPage(current.doc, i + 1, canvas, width);
      if (rec !== current) return; // worksheet closed meanwhile
      canvas.className = 'page-img';
      p.canvas ? p.canvas.replaceWith(canvas) : p.el.appendChild(canvas);
      p.canvas = canvas;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') continue;
      p.renderedWidth = 0;
    }
  }
}

function updatePageLabel() {
  if (!current) return;
  const scroller = $('#viewer-scroll');
  const mid = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
  let n = 1;
  current.pages.forEach((p, i) => { if (p.el.getBoundingClientRect().top <= mid) n = i + 1; });
  current.pageNumber = n;
  $('#viewer-page').textContent = `Page ${n} of ${current.pages.length}`;
  $('#viewer-prev').disabled = n <= 1;
  $('#viewer-next').disabled = n >= current.pages.length;
}

function goToPage(n) {
  const p = current && current.pages[n - 1];
  if (p) $('#viewer-scroll').scrollTo({ top: p.el.offsetTop - 12, behavior: 'smooth' });
}

/** Open a worksheet record on screen. */
export async function openWorksheet(record) {
  closeWorksheet();
  $('#home').hidden = true;
  $('#viewer').hidden = false;
  $('#viewer-title').textContent = record.title;
  const container = $('#viewer-pages');
  container.textContent = '';
  current = { record, doc: null, sizes: [], urls: [], zoom: 1, pages: [], pageNumber: 1 };
  $('#viewer-zoom-label').textContent = '100%';

  if (record.kind === 'pdf') {
    current.doc = await openPdf(record.file);
    current.sizes = await pageSizes(current.doc);
  } else {
    current.sizes = record.pages.map(p => ({ width: p.width, height: p.height }));
  }

  current.sizes.forEach((size, i) => {
    const el = document.createElement('div');
    el.className = 'page';
    el.setAttribute('aria-label', `Page ${i + 1}`);
    if (record.kind === 'images') {
      const url = URL.createObjectURL(record.pages[i].blob);
      current.urls.push(url);
      const img = document.createElement('img');
      img.className = 'page-img';
      img.alt = `Page ${i + 1} of the worksheet`;
      img.src = url;
      el.appendChild(img);
    }
    container.appendChild(el);
    current.pages.push({ el, canvas: null, renderedWidth: 0, task: null });
  });

  current.annot = new Annotator(current.pages.map(p => p.el), record.annotations || [], annotCallbacks);
  layoutPages();
  $('#viewer-scroll').scrollTo(0, 0);
  updatePageLabel();
  await renderVisible();
  worksheets.touch(record).catch(() => {});
}

export function closeWorksheet() {
  if (!current) return;
  if (current.annot) current.annot.destroy();
  current.pages.forEach(p => { if (p.task) try { p.task.cancel(); } catch { /* ignore */ } });
  current.urls.forEach(u => URL.revokeObjectURL(u));
  if (current.doc) current.doc.destroy();
  current = null;
  $('#viewer-pages').textContent = '';
  $('#viewer').hidden = true;
  $('#home').hidden = false;
}

/** Page index and a spot near the top of what's on screen (for new answers). */
export function visibleSpot() {
  if (!current) return null;
  const scroller = $('#viewer-scroll');
  const i = (current.pageNumber || 1) - 1;
  const el = current.pages[i].el;
  const top = scroller.getBoundingClientRect().top;
  const r = el.getBoundingClientRect();
  const fy = Math.min(0.9, Math.max(0.03, (top - r.top + 40) / r.height));
  return { page: i, x: 0.08, y: fy };
}

/** The font answers are written in (the display mode's reading font). */
function answerFont() {
  const f = getComputedStyle(document.body).getPropertyValue('--read-font').trim();
  return f || 'Arial, sans-serif';
}

/**
 * JPEG of every page with the student's answers drawn on, for saving and
 * sending (about 1600 px wide).
 */
export async function pageImages() {
  if (!current) return [];
  const rec = current.record;
  const items = current.annot ? current.annot.items : (rec.annotations || []);
  const font = answerFont();
  try { await document.fonts.load(`20px ${font}`); } catch { /* use fallback */ }
  const out = [];
  for (let i = 0; i < current.sizes.length; i++) {
    let page;
    if (rec.kind === 'images') {
      page = await blobToCanvas(rec.pages[i].blob, 2400);
    } else {
      page = document.createElement('canvas');
      // renderPage multiplies by devicePixelRatio; aim for ~1600 px either way.
      await renderPage(current.doc, i + 1, page, 1600 / Math.min(window.devicePixelRatio || 1, 3));
    }
    const flat = document.createElement('canvas');
    flat.width = page.width; flat.height = page.height;
    const ctx = flat.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(page, 0, 0);
    drawItems(ctx, items, i, flat.width, flat.height, font);
    out.push(await canvasToBlob(flat, 'image/jpeg', 0.85));
  }
  return out;
}

// ── One-time wiring ───────────────────────────────────

export function initViewer({ onBack, onSend, annotations = {} }) {
  const scroller = $('#viewer-scroll');
  annotCallbacks = annotations;

  $('#viewer-back').addEventListener('click', onBack);
  $('#viewer-send').addEventListener('click', onSend);
  $('#viewer-prev').addEventListener('click', () => goToPage((current?.pageNumber || 1) - 1));
  $('#viewer-next').addEventListener('click', () => goToPage((current?.pageNumber || 1) + 1));
  $('#viewer-zoom-in').addEventListener('click', () => current && applyZoom(current.zoom * 1.25));
  $('#viewer-zoom-out').addEventListener('click', () => current && applyZoom(current.zoom / 1.25));
  $('#viewer-zoom-label').addEventListener('click', () => current && applyZoom(1));

  $('#viewer-title').addEventListener('click', async () => {
    if (!current) return;
    const t = prompt('Worksheet name', current.record.title);
    if (t && t.trim()) {
      await worksheets.rename(current.record, t.trim());
      $('#viewer-title').textContent = t.trim();
    }
  });

  scroller.addEventListener('scroll', () => { updatePageLabel(); scheduleSharpen(); }, { passive: true });
  window.addEventListener('resize', () => { if (current) { layoutPages(); scheduleSharpen(); } });

  // Pinch to zoom (two fingers). One finger still scrolls natively.
  const pts = new Map();
  let pinch = null;
  scroller.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && current) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: current.zoom };
    }
  });
  scroller.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      applyZoom(pinch.zoom * d / pinch.d, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
  });
  const lift = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  scroller.addEventListener('pointerup', lift);
  scroller.addEventListener('pointercancel', lift);
  // Safari's own page zoom would fight ours.
  ['gesturestart', 'gesturechange'].forEach(ev => scroller.addEventListener(ev, e => e.preventDefault()));
  // Trackpad pinch / Ctrl + scroll on Chromebooks and laptops.
  scroller.addEventListener('wheel', e => {
    if (!e.ctrlKey || !current) return;
    e.preventDefault();
    applyZoom(current.zoom * Math.exp(-e.deltaY / 200), { x: e.clientX, y: e.clientY });
  }, { passive: false });
}

