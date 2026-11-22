// Word suggestions and spell check for answer boxes, as in Word Helper:
//   - while typing a word, a dropdown of likely words appears at the cursor;
//   - after a misspelt word, "Did you mean…" corrections;
//   - tapping inside a word shows its corrections (or alternatives).
// Each row: 🔊 hear the word · the word (tap to use it) · ? hear what it means.
//
// Works on any <textarea>. The spelling itself is in spelling.js, which is
// loaded the first time it's needed.

const HOOKS = new WeakMap(); // textarea → detach()
let spelling = null;         // the spelling module, once loaded
let dd = null;               // the one dropdown element
let ddFor = null;            // { ta, mode, start, end, word, items, active }

function loadSpelling() {
  if (!spelling) spelling = import('./spelling.js');
  return spelling;
}

/**
 * Add suggestions to a text box.
 * opts: {
 *   enabled(): bool            — the Settings switch
 *   online(): bool             — allow single-word lookups online
 *   speak(text)                — read aloud
 *   onSuggestion(word)         — a suggested word was used
 *   onCorrection(from, to)     — a word was swapped for a correction
 *   onListen(word), onDefine(word)
 * }
 */
export function attachWordHelper(ta, opts) {
  if (HOOKS.has(ta)) return;
  let composing = false;
  let afterSeparator = false;
  const onBeforeInput = e => {
    afterSeparator = e.inputType === 'insertLineBreak' || (e.inputType === 'insertText' && /^[\s.,!?;:]$/.test(e.data || ''));
  };
  const onInput = e => {
    if (composing || !opts.enabled() || e.pagepalHelper) return;
    const sep = afterSeparator;
    afterSeparator = false;
    if (sep) checkFinishedWord(ta, opts);
    else suggest(ta, opts);
  };
  const onTap = () => {
    if (!opts.enabled()) return;
    setTimeout(() => {
      if (ta.selectionStart !== ta.selectionEnd) return;
      const w = wordAround(ta.value, ta.selectionStart);
      // Inside a word (not just at its end, which is where typing happens).
      if (w && ta.selectionStart < w.end) showSpelling(ta, opts, w, true);
      else hide();
    }, 0);
  };
  const onKey = e => {
    if (!ddFor || ddFor.ta !== ta) return;
    const n = ddFor.items.length;
    if (e.key === 'Escape') { hide(); e.preventDefault(); }
    else if (n && e.key === 'ArrowDown') { setActive((ddFor.active + 1) % n); e.preventDefault(); }
    else if (n && e.key === 'ArrowUp') { setActive((ddFor.active - 1 + n) % n); e.preventDefault(); }
    else if (n && (e.key === 'Enter' || e.key === 'Tab') && ddFor.active >= 0) { pick(ddFor.items[ddFor.active]); e.preventDefault(); }
  };
  const onBlur = () => setTimeout(() => { if (ddFor && ddFor.ta === ta && document.activeElement !== ta) hide(); }, 150);
  const cs = () => { composing = true; };
  const ce = () => { composing = false; };
  ta.addEventListener('beforeinput', onBeforeInput);
  ta.addEventListener('input', onInput);
  ta.addEventListener('pointerup', onTap);
  ta.addEventListener('keydown', onKey);
  ta.addEventListener('blur', onBlur);
  ta.addEventListener('compositionstart', cs);
  ta.addEventListener('compositionend', ce);
  HOOKS.set(ta, () => {
    ta.removeEventListener('beforeinput', onBeforeInput);
    ta.removeEventListener('input', onInput);
    ta.removeEventListener('pointerup', onTap);
    ta.removeEventListener('keydown', onKey);
    ta.removeEventListener('blur', onBlur);
    ta.removeEventListener('compositionstart', cs);
    ta.removeEventListener('compositionend', ce);
  });
  loadSpelling(); // get the word lists ready
}

/** Take the dropdown away (e.g. when an answer box is put away). */
export function hideWordHelper() { hide(); }

// ── Finding the word at the cursor ─────────────────────

