// Writing on the worksheet: text boxes and tick / cross / circle stamps.
//
// Items live in fractions of the page, so they stay in place at any zoom
// and on any screen size:
//   { id, page, type: 'text' | 'tick' | 'cross' | 'circle',
//     x, y,      top-left corner, as a fraction of page width / height
//     w,         text box width, fraction of page width
//     size,      font (or stamp) size, fraction of page width
//     color, text }
// Saved on the worksheet record (record.annotations) a moment after each change.

export const COLORS = ['#1F3A93', '#111111', '#C0392B', '#1E8449']; // navy, black, red, green
export const COLOR_NAMES = ['Blue', 'Black', 'Red', 'Green'];
const DEFAULT_SIZE = 0.024;      // about 14 pt on an A4 page
const DEFAULT_WIDTH = 0.42;
const STAMP_SIZE = 0.05;
const MIN_SIZE = 0.012, MAX_SIZE = 0.08;
const HISTORY_LIMIT = 100;

const STAMP_SVG = {
  tick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6"/></svg>',
  cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>',
  circle: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="12" rx="10" ry="9"/></svg>',
};
const STAMP_LABEL = { tick: 'Tick', cross: 'Cross', circle: 'Circle' };

const newId = () => Math.random().toString(36).slice(2, 10);
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
    if (it.type === 'text') {
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
 */
export class Annotator {
  constructor(pageEls, items, callbacks = {}) {
    this.pageEls = pageEls;
    this.items = items.map(i => ({ ...i }));
    this.cb = callbacks;
    this.tool = 'text';
    this.color = COLORS[0];
    this.selectedId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.layers = pageEls.map((pageEl, i) => {
      const layer = document.createElement('div');
      layer.className = 'annot-layer';
      layer.dataset.page = i;
      layer.addEventListener('click', e => this._onLayerClick(e, i));
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

  setTool(tool) { this.tool = tool; }

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

  /** Make the selected item's text (or stamp) bigger (+1) or smaller (−1). */
  resize(step) {
    const it = this.selected;
    if (!it) return;
    this._remember();
    it.size = clamp(it.size * (step > 0 ? 1.18 : 1 / 1.18), MIN_SIZE, MAX_SIZE * (it.type === 'text' ? 1 : 2));
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
    const { fx, fy, r } = this._pointInPage(e, pageIndex);
    if (this.tool === 'text') {
      // Tapping away from a box finishes it; an empty one is tidied away.
      const lineH = (DEFAULT_SIZE * 1.35 * r.width) / r.height;
      this.addText(pageIndex, fx, fy - lineH * 0.6);
    } else {
      const s = (STAMP_SIZE * 1.6);
      this.addStamp(pageIndex, this.tool, fx - s / 2, fy - (s * r.width / r.height) / 2);
    }
  }

  addText(page, x, y, text = '') {
    this._dropEmptySelected();
    this._remember();
    const w = Math.min(DEFAULT_WIDTH, 0.98 - x);
    const it = {
      id: newId(), page, type: 'text',
      x: clamp(x, 0, 0.9), y: clamp(y, 0, 0.97), w: Math.max(0.12, w),
      size: this._lastTextSize || DEFAULT_SIZE, color: this.color, text,
    };
    this.items.push(it);
    this._render(it);
    this.select(it.id);
    this.focusSelected();
    this._changed();
    return it;
  }

  addStamp(page, type, x, y) {
    this._dropEmptySelected();
    this._remember();
    const it = { id: newId(), page, type, x: clamp(x, 0, 0.95), y: clamp(y, 0, 0.97), size: STAMP_SIZE, color: this.color };
    this.items.push(it);
    this._render(it);
    this.select(it.id);
    this._changed();
    return it;
  }

  // ── Rendering ───────────────────────────────────────

  _el(id) { return this.layers.map(l => l.querySelector(`[data-id="${id}"]`)).find(Boolean) || null; }

  _render(it) {
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
    if (it && it.type === 'text') this._lastTextSize = it.size;
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
