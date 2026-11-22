// Writing on the worksheet: text boxes and tick / cross / circle stamps.
//
// Items live in fractions of the page, so they stay in place at any zoom
// and on any screen size:
//   { id, page, type: 'text' | 'tick' | 'cross' | 'circle' | 'ink',
//     points,    ink only: [[x, y], …] as fractions of the page
//     x, y,      top-left corner, as a fraction of page width / height
//     w,         text box width, fraction of page width
//     size,      font (or stamp) size, fraction of page width
//     color, text }
// Saved on the worksheet record (record.annotations) a moment after each change.

export const COLORS = ['#1F3A93', '#111111', '#C0392B', '#1E8449']; // navy, black, red, green
export const COLOR_NAMES = ['Blue', 'Black', 'Red', 'Green'];
const DEFAULT_SIZE = 0.024;      // about 14 pt on an A4 page (the middle text size)
// Three sizes for each kind of thing: small, medium, large. The size last
// tapped for a kind of thing becomes the size new ones start at.
export const SIZE_LEVELS = {
  text: [0.018, 0.024, 0.034],   // about 10, 14 and 19 pt on A4
  stamp: [0.035, 0.05, 0.07],
  ink: [0.0025, 0.004, 0.007],
};
export const DEFAULT_LEVELS = { text: 0, stamp: 1, ink: 1 };
const DEFAULT_WIDTH = 0.42;
export const HEAR_SIZE = 0.035;  // highlighter (Hear) width: about one line of print
const LONG_PRESS_MS = 500;
const MIN_SIZE = 0.012, MAX_SIZE = 0.08;
const HISTORY_LIMIT = 100;

const STAMP_SVG = {
  tick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6"/></svg>',
  cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>',
  circle: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="12" rx="10" ry="9"/></svg>',
};
const STAMP_LABEL = { tick: 'Tick', cross: 'Cross', circle: 'Circle' };

const newId = () => Math.random().toString(36).slice(2, 10);

/** SVG path for a pen stroke (points are fractions of the page). */
function inkPath(points) {
  if (!points.length) return '';
  const [x0, y0] = points[0];
  if (points.length === 1) return `M${x0} ${y0}l0.0001 0`;
  return 'M' + points.map(([x, y]) => `${x} ${y}`).join('L');
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Words in the student's answers, in reading order (page, then top to
 * bottom, then left to right). Used for the report and the stats.
 */
export function answerText(items) {
  return items
    .filter(i => i.type === 'text' && i.text && i.text.trim())
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
    .map(i => i.text.trim())
    .join('\n');
}

/** Wrap text into lines that fit `maxWidth` (canvas measureText). */
export function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const test = line + word;
      if (line && ctx.measureText(test).width > maxWidth && /\S/.test(word)) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else line = test;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/**
 * Draw a page's items onto a canvas of the page (width × height pixels).
 * Used when saving / sending pictures of the finished worksheet.
 */