const LETTER = /[\p{L}'’]/u;

/** The word around position pos: {start, end, word}, or null. */
export function wordAround(text, pos) {
  let a = pos, b = pos;
  while (a > 0 && LETTER.test(text[a - 1])) a--;
  while (b < text.length && LETTER.test(text[b])) b++;
  const word = text.slice(a, b).replace(/^['’]+|['’]+$/g, '');
  if (!word || !/\p{L}/u.test(word)) return null;
  const lead = text.slice(a, b).indexOf(word);
  return { start: a + lead, end: a + lead + word.length, word };
}

/** The word just finished before position pos (skipping the separator). */
export function wordBefore(text, pos) {
  let i = pos;
  while (i > 0 && /[\s.,!?;:]/.test(text[i - 1])) i--;
  return wordAround(text, i);
}

// ── While typing: likely words ─────────────────────────

async function suggest(ta, opts) {
  const pos = ta.selectionStart;
  if (pos !== ta.selectionEnd) return hide();
  const w = wordAround(ta.value, pos);
  if (!w || w.end !== pos || (pos < ta.value.length && LETTER.test(ta.value[pos]))) return hide();
  const sp = await loadSpelling();
  if (ta.selectionStart !== pos) return; // typed on meanwhile
  const words = sp.completions(w.word).map(s => matchCase(s, w.word));
  if (!words.length) return hide();
  show(ta, opts, { mode: 'suggest', ...w, words, header: null });
}

// ── After a word: is it spelt right? ───────────────────

async function checkFinishedWord(ta, opts) {
  const w = wordBefore(ta.value, ta.selectionStart);
  if (!w) return hide();
  const sp = await loadSpelling();
  sp.setOnline(opts.online());
  if (sp.misspelt(w.word)) return showSpelling(ta, opts, w, false);
  hide();
  // An online check may still decide it's misspelt: offer fixes then, if
  // the student is still in this box and hasn't moved on to other words.
  const off = sp.onChecked(word => {
    if (word !== w.word.toLowerCase()) return;
    off();
    if (document.activeElement !== ta || !opts.enabled()) return;
    const now = wordBefore(ta.value, ta.selectionStart);
    if (now && now.start === w.start && now.word === w.word && sp.misspelt(w.word)) showSpelling(ta, opts, now, false);
  });
  setTimeout(off, 8000);
}

/** Corrections for a misspelt word, or alternatives for a correct one (tapped). */
async function showSpelling(ta, opts, w, tapped) {
  const sp = await loadSpelling();
  sp.setOnline(opts.online());
  const wrong = sp.misspelt(w.word);
  if (!wrong && !tapped) return;
  show(ta, opts, { mode: 'spell', ...w, words: [], header: 'Checking “' + w.word + '”…', loading: true });
  const list = await sp.spellingSuggestions(w.word);
  if (!ddFor || ddFor.ta !== ta || ddFor.start !== w.start) return; // moved on
  const words = (list || []).map(s => matchCase(s.word, w.word)).filter(x => x.toLowerCase() !== w.word.toLowerCase()).slice(0, 6);
  const header = wrong
    ? (words.length ? 'Did you mean…' : '“' + w.word + '”: not sure. Ask your teacher!')
    : (words.length ? 'Other words like “' + w.word + '”' : '“' + w.word + '” looks right!');
  show(ta, opts, { mode: wrong ? 'spell' : 'alt', ...w, words, header });
}

/** Keep the student's capital letter: "Beau" → "Beautiful". */
function matchCase(word, like) {
  return like && like[0] === like[0].toUpperCase() && like[0] !== like[0].toLowerCase()
    ? word[0].toUpperCase() + word.slice(1) : word;
}

// ── The dropdown ───────────────────────────────────────

function ensureDD() {
  if (dd) return dd;
  dd = document.createElement('div');
  dd.className = 'word-dd';
  dd.setAttribute('role', 'listbox');
  dd.hidden = true;
  // Taps on the list mustn't take the keyboard away from the answer box.
  dd.addEventListener('pointerdown', e => e.preventDefault());
  document.body.appendChild(dd);
  return dd;
}

function show(ta, opts, s) {
  const box = ensureDD();
  ddFor = { ta, opts, ...s, items: [], active: -1 };
  box.innerHTML = '';
  if (s.header) {
    const h = document.createElement('div');
    h.className = 'word-dd-header' + (s.loading ? ' loading' : '');
    h.textContent = s.header;
    box.appendChild(h);
  }
  s.words.forEach(word => {
    const row = document.createElement('div');
    row.className = 'word-dd-row';
    row.setAttribute('role', 'option');
    const hear = button('word-dd-hear', '🔊', 'Hear “' + word + '”');
    const use = button('word-dd-word', word, 'Use “' + word + '”');
    const def = button('word-dd-def', '?', 'What does “' + word + '” mean?');
    const meaning = document.createElement('div');
    meaning.className = 'word-dd-meaning';
    meaning.hidden = true;
    hear.addEventListener('click', () => { opts.speak(word); opts.onListen(word); });
    use.addEventListener('click', () => pick(item));
    def.addEventListener('click', async () => {
      opts.onDefine(word);
      def.textContent = '…';
      const sp = await loadSpelling();
      sp.setOnline(opts.online());
      const text = await sp.definition(word);
      def.textContent = '?';
      meaning.textContent = text || 'No meaning found for this word.';
      meaning.hidden = false;
      opts.speak(text ? word + '. ' + text : word);
      place();
    });
    row.append(hear, use, def);
    const wrap = document.createElement('div');
    wrap.className = 'word-dd-item';
    wrap.append(row, meaning);
    box.appendChild(wrap);
    const item = { word, el: wrap };
    ddFor.items.push(item);
  });
  box.hidden = false;
  place();
}

function button(cls, text, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.setAttribute('aria-label', label);
  return b;
}

function setActive(i) {
  if (!ddFor) return;
  ddFor.active = i;
  ddFor.items.forEach((it, k) => it.el.classList.toggle('active', k === i));
}

function hide() {
  if (dd) dd.hidden = true;
  ddFor = null;
}

/** Use a word: replace the word being typed (or the misspelt one). */
function pick(item) {
  const s = ddFor;
  if (!s) return;
  const { ta, opts } = s;
  const v = ta.value;
  const before = v.slice(0, s.start), after = v.slice(s.end);
  // A suggestion finishes the word with a space, ready for the next one.
  const space = s.mode === 'suggest' && !/^[\s.,!?;:]/.test(after) ? ' ' : '';
  ta.value = before + item.word + space + after;
  const caret = before.length + item.word.length + space.length;
  ta.setSelectionRange(caret, caret);
  ta.dataset.logged = String(caret); // already counted below, not as typing
  if (s.mode === 'suggest') opts.onSuggestion(item.word);
  else opts.onCorrection(s.word, item.word);
  hide();
  const ev = new Event('input', { bubbles: true });
  ev.pagepalHelper = true;
  ta.dispatchEvent(ev); // the answer box saves the change
  ta.focus();
}

// ── Placing the dropdown at the cursor ─────────────────

function place() {
  if (!ddFor || !dd || dd.hidden) return;
  const { ta, start } = ddFor;
  const c = caretXY(ta, start);
  const vv = window.visualViewport;
  const viewTop = vv ? vv.offsetTop : 0;
  const viewH = vv ? vv.height : window.innerHeight;
  const viewW = vv ? vv.width : window.innerWidth;
  dd.style.maxWidth = Math.min(340, viewW - 16) + 'px';
  const w = dd.offsetWidth, h = dd.offsetHeight;
  let x = Math.max(8, Math.min(c.x, viewW - w - 8));
  let y = c.y + c.h + 6;
  // Not enough room below (the on-screen keyboard)? Go above the line.
  if (y + h > viewTop + viewH - 8 && c.y - h - 6 > viewTop + 8) y = c.y - h - 6;
  dd.style.left = x + 'px';
  dd.style.top = y + 'px';
}
window.addEventListener('resize', () => place());
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => place());
document.addEventListener('scroll', () => place(), true);

/**
 * Where a character position is on screen, in a textarea: a hidden copy with
 * the same styling, measured up to that position.
 */
function caretXY(ta, pos) {
  const r = ta.getBoundingClientRect();
  const st = getComputedStyle(ta);
  const m = document.createElement('div');
  ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth',
    'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight',
    'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'textIndent', 'tabSize']
    .forEach(k => { m.style[k] = st[k]; });
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', wordWrap: 'break-word', overflow: 'hidden', top: '0', left: '-9999px' });
  m.textContent = ta.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = ta.value.slice(pos) || '.';
  m.appendChild(mark);
  document.body.appendChild(m);
  const lh = parseFloat(st.lineHeight) || parseFloat(st.fontSize) * 1.35;
  const x = r.left + mark.offsetLeft - ta.scrollLeft;
  const y = r.top + mark.offsetTop - ta.scrollTop;
  m.remove();
  return { x, y, h: lh };
}