export function drawItems(ctx, items, pageIndex, width, height, fontFamily) {
  for (const it of items.filter(i => i.page === pageIndex)) {
    const x = it.x * width, y = it.y * height;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = it.color || COLORS[0];
    if (it.type === 'ink') {
      const pts = it.points || [];
      ctx.lineWidth = it.size * width;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach(([px, py], n) => (n ? ctx.lineTo(px * width, py * height) : ctx.moveTo(px * width, py * height)));
      if (pts.length === 1) ctx.lineTo(pts[0][0] * width + 0.5, pts[0][1] * height);
      ctx.stroke();
    } else if (it.type === 'text') {
      if (!it.text || !it.text.trim()) { ctx.restore(); continue; }
      const px = it.size * width;
      ctx.font = `${px}px ${fontFamily}`;
      ctx.textBaseline = 'top';
      const pad = px * 0.25;
      const lineH = px * 1.35;
      wrapLines(ctx, it.text, it.w * width - pad * 2).forEach((line, n) => {
        ctx.fillText(line, x + pad, y + pad + n * lineH + (lineH - px) / 2);
      });
    } else {
      const s = it.size * width * 1.6;
      ctx.lineWidth = s * 0.1;
      ctx.lineCap = ctx.lineJoin = 'round';
      const u = v => v / 24 * s;
      ctx.beginPath();
      if (it.type === 'tick') { ctx.moveTo(x + u(4), y + u(12.5)); ctx.lineTo(x + u(9), y + u(17.5)); ctx.lineTo(x + u(20), y + u(6)); }
      if (it.type === 'cross') { ctx.moveTo(x + u(5), y + u(5)); ctx.lineTo(x + u(19), y + u(19)); ctx.moveTo(x + u(19), y + u(5)); ctx.lineTo(x + u(5), y + u(19)); }
      if (it.type === 'circle') ctx.ellipse(x + u(12), y + u(12), u(10), u(9), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * The editable layer over every page of an open worksheet.
 * callbacks: onChange(items)            → save
 *            onSelect(item | null)      → update the toolbar
 *            onTypedWord(word)          → session log
 *            onTap({page, fx, fy})      → true if the tap was handled (a printed word)
 *            onBlankTap(spot)           → a short tap on empty paper (show a hint)
 *            onHighlight({page, points, size}) → a Hear swipe (fractions of the page)
 */
export class Annotator {
  constructor(pageEls, items, callbacks = {}) {
    this.pageEls = pageEls;
    this.items = items.map(i => ({ ...i }));
    this.cb = callbacks;
    this.tool = 'text';
    this.color = COLORS[0];
    this.levels = { ...DEFAULT_LEVELS, ...(callbacks.sizeLevels || {}) };
    this.selectedId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.layers = pageEls.map((pageEl, i) => {
      const layer = document.createElement('div');
      layer.className = 'annot-layer';
      layer.dataset.page = i;
      layer.addEventListener('click', e => this._onLayerClick(e, i));
      layer.addEventListener('pointerdown', e => this._onLayerDown(e, i));
      layer.addEventListener('pointermove', e => this._onLayerMove(e, i));
      layer.addEventListener('pointerup', e => this._onLayerUp(e, i));
      layer.addEventListener('pointercancel', () => this._cancelPress(true));
      layer.addEventListener('contextmenu', e => {
        // Right-click (Chromebooks, laptops) opens the same menu as a long press.
        // On Windows touch screens a press-and-hold also fires this event, after
        // our own long press has already opened the menu: don't open it twice.
        if (e.target.closest('textarea')) return; // text boxes keep Paste and spelling
        e.preventDefault();
        if (e.target !== layer || this.tool === 'draw' || this.tool === 'hear') return;
        const last = this._lastLongPress;
        const sameHold = last && e.pointerType !== 'mouse' && Date.now() - last.t < 1500 &&
          Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30;
        if (sameHold) return;
        this._cancelPress();
        this._lastLongPress = { t: Date.now(), x: e.clientX, y: e.clientY };
        this._suppressClick = e.pointerType === 'touch' || e.pointerType === 'pen';
        const { fx, fy } = this._pointInPage(e, i);
        this.cb.onLongPress && this.cb.onLongPress({ page: i, fx, fy, clientX: e.clientX, clientY: e.clientY });
      });
      pageEl.appendChild(layer);
      return layer;
    });
    this.items.forEach(it => this._render(it));
    this._onKey = e => this._keydown(e);
    document.addEventListener('keydown', this._onKey);
  }

  destroy() {
    document.removeEventListener('keydown', this._onKey);
    this.layers.forEach(l => l.remove());
  }

  // ── State and history ───────────────────────────────

  _snapshot() { return JSON.stringify(this.items); }

  /** Call before a change that should be undoable. */
  _remember() {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  _changed() {
    this.cb.onChange && this.cb.onChange(this.items);
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() { this._restore(this.undoStack, this.redoStack); }
  redo() { this._restore(this.redoStack, this.undoStack); }

  _restore(from, to) {
    if (!from.length) return;
    this._commitTyping();
    to.push(this._snapshot());
    this.items = JSON.parse(from.pop());
    this.layers.forEach(l => { l.textContent = ''; });
    this.items.forEach(it => this._render(it));
    this.select(this.items.some(i => i.id === this.selectedId) ? this.selectedId : null);
    this._changed();
  }

  get selected() { return this.items.find(i => i.id === this.selectedId) || null; }

  // ── Tools ───────────────────────────────────────────

  setTool(tool) {
    this.tool = tool;
    this.layers.forEach(l => l.classList.toggle('drawing', tool === 'draw' || tool === 'hear'));
    if (tool === 'draw' || tool === 'hear') this.deselect();
  }

  setColor(color) {
    this.color = color;
    const it = this.selected;
    if (it) {
      this._remember();
      it.color = color;
      this._applyStyle(it);
      this._changed();
    }
  }

  /** Size group of an item: 'text', 'stamp' (ticks, crosses, circles) or 'ink'. */
  static kind(it) {
    return it.type === 'text' ? 'text' : it.type === 'ink' ? 'ink' : 'stamp';
  }

  /** The size new items of a kind start at. */
  sizeFor(kind) {
    return SIZE_LEVELS[kind][this.levels[kind]];
  }

  /** Which of the three sizes (0, 1, 2) an item is closest to. */
  levelOf(it) {
    const sizes = SIZE_LEVELS[Annotator.kind(it)];
    let best = 0;
    sizes.forEach((v, i) => { if (Math.abs(Math.log(it.size / v)) < Math.abs(Math.log(it.size / sizes[best]))) best = i; });
    return best;
  }

  /**
   * Small, medium or large (0, 1, 2) for the selected item. That size also
   * becomes the starting size for new items of its kind.
   */
  setLevel(level) {
    const it = this.selected;
    if (!it) return;
    const kind = Annotator.kind(it);
    this.levels[kind] = level;
    this.cb.onSizeLevel && this.cb.onSizeLevel(kind, level);
    if (it.size === SIZE_LEVELS[kind][level]) return;
    this._remember();
    it.size = SIZE_LEVELS[kind][level];
    this._applyStyle(it);
    this._changed();
  }

  /** Make the selected item's text (or stamp) bigger (+1) or smaller (−1). */
  resize(step) {
    const it = this.selected;
    if (!it) return;
    this._remember();
    const [lo, hi] = it.type === 'ink' ? [0.0015, 0.03] : [MIN_SIZE, MAX_SIZE * (it.type === 'text' ? 1 : 2)];
    it.size = clamp(it.size * (step > 0 ? 1.25 : 1 / 1.25), lo, hi);
    this._applyStyle(it);
    this._changed();
  }

  deleteSelected() {
    const it = this.selected;
    if (!it) return;
    this._remember();
    this._remove(it.id);
    this.select(null);
    this._changed();
  }

  // ── Creating items ──────────────────────────────────

  _pointInPage(e, pageIndex) {
    const r = this.layers[pageIndex].getBoundingClientRect();
    return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height, r };
  }

  _onLayerClick(e, pageIndex) {
    if (e.target !== this.layers[pageIndex]) return; // a tap on an existing item
    if (this._suppressClick) { this._suppressClick = false; return; } // it was a long press
    if (this.tool === 'draw' || this.tool === 'hear') return;
    const { fx, fy } = this._pointInPage(e, pageIndex);
    // A short tap never adds anything (so a missed word, or a stray tap,
    // doesn't start typing): it reads a printed word, or just puts away
    // whatever was being edited. Press and hold opens the menu to add things.
    const wasEditing = this.selectedId !== null;
    this.deselect();
    if (this.cb.onTap && this.cb.onTap({ page: pageIndex, fx, fy })) return;
    if (!wasEditing && this.cb.onBlankTap) this.cb.onBlankTap({ page: pageIndex, fx, fy, clientX: e.clientX, clientY: e.clientY });
  }

  /** Add a text box or stamp centred on a tapped point (fractions of the page). */
  placeAt(tool, pageIndex, fx, fy, { text = '', focus = true } = {}) {
    const r = this.layers[pageIndex].getBoundingClientRect();
    if (tool === 'text') {
      const lineH = (this.sizeFor('text') * 1.35 * r.width) / r.height;
      return this.addText(pageIndex, fx, fy - lineH * 0.6, text, { focus });
    }
    const s = this.sizeFor('stamp') * 1.6;
    return this.addStamp(pageIndex, tool, fx - s / 2, fy - (s * r.width / r.height) / 2);
  }

  // ── Long press (menu) and drawing ───────────────────

  _onLayerDown(e, pageIndex) {
    if (e.target !== this.layers[pageIndex]) return;
    if (this.tool === 'draw' || this.tool === 'hear') { this._startStroke(e, pageIndex); return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this._cancelPress();
    const { fx, fy } = this._pointInPage(e, pageIndex);
    const press = { x: e.clientX, y: e.clientY, page: pageIndex, fx, fy };
    press.timer = setTimeout(() => {
      this._press = null;
      this._suppressClick = true;
      this._lastLongPress = { t: Date.now(), x: press.x, y: press.y };
      if (navigator.vibrate) navigator.vibrate(20);
      this.cb.onLongPress && this.cb.onLongPress({ page: pageIndex, fx, fy, clientX: press.x, clientY: press.y });
    }, LONG_PRESS_MS);
    this._press = press;
  }

  _onLayerMove(e, pageIndex) {
    if (this._stroke) { this._extendStroke(e); return; }
    if (this._press && Math.hypot(e.clientX - this._press.x, e.clientY - this._press.y) > 10) this._cancelPress();
  }

  _onLayerUp(e) {
    if (this._stroke) { this._endStroke(e); return; }
    this._cancelPress();
  }

  _cancelPress(alsoStroke = false) {
    if (this._press) { clearTimeout(this._press.timer); this._press = null; }
    if (alsoStroke && this._stroke) { this._stroke.path.closest('svg').remove(); this._stroke = null; }
  }

  _startStroke(e, pageIndex) {
    if (this._stroke) { this._cancelPress(true); return; } // a second finger: pinch, not drawing
    e.preventDefault();
    this.layers[pageIndex].setPointerCapture(e.pointerId);
    const { fx, fy } = this._pointInPage(e, pageIndex);
    const hear = this.tool === 'hear';
    const it = { id: newId(), page: pageIndex, type: 'ink', points: [[fx, fy]], size: hear ? HEAR_SIZE : this.sizeFor('ink'), color: hear ? 'rgb(124, 77, 255)' : this.color };
    const svg = this._inkSvg(it);
    if (hear) svg.classList.add('annot-hear');
    this.layers[pageIndex].appendChild(svg);
    this._stroke = { it, path: svg.querySelector('path'), pointerId: e.pointerId, hear };
  }

  _extendStroke(e) {
    const st = this._stroke;
    if (e.pointerId !== st.pointerId) return;
    const { fx, fy } = this._pointInPage(e, st.it.page);
    const last = st.it.points[st.it.points.length - 1];
    if (Math.hypot(fx - last[0], fy - last[1]) < 0.002) return;
    st.it.points.push([+fx.toFixed(4), +fy.toFixed(4)]);
    st.path.setAttribute('d', inkPath(st.it.points));
  }

  _endStroke() {
    const st = this._stroke;
    this._stroke = null;
    if (st.hear) {
      // A highlighter swipe isn't kept: it marks words to read aloud.
      const svg = st.path.closest('svg');
      setTimeout(() => svg.remove(), 250);
      if (this.cb.onHighlight) this.cb.onHighlight({ page: st.it.page, points: st.it.points, size: HEAR_SIZE });
      return;
    }
    st.path.closest('svg').remove();
    this._remember();
    this.items.push(st.it);
    this._render(st.it);
    this._changed();
  }

  _inkSvg(it) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'annot annot-ink');
    svg.setAttribute('viewBox', '0 0 1 1');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.dataset.id = it.id;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', inkPath(it.points));
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(path);
    svg.style.color = it.color;
    path.style.strokeWidth = `calc(var(--pw, 800px) * ${it.size})`;
    return svg;
  }

  addText(page, x, y, text = '', { focus = true } = {}) {
    this._dropEmptySelected();
    this._remember();
    const w = Math.min(DEFAULT_WIDTH, 0.98 - x);
    const it = {
      id: newId(), page, type: 'text',
      x: clamp(x, 0, 0.9), y: clamp(y, 0, 0.97), w: Math.max(0.12, w),
      size: this.sizeFor('text'), color: this.color, text,
    };
    this.items.push(it);
    this._render(it);
    this.select(it.id);
    if (focus) this.focusSelected();
    this._changed();
    return it;
  }

  addStamp(page, type, x, y) {
    this._dropEmptySelected();
    this._remember();
    const it = { id: newId(), page, type, x: clamp(x, 0, 0.95), y: clamp(y, 0, 0.97), size: this.sizeFor('stamp'), color: this.color };
    this.items.push(it);
    this._render(it);
    this.select(it.id);
    this._changed();
    return it;
  }

  // ── Rendering ───────────────────────────────────────

  _el(id) { return this.layers.map(l => l.querySelector(`[data-id="${id}"]`)).find(Boolean) || null; }

  _render(it) {
    if (it.type === 'ink') {
      const svg = this._inkSvg(it);
      svg.querySelector('path').addEventListener('click', e => { e.stopPropagation(); if (this.tool !== 'draw') this.select(it.id); });
      this.layers[it.page].appendChild(svg);
      return;
    }
    const el = document.createElement('div');
    el.className = 'annot ' + (it.type === 'text' ? 'annot-text' : 'annot-stamp');
    el.dataset.id = it.id;

    if (it.type === 'text') {
      const grip = document.createElement('button');
      grip.type = 'button';
      grip.className = 'annot-grip';
      grip.setAttribute('aria-label', 'Move this answer');
      grip.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>';
      this._makeDraggable(grip, it.id);

      const ta = document.createElement('textarea');
      ta.className = 'annot-input';
      ta.rows = 1;
      ta.spellcheck = false;
      ta.setAttribute('aria-label', 'Answer');
      ta.value = it.text || '';
      ta.addEventListener('focus', () => this.select(it.id));
      ta.addEventListener('beforeinput', e => this._logTyping(ta, e));
      ta.addEventListener('input', () => {
        if (!this._typingSnapshot) this._typingSnapshot = this._snapshot();
        const item = this.items.find(i => i.id === it.id);
        if (item) item.text = ta.value;
        this._autoHeight(ta);
        clearTimeout(this._typingTimer);
        this._typingTimer = setTimeout(() => this._commitTyping(), 1200);
        this._changed();
      });
      ta.addEventListener('blur', () => {
        this._logLastWord(ta);
        this._commitTyping();
        this.lastCaret = { id: it.id, start: ta.selectionStart, end: ta.selectionEnd };
      });

      const sizer = document.createElement('div');
      sizer.className = 'annot-width';
      sizer.setAttribute('aria-hidden', 'true');
      this._makeWidthHandle(sizer, it.id);

      el.append(grip, ta, sizer);
    } else {
      el.innerHTML = STAMP_SVG[it.type];
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', STAMP_LABEL[it.type]);
      el.addEventListener('click', () => this.select(it.id));
      this._makeDraggable(el, it.id);
    }
    this.layers[it.page].appendChild(el);
    this._applyStyle(it);
    if (it.type === 'text') requestAnimationFrame(() => this._autoHeight(el.querySelector('textarea')));
  }

  _applyStyle(it) {
    const el = this._el(it.id);
    if (!el) return;
    if (it.type === 'ink') {
      el.style.color = it.color;
      el.querySelector('path').style.strokeWidth = `calc(var(--pw, 800px) * ${it.size})`;
      return;
    }
    el.style.left = (it.x * 100) + '%';
    el.style.top = (it.y * 100) + '%';
    el.style.color = it.color;
    if (it.type === 'text') {
      el.style.width = (it.w * 100) + '%';
      el.style.fontSize = `calc(var(--pw, 800px) * ${it.size})`;
      this._autoHeight(el.querySelector('textarea'));
    } else {
      el.style.width = el.style.height = `calc(var(--pw, 800px) * ${it.size * 1.6})`;
    }
  }

  _autoHeight(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  /** Call after the page size changes (zoom), so text boxes re-measure. */
  relayout() {
    this.layers.forEach(l => l.querySelectorAll('textarea').forEach(ta => this._autoHeight(ta)));
  }

  _remove(id) {
    this.items = this.items.filter(i => i.id !== id);
    const el = this._el(id);
    if (el) el.remove();
  }

  // ── Selection ───────────────────────────────────────

  select(id) {
    if (this.selectedId && this.selectedId !== id) {
      const old = this._el(this.selectedId);
      if (old) old.classList.remove('selected');
    }
    this.selectedId = id;
    const el = id && this._el(id);
    if (el) el.classList.add('selected');
    const it = this.selected;
    this.cb.onSelect && this.cb.onSelect(it);
  }

  /** Deselect; an empty text box is removed rather than left lying around. */
  deselect() {
    this._dropEmptySelected();
    this.select(null);
  }

  _dropEmptySelected() {
    const it = this.selected;
    if (it && it.type === 'text' && !(it.text || '').trim()) {
      this._remove(it.id);
      this.selectedId = null;
      this._changed();
    }
  }

  focusSelected() {
    const el = this.selectedId && this._el(this.selectedId);
    const ta = el && el.querySelector('textarea');
    if (ta) ta.focus({ preventScroll: false });
  }

  // ── Typing ──────────────────────────────────────────

  /** Typing is one undo step per pause, not one per letter. */
  _commitTyping() {
    clearTimeout(this._typingTimer);
    if (this._typingSnapshot) {
      this.undoStack.push(this._typingSnapshot);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this._typingSnapshot = null;
      this.cb.onSelect && this.cb.onSelect(this.selected); // refresh undo button
    }
  }

  _logTyping(ta, e) {
    if (e.inputType === 'insertLineBreak' || (e.inputType === 'insertText' && /^[\s.,!?;:]$/.test(e.data || ''))) {
      const before = ta.value.slice(0, ta.selectionStart);
      const m = before.match(/([\p{L}\p{N}'’-]+)$/u);
      if (m && this.cb.onTypedWord) this.cb.onTypedWord(m[1]);
      ta.dataset.logged = String(ta.selectionStart);
    }
  }

  /** A word typed at the very end of a box (no space after it) still counts. */
  _logLastWord(ta) {
    const done = Number(ta.dataset.logged || 0);
    const m = ta.value.match(/([\p{L}\p{N}'’-]+)$/u);
    if (m && ta.value.length > done && ta.value.length - m[1].length >= done - 1 && this.cb.onTypedWord) {
      this.cb.onTypedWord(m[1]);
    }
    ta.dataset.logged = String(ta.value.length);
  }

  /**
   * Put dictated text into the selected box, where the cursor was.
   * Returns false if no text box is selected.
   */
  insertText(text) {
    const it = this.selected;
    if (!it || it.type !== 'text') return false;
    const el = this._el(it.id);
    const ta = el.querySelector('textarea');
    this._commitTyping();
    this._remember();
    const caret = this.lastCaret && this.lastCaret.id === it.id ? this.lastCaret : { start: ta.value.length, end: ta.value.length };
    const before = ta.value.slice(0, caret.start), after = ta.value.slice(caret.end);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && !/^\s/.test(after) ? ' ' : '';
    ta.value = before + lead + text + trail + after;
    const pos = (before + lead + text + trail).length;
    this.lastCaret = { id: it.id, start: pos, end: pos };
    ta.dataset.logged = String(ta.value.length); // dictated words are logged separately
    it.text = ta.value;
    this._autoHeight(ta);
    this._changed();
    return true;
  }

  // ── Dragging ────────────────────────────────────────

  _makeDraggable(handle, id) {
    let start = null;
    handle.addEventListener('pointerdown', e => {
      const it = this.items.find(i => i.id === id);
      if (!it) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      this.select(id);
      const r = this.layers[it.page].getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, ix: it.x, iy: it.y, r, moved: false, snap: this._snapshot() };
    });
    handle.addEventListener('pointermove', e => {
      if (!start) return;
      const it = this.items.find(i => i.id === id);
      const dx = (e.clientX - start.x) / start.r.width, dy = (e.clientY - start.y) / start.r.height;
      if (!start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
      start.moved = true;
      it.x = clamp(start.ix + dx, -0.02, 0.98);
      it.y = clamp(start.iy + dy, -0.02, 0.98);
      this._applyStyle(it);
    });
    const end = () => {
      if (!start) return;
      if (start.moved) {
        this.undoStack.push(start.snap);
        this.redoStack = [];
        this._changed();
      } else if (handle.classList.contains('annot-grip')) {
        this.focusSelected();
      }
      start = null;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  _makeWidthHandle(handle, id) {
    let start = null;
    handle.addEventListener('pointerdown', e => {
      const it = this.items.find(i => i.id === id);
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const r = this.layers[it.page].getBoundingClientRect();
      start = { x: e.clientX, w: it.w, r, snap: this._snapshot() };
    });
    handle.addEventListener('pointermove', e => {
      if (!start) return;
      const it = this.items.find(i => i.id === id);
      it.w = clamp(start.w + (e.clientX - start.x) / start.r.width, 0.08, 1 - it.x);
      this._applyStyle(it);
    });
    const end = () => {
      if (!start) return;
      this.undoStack.push(start.snap);
      this.redoStack = [];
      this._changed();
      start = null;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ── Keyboard ────────────────────────────────────────

  _keydown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo(); else this.undo();
      return;
    }
    const inText = e.target && e.target.tagName === 'TEXTAREA';
    if (e.key === 'Escape' && this.selectedId) {
      if (inText) e.target.blur();
      this.deselect();
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !inText && this.selected && this.selected.type !== 'text') {
      e.preventDefault();
      this.deleteSelected();
    }
  }
}
