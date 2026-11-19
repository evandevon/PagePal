// PagePal — connects the modules to the page.

import { APP_VERSION } from './config.js';
import { $, toast, escapeHtml, showBusy, setBusyText, pickFile } from './ui.js';
import { getSettings, getSetting, setSetting } from './settings.js';
import { DISPLAY_MODES, applyDisplayMode } from './display-modes.js';
import * as tts from './tts.js';
import { Dictation, dictationStatus } from './dictation.js';
import { makeReadable } from './readable.js';
import { SessionLog, fmtDuration } from './session-log.js';
import { requestPersistence } from './store.js';
import * as worksheets from './worksheets.js';
import { UnsupportedFileError } from './worksheets.js';
import { blobToCanvas } from './image-tools.js';
import { cropImage } from './crop.js';
import { scanQr } from './qr-scan.js';
import { parseLink } from './links.js';
import { fetchDrive, fetchUrl, RemoteError } from './remote.js';
import { initViewer, openWorksheet, closeWorksheet, currentWorksheet, currentAnnotator, pageImages, visibleSpot, goToPage } from './viewer.js';
import { TEMPLATES, renderTemplate } from './templates.js';
import { COLORS, COLOR_NAMES, answerText } from './annotate.js';
import { shareWork, saveWork, emailSummary, sendToTeacher, needsName, joinInbox, INBOX_ERRORS } from './send.js';

const settings = getSettings();

// ── Display mode, voice and speed ──────────────────────
applyDisplayMode(settings.displayMode);
tts.setVoice(settings.voiceName);
tts.setRate(settings.speechRate);

// ── Student name ───────────────────────────────────────
const nameInput = $('#student-name');
nameInput.value = settings.studentName;
nameInput.addEventListener('input', () => {
  const name = nameInput.value.trim();
  setSetting('studentName', name);
  practice.student = name;
  if (wsSession) wsSession.student = name;
});

function askName() {
  const name = (prompt('What’s your name?') || '').trim();
  if (!name) return false;
  setSetting('studentName', name);
  nameInput.value = name;
  practice.student = name;
  if (wsSession) wsSession.student = name;
  return true;
}

// ── Sessions: the practice card, and the open worksheet ─
const practice = new SessionLog({ student: settings.studentName, worksheet: 'Practice' });
let wsSession = null;

// ── Errors from any worksheet source ──────────────────
function explain(err) {
  console.warn(err);
  if (err instanceof RemoteError || err instanceof UnsupportedFileError) return err.message;
  if (err && /password/i.test(err.name + err.message)) return 'That PDF is password-protected. Save a copy without a password and try again.';
  if (err && /Invalid PDF|InvalidPDF/i.test(err.name + err.message)) return 'That PDF looks damaged. Try downloading it again.';
  return 'Something went wrong opening that worksheet. Try again, or ask your teacher for a PDF.';
}

// ── Opening worksheets ────────────────────────────────
async function openRecord(record, { push = true } = {}) {
  const hide = showBusy('Opening the worksheet…');
  try {
    wsSession = SessionLog.fromState(record.session, { student: getSetting('studentName'), worksheet: record.title });
    await openWorksheet(record);
    wsSession.logEvent('open');
    resetTools();
    if (!(record.annotations || []).length) toast('Tap where your answer goes to type. Press and hold for ticks, crosses, drawing and more.', 6000);
    if (push) history.pushState({ ws: record.id }, '', '#ws=' + record.id);
  } catch (err) {
    closeWorksheet();
    toast(explain(err), 6000);
  } finally {
    hide();
  }
}

function backToHome() {
  if (history.state && history.state.ws) history.back();
  else showHome();
}

function showHome() {
  hidePageMenu();
  $('#draw-bar').hidden = true;
  flushSave();
  if (viewerDictation) viewerDictation.abort();
  tts.stop();
  closeWorksheet();
  wsSession = null;
  renderRecent();
}

// ── Saving answers and session data with the worksheet ─
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}
function flushSave() {
  clearTimeout(saveTimer);
  const rec = currentWorksheet(), annot = currentAnnotator();
  if (!rec || !annot || !wsSession) return;
  rec.annotations = annot.items;
  rec.session = wsSession.toState();
  worksheets.update(rec).catch(err => console.warn('Could not save', err));
}
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

window.addEventListener('popstate', e => {
  if (e.state && e.state.ws) worksheets.get(e.state.ws).then(r => r && openRecord(r, { push: false }));
  else showHome();
});

async function importFile(blob, opts) {
  const hide = showBusy('Getting the worksheet ready…');
  try {
    const record = await worksheets.fromFile(blob, {
      ...opts,
      onProgress: (n, total) => setBusyText(`Laying out page ${n} of ${total}…`),
    });
    hide();
    await openRecord(record);
  } catch (err) {
    hide();
    toast(explain(err), 7000);
  }
}

/** Photos: crop each page; "Add another page" takes the next photo. */
async function photoFlow(firstBlob, { fullFrame, enhance, from }) {
  const canvases = [];
  let blob = firstBlob;
  while (blob) {
    let source;
    try {
      source = await blobToCanvas(blob);
    } catch {
      toast('That picture couldn’t be opened. Try a JPG or PNG.', 5000);
      break;
    }
    const result = await cropImage(source, { fullFrame, enhance, pageNumber: canvases.length + 1 });
    if (!result) break;
    canvases.push(result.canvas);
    blob = result.another ? await askNextPhoto(canvases.length + 1) : null;
  }
  if (!canvases.length) return;
  const hide = showBusy('Saving the worksheet…');
  try {
    const title = worksheets.defaultPhotoTitle(from === 'paste' ? 'Pasted picture' : from === 'file' ? 'Picture' : 'Photo');
    const record = await worksheets.fromCanvases(canvases, { from, title });
    hide();
    await openRecord(record);
  } catch (err) {
    hide();
    toast(explain(err), 6000);
  }
}

/** The camera can only open from a tap, so ask before taking the next page. */
function askNextPhoto(n) {
  return new Promise(resolve => {
    const dlg = $('#next-page');
    $('#next-page-title').textContent = `Ready for page ${n}?`;
    const take = $('#next-page-take'), finish = $('#next-page-finish');
    const cleanup = () => { take.onclick = finish.onclick = null; dlg.close(); };
    take.onclick = () => { const p = pickFile($('#file-photo')); cleanup(); resolve(p); };
    finish.onclick = () => { cleanup(); resolve(null); };
    dlg.showModal();
  });
}

async function openLink(link) {
  const sourceKey = link.type === 'drive' ? 'drive:' + link.id : link.url;
  const existing = await worksheets.findBySource(sourceKey).catch(() => null);
  if (existing) {
    toast('Opening your saved copy.');
    return openRecord(existing);
  }
  const hide = showBusy('Downloading the worksheet…');
  try {
    const file = link.type === 'drive' ? await fetchDrive(link) : await fetchUrl(link.url);
    hide();
    await importFile(file.blob, {
      name: file.name, type: file.type, title: link.title || file.name,
      from: link.type === 'drive' ? 'drive' : 'web', sourceKey,
    });
  } catch (err) {
    hide();
    toast(explain(err), 7000);
  }
}

/** A class QR code: connect this iPad so Send to teacher goes to that sheet. */
async function connectTeacher(teacher) {
  if (teacher.join && teacher.expires && Date.now() > teacher.expires) {
    toast('That class QR code has expired. Ask your teacher for a new one.', 6000);
    return false;
  }
  if (!confirm(`Send your work to ${teacher.name}?\n\nOnly say yes to a QR code your teacher gave you.`)) return false;
  let saved = teacher;
  if (teacher.join) {
    const hide = showBusy('Connecting to your teacher…');
    const result = await joinInbox(teacher.url, teacher.join);
    hide();
    if (!result.ok || !result.key) {
      toast(INBOX_ERRORS[result.error] || 'Couldn’t connect: ' + result.error, 6000);
      return false;
    }
    saved = { name: teacher.name, url: teacher.url, secret: result.key };
  }
  setSetting('teacher', saved);
  renderTeacher();
  toast(`Connected. Your work will go to ${saved.name}.`, 4000);
  return true;
}

/** Text from a QR code, a paste, or the page address. */
function handleLinkText(text) {
  const link = parseLink(text);
  if (!link) {
    toast(/^https?:\/\//i.test(String(text).trim())
      ? 'That link isn’t a worksheet PagePal can open.'
      : 'That QR code isn’t a PagePal worksheet.', 5000);
    return false;
  }
  if (link.type === 'teacher') return connectTeacher(link.teacher);
  openLink(link);
  return true;
}

// ── "Get a worksheet" buttons ─────────────────────────
$('#btn-open').addEventListener('click', async () => {
  const file = await pickFile($('#file-open'));
  if (!file) return;
  if (/^image\//.test(file.type)) photoFlow(file, { fullFrame: true, enhance: false, from: 'file' });
  else importFile(file, { name: file.name, type: file.type, from: 'file' });
});

$('#btn-photo').addEventListener('click', async () => {
  const file = await pickFile($('#file-photo'));
  if (file) photoFlow(file, { fullFrame: false, enhance: true, from: 'camera' });
});

$('#btn-scan').addEventListener('click', async () => {
  const text = await scanQr();
  if (text) handleLinkText(text);
});

async function pasteFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    toast('Press Ctrl + V (or ⌘ + V) to paste.');
    return;
  }
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch {
    toast('PagePal wasn’t allowed to paste. Press Ctrl + V (⌘ + V), or allow pasting when asked.', 5000);
    return;
  }
  for (const item of items) {
    const imageType = item.types.find(t => t.startsWith('image/'));
    if (imageType) {
      photoFlow(await item.getType(imageType), { fullFrame: true, enhance: false, from: 'paste' });
      return;
    }
  }
  for (const item of items) {
    if (item.types.includes('text/plain')) {
      const text = await (await item.getType('text/plain')).text();
      handleLinkText(text);
      return;
    }
  }
  toast('There’s no picture to paste. Copy a picture or a worksheet link first.', 5000);
}
$('#btn-paste').addEventListener('click', pasteFromClipboard);

// New page: lined, handwriting, grids… for students' own work.
const templateDialog = $('#template-dialog');
let templatePreviews = false;
$('#btn-new').addEventListener('click', () => {
  if (!templatePreviews) {
    $('#template-grid').innerHTML = TEMPLATES.map(t => `
      <button type="button" class="template-card" role="listitem" data-template="${t.id}">
        <img src="${renderTemplate(t.id, 0.12).toDataURL('image/png')}" alt="">
        <strong>${escapeHtml(t.name)}</strong><span>${escapeHtml(t.desc)}</span>
      </button>`).join('');
    templatePreviews = true;
  }
  $('#template-title').value = '';
  templateDialog.showModal();
});
$('#template-grid').addEventListener('click', async e => {
  const card = e.target.closest('[data-template]');
  if (!card) return;
  templateDialog.close();
  const hide = showBusy('Making your page…');
  try {
    const record = await worksheets.fromTemplate(card.dataset.template, $('#template-title').value.trim());
    hide();
    await openRecord(record);
  } catch (err) {
    hide();
    toast(explain(err), 5000);
  }
});
templateDialog.addEventListener('click', e => { if (e.target === templateDialog) templateDialog.close(); });

$('#viewer-add-page').addEventListener('click', async () => {
  const rec = currentWorksheet();
  if (!rec || !rec.template) return;
  flushSave();
  const hide = showBusy('Adding a page…');
  try {
    await worksheets.addTemplatePage(rec);
    const fresh = await worksheets.get(rec.id);
    await openWorksheet(fresh);
    resetTools();
    goToPage(fresh.pageCount);
    toast(`Page ${fresh.pageCount} added.`);
  } catch (err) {
    toast(explain(err), 5000);
  } finally {
    hide();
  }
});

// Ctrl/⌘ + V on the home screen (not while typing in a box).
document.addEventListener('paste', e => {
  if (!$('#home') || $('#home').hidden) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const data = e.clipboardData;
  if (!data) return;
  const file = [...data.files].find(f => f.type.startsWith('image/') || f.type === 'application/pdf');
  if (file) {
    e.preventDefault();
    if (file.type === 'application/pdf') importFile(file, { name: file.name, type: file.type, from: 'paste' });
    else photoFlow(file, { fullFrame: true, enhance: false, from: 'paste' });
    return;
  }
  const text = data.getData('text/plain');
  if (text) { e.preventDefault(); handleLinkText(text); }
});

// ── Recent worksheets ──────────────────────────────────
let thumbUrls = [];
async function renderRecent() {
  const list = $('#recent-list');
  let items = [];
  try { items = await worksheets.recent(); } catch { /* IndexedDB unavailable */ }
  thumbUrls.forEach(u => URL.revokeObjectURL(u));
  thumbUrls = [];
  list.innerHTML = '';
  for (const w of items) {
    const li = document.createElement('li');
    li.className = 'recent-item';
    const url = w.thumb ? URL.createObjectURL(w.thumb) : '';
    if (url) thumbUrls.push(url);
    const when = new Date(w.updatedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    li.innerHTML = `
      <button class="recent-open" type="button">
        ${url ? `<img src="${url}" alt="">` : ''}
        <span class="recent-title">${escapeHtml(w.title)}</span>
        <span class="recent-date">${w.pageCount} page${w.pageCount === 1 ? '' : 's'} · ${when}</span>
      </button>
      <button class="recent-delete" type="button" aria-label="Remove ${escapeHtml(w.title)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>`;
    li.querySelector('.recent-open').addEventListener('click', () => openRecord(w));
    li.querySelector('.recent-delete').addEventListener('click', async () => {
      if (!confirm(`Remove “${w.title}” from this iPad?`)) return;
      await worksheets.remove(w.id);
      renderRecent();
    });
    list.appendChild(li);
  }
  $('#recent-empty').hidden = items.length > 0;
}

// ── Worksheet viewer and its Send dialog ──────────────
const sendDialog = $('#send-dialog');
const worksheetAnswer = () => (currentAnnotator() ? answerText(currentAnnotator().items) : '');
const worksheetWork = () => ({ session: wsSession, answer: worksheetAnswer(), pageImages });

function renderStatsInto(el, session, answer) {
  const st = session.stats(answer);
  const items = [
    ['Time working', fmtDuration(st.workingSecs)],
    ['Words', st.wordsWritten],
    ['Typed', st.typed],
    ['Spoken', st.dictated],
    ['Listened', st.listens],
  ];
  el.innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

initViewer({
  onBack: backToHome,
  annotations: {
    onChange: () => { if (wsSession) wsSession.activity(); scheduleSave(); updateTools(); },
    onSelect: () => updateTools(),
    onTypedWord: word => { if (wsSession) wsSession.logWord(word, 'typed'); },
    onLongPress: spot => showPageMenu(spot),
  },
  onSend: () => {
    if (!wsSession) return;
    flushSave();
    if (currentAnnotator()) currentAnnotator().deselect();
    const ws = currentWorksheet();
    wsSession.worksheet = ws ? ws.title : wsSession.worksheet;
    const teacher = getSetting('teacher');
    $('#send-dialog-who').textContent = (wsSession.student ? wsSession.student + ' · ' : '') + wsSession.worksheet;
    renderStatsInto($('#send-dialog-stats'), wsSession, worksheetAnswer());
    $('#sd-teacher').hidden = !teacher;
    $('#sd-connect').hidden = !!teacher;
    if (teacher) $('#sd-teacher').textContent = `Send to ${teacher.name}`;
    sendDialog.showModal();
  },
});

async function runSend(fn, work, button) {
  if (!work.session.student && !askName()) return;
  if (sendDialog.open) sendDialog.close();
  button.disabled = true;
  const hide = showBusy('Getting your work ready…');
  try {
    await fn(work);
  } catch (err) {
    console.warn(err);
    toast('Something went wrong. Try again.', 5000);
  } finally {
    hide();
    button.disabled = false;
  }
}

$('#sd-share').addEventListener('click', e => runSend(shareWork, worksheetWork(), e.currentTarget));
$('#sd-save').addEventListener('click', e => runSend(saveWork, worksheetWork(), e.currentTarget));
$('#sd-email').addEventListener('click', () => {
  if (!wsSession.student && !askName()) return;
  sendDialog.close();
  emailSummary(worksheetWork());
});
$('#sd-teacher').addEventListener('click', e => runSend(sendToTeacher, worksheetWork(), e.currentTarget));
sendDialog.addEventListener('click', e => { if (e.target === sendDialog) sendDialog.close(); });
$('#sd-connect').addEventListener('click', async () => {
  sendDialog.close();
  const text = await scanQr();
  if (text && (await handleLinkText(text)) && getSetting('teacher')) $('#viewer-send').click(); // back to Send, now with the teacher
});

// ── Answer tools on the worksheet ─────────────────────
let colorIndex = 0;

/** 'text' (tapping the page types) or 'draw' (finger draws until Done). */
function setTool(tool) {
  const annot = currentAnnotator();
  if (annot) annot.setTool(tool);
  $('#draw-bar').hidden = tool !== 'draw';
  $('#tool-add').classList.toggle('active', tool === 'draw');
}

function startDrawing() {
  setTool('draw');
  toast('Draw with your finger. Two fingers still zoom.', 3000);
}

$('#draw-done').addEventListener('click', () => setTool('text'));
$('#draw-undo').addEventListener('click', () => currentAnnotator() && currentAnnotator().undo());
$('#draw-color').addEventListener('click', () => $('#tool-color').click());
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#draw-bar').hidden) setTool('text');
});

// "Add" opens the long-press menu, for keyboards, switch access and anyone
// who hasn't discovered long press. Items go near the top of what's on screen.
$('#tool-add').addEventListener('click', () => {
  if (!$('#draw-bar').hidden) { setTool('text'); return; }
  const spot = visibleSpot();
  if (!spot) return;
  const r = $('#tool-add').getBoundingClientRect();
  // Centre of what's on screen; the student can drag it from there.
  showPageMenu({ page: spot.page, fx: 0.42, fy: Math.min(0.92, spot.y + 0.2), clientX: r.left + r.width / 2, clientY: r.bottom + 8, below: true });
});

function showColor() {
  $('#tool-color').style.setProperty('--swatch', COLORS[colorIndex]);
  $('#draw-color').style.setProperty('--swatch', COLORS[colorIndex]);
  $('#tool-color').setAttribute('aria-label', 'Colour: ' + COLOR_NAMES[colorIndex]);
}

function resetTools() {
  colorIndex = 0;
  showColor();
  setTool('text');
  updateTools();
}

function updateTools() {
  const annot = currentAnnotator();
  const sel = annot && annot.selected;
  $('#tool-smaller').disabled = $('#tool-bigger').disabled = $('#tool-delete').disabled = !sel;
  $('#tool-undo').disabled = !(annot && annot.canUndo());
  $('#tool-redo').disabled = !(annot && annot.canRedo());
  $('#tool-hear').disabled = !annot || !(sel && sel.type === 'text' ? (sel.text || '').trim() : worksheetAnswer());
  if (sel) {
    const i = COLORS.indexOf(sel.color);
    if (i >= 0) { colorIndex = i; showColor(); }
  }
}

$('#tool-color').addEventListener('click', () => {
  colorIndex = (colorIndex + 1) % COLORS.length;
  showColor();
  if (currentAnnotator()) currentAnnotator().setColor(COLORS[colorIndex]);
});
$('#tool-smaller').addEventListener('click', () => currentAnnotator() && currentAnnotator().resize(-1));
$('#tool-bigger').addEventListener('click', () => currentAnnotator() && currentAnnotator().resize(1));
$('#tool-delete').addEventListener('click', () => currentAnnotator() && currentAnnotator().deleteSelected());
$('#tool-undo').addEventListener('click', () => currentAnnotator() && currentAnnotator().undo());
$('#tool-redo').addEventListener('click', () => currentAnnotator() && currentAnnotator().redo());
// Keep the keyboard open: tapping a tool shouldn't take focus from the answer box.
document.querySelectorAll('.viewer-tools button').forEach(b => {
  if (b.id !== 'tool-mic') b.addEventListener('pointerdown', e => e.preventDefault());
});

$('#tool-hear').addEventListener('click', () => {
  const annot = currentAnnotator();
  if (!annot || !wsSession) return;
  const sel = annot.selected;
  const text = sel && sel.type === 'text' && (sel.text || '').trim() ? sel.text.trim() : worksheetAnswer();
  if (!text) { toast('Write or say an answer first.'); return; }
  wsSession.logListen(text, 'answer');
  tts.speak(text);
  scheduleSave();
});

// Hold to talk: words go into the selected answer box (or a new one).
let viewerDictation = null;
const viewerMic = $('#tool-mic');
if (dictationStatus() !== 'ok') {
  viewerMic.hidden = true;
} else {
  viewerDictation = new Dictation({
    onPreview: text => { $('#viewer-mic-preview').textContent = text || ''; },
    onState: on => {
      viewerMic.classList.toggle('listening', on);
      viewerMic.setAttribute('aria-pressed', String(on));
      viewerMic.querySelector('span').textContent = on ? (talkToggle ? 'Listening…' : 'Listening… let go') : 'Hold to talk';
      $('#talk-stop').hidden = !(on && talkToggle);
      if (!on) talkToggle = false;
      if (on) { tts.stop(); if (wsSession) wsSession.logEvent('dictation_start'); }
    },
    onResult: text => {
      const annot = currentAnnotator();
      if (!annot || !wsSession) return;
      if (!annot.insertText(text)) {
        const spot = visibleSpot();
        annot.addText(spot.page, spot.x, spot.y, text);
        toast('Your words went into a new box. Drag it to where the answer goes.', 4000);
      }
      wsSession.logPhrase(text, 'dictated');
      scheduleSave();
    },
    onEmpty: () => {
      if (wsSession) wsSession.logEvent('dictation_retry');
      toast('I didn’t catch that. Hold the button and try again.');
    },
    onError: msg => toast(msg, 5000),
  });
  viewerDictation.attachHoldButton(viewerMic);
}

// ── Long-press menu on the page ───────────────────────
const pageMenu = $('#page-menu');
let menuSpot = null;

function showPageMenu(spot) {
  menuSpot = spot;
  pageMenu.hidden = false;
  // Next to the finger, kept on screen.
  const w = pageMenu.offsetWidth, h = pageMenu.offsetHeight;
  const x = Math.min(window.innerWidth - w - 8, Math.max(8, spot.clientX - w / 2));
  let y = spot.below ? spot.clientY : spot.clientY - h - 16;
  if (y < 8) y = spot.clientY + 20;
  pageMenu.style.left = x + 'px';
  pageMenu.style.top = Math.min(window.innerHeight - h - 8, y) + 'px';
  pageMenu.querySelector('button').focus({ preventScroll: true });
}
function hidePageMenu() { pageMenu.hidden = true; menuSpot = null; }

document.addEventListener('pointerdown', e => {
  if (!pageMenu.hidden && !pageMenu.contains(e.target)) hidePageMenu();
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pageMenu.hidden) hidePageMenu(); });
window.addEventListener('resize', hidePageMenu);
$('#viewer-scroll').addEventListener('scroll', () => { if (!pageMenu.hidden) hidePageMenu(); }, { passive: true });

pageMenu.addEventListener('click', e => {
  const btn = e.target.closest('[data-add]');
  const annot = currentAnnotator();
  if (!btn || !menuSpot || !annot) return;
  const { page, fx, fy } = menuSpot;
  const what = btn.dataset.add;
  hidePageMenu();
  if (what === 'draw') {
    startDrawing();
  } else if (what === 'talk') {
    setTool('text');
    annot.placeAt('text', page, fx, fy, { focus: false });
    startTalking();
  } else {
    setTool('text');
    annot.placeAt(what, page, fx, fy);
  }
});

// "Talk" from the menu: listen until Stop is tapped (no holding needed).
let talkToggle = false;
function startTalking() {
  if (!viewerDictation) { toast('Talking isn’t available in this browser. Try Safari on iPad, or Chrome.', 5000); return; }
  talkToggle = true;
  viewerDictation.start();
}
$('#talk-stop').addEventListener('click', () => { if (viewerDictation) viewerDictation.stop(); });

// ── Practice card ─────────────────────────────────────
const readable = makeReadable(
  $('#practice-text'),
  'Tap any word to hear it, or press play to hear the whole sentence.',
  { onListen: (text, scope) => { practice.logListen(text, scope); renderPracticeStats(); } },
);
$('#btn-play').addEventListener('click', () => readable.play());

const answer = $('#practice-answer');
answer.addEventListener('beforeinput', e => {
  if (e.inputType === 'insertLineBreak' || (e.inputType === 'insertText' && /^[\s.,!?;:]$/.test(e.data || ''))) {
    const before = answer.value.slice(0, answer.selectionStart);
    const m = before.match(/([\p{L}\p{N}'’-]+)$/u);
    if (m) practice.logWord(m[1], 'typed');
  }
});
answer.addEventListener('input', () => { practice.activity(); renderPracticeStats(); });

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  textarea.value = before + lead + text + trail + after;
  const caret = (before + lead + text + trail).length;
  textarea.setSelectionRange(caret, caret);
}

const micBtn = $('#btn-mic');
const micPreview = $('#mic-preview');
const micMessage = $('#mic-message');
const micState = dictationStatus();
if (micState !== 'ok') {
  micBtn.hidden = true;
  micMessage.hidden = false;
  micMessage.textContent = micState === 'insecure'
    ? 'Talking needs a secure (https) page.'
    : 'Talking isn’t available in this browser. Try Safari on iPad, or Chrome.';
} else {
  const dictation = new Dictation({
    onPreview: text => { micPreview.textContent = text || ''; },
    onState: on => {
      micBtn.classList.toggle('listening', on);
      micBtn.setAttribute('aria-pressed', String(on));
      micBtn.querySelector('span').textContent = on ? 'Listening… let go to stop' : 'Hold to talk';
      if (on) { tts.stop(); practice.logEvent('dictation_start'); }
    },
    onResult: text => {
      insertAtCursor(answer, text);
      practice.logPhrase(text, 'dictated');
      renderPracticeStats();
    },
    onEmpty: () => {
      practice.logEvent('dictation_retry');
      toast('I didn’t catch that. Hold the button and try again.');
    },
    onError: msg => toast(msg, 5000),
  });
  dictation.attachHoldButton(micBtn);
}

$('#btn-hear-answer').addEventListener('click', () => {
  const text = answer.value.trim();
  if (!text) { toast('Write or say an answer first.'); return; }
  practice.logListen(text, 'answer');
  tts.speak(text);
  renderPracticeStats();
});

$('#btn-clear').addEventListener('click', () => {
  if (answer.value && !confirm('Clear your answer and start again?')) return;
  answer.value = '';
  Object.assign(practice, new SessionLog({ student: practice.student, worksheet: 'Practice' }));
  renderPracticeStats();
});

function renderPracticeStats() { renderStatsInto($('#stats'), practice, answer.value); }
renderPracticeStats();
setInterval(() => { if (practice.start && !$('#home').hidden) renderPracticeStats(); }, 1000);

const practiceWork = () => ({ session: practice, answer: answer.value });
$('#btn-share').addEventListener('click', e => { if (!needsName(practiceWork(), nameInput)) runSend(shareWork, practiceWork(), e.currentTarget); });
$('#btn-save').addEventListener('click', e => { if (!needsName(practiceWork(), nameInput)) runSend(saveWork, practiceWork(), e.currentTarget); });
$('#btn-email').addEventListener('click', () => { if (!needsName(practiceWork(), nameInput)) emailSummary(practiceWork()); });
$('#btn-send-teacher').addEventListener('click', e => { if (!needsName(practiceWork(), nameInput)) runSend(sendToTeacher, practiceWork(), e.currentTarget); });

// ── Settings dialog ────────────────────────────────────
const dialog = $('#settings');
const modeSel = $('#set-mode');
const voiceSel = $('#set-voice');
const rateInput = $('#set-rate');
const rateOut = $('#set-rate-out');

modeSel.innerHTML = Object.entries(DISPLAY_MODES)
  .map(([k, m]) => `<option value="${k}">${escapeHtml(m.label)}</option>`).join('');
modeSel.value = settings.displayMode;
const showModeDesc = () => { $('#set-mode-desc').textContent = DISPLAY_MODES[modeSel.value].desc; };
showModeDesc();
modeSel.addEventListener('change', () => {
  setSetting('displayMode', applyDisplayMode(modeSel.value));
  showModeDesc();
});

tts.onVoicesChanged(voices => {
  const chosen = getSetting('voiceName');
  voiceSel.innerHTML = '<option value="">Best available</option>' + voices
    .map(v => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`).join('');
  voiceSel.value = voices.some(v => v.name === chosen) ? chosen : '';
});
voiceSel.addEventListener('change', () => {
  setSetting('voiceName', voiceSel.value);
  tts.setVoice(voiceSel.value);
  tts.speak('Hello! This is my reading voice.');
});

const showRate = () => { rateOut.textContent = Number(rateInput.value).toFixed(2) + '×'; };
rateInput.value = settings.speechRate;
showRate();
rateInput.addEventListener('input', () => {
  showRate();
  setSetting('speechRate', Number(rateInput.value));
  tts.setRate(rateInput.value);
});
$('#btn-test-voice').addEventListener('click', () => tts.speak('This is how fast I will read.'));

const emailInput = $('#set-teacher-email');
emailInput.value = settings.teacherEmail || '';
emailInput.addEventListener('change', () => setSetting('teacherEmail', emailInput.value.trim()));

const suggestBox = $('#set-suggestions');
suggestBox.checked = settings.suggestions;
suggestBox.addEventListener('change', () => setSetting('suggestions', suggestBox.checked));

function renderTeacher() {
  const t = getSetting('teacher');
  $('#set-teacher-status').textContent = t ? `Sending work to ${t.name}` : 'Not connected';
  $('#btn-connect-teacher').textContent = t ? 'Scan a new class QR code' : 'Scan class QR code';
  $('#btn-disconnect-teacher').hidden = !t;
  $('#btn-send-teacher').hidden = !t;
  if (t) $('#btn-send-teacher span').textContent = `Send to ${t.name}`;
}
renderTeacher();
$('#btn-connect-teacher').addEventListener('click', async () => {
  dialog.close();
  const text = await scanQr();
  if (text) handleLinkText(text);
});
$('#btn-disconnect-teacher').addEventListener('click', () => {
  if (!confirm('Stop sending work to this teacher?')) return;
  setSetting('teacher', null);
  renderTeacher();
});

$('#app-version').textContent = 'v' + APP_VERSION;
$('#btn-settings').addEventListener('click', () => dialog.showModal());
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

// ── Install to Home Screen, offline support ────────────
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installCard = $('#install-card');
const installBtn = $('#btn-install');
let installPrompt = null;

if (!standalone) {
  if (isIOS) {
    installCard.hidden = false;
    $('#install-text').textContent =
      'Add PagePal to your Home Screen so your work is kept safe: tap the Share button at the top of Safari, then “Add to Home Screen”.';
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    installCard.hidden = false;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    installCard.hidden = true;
  });
}
window.addEventListener('appinstalled', () => { installCard.hidden = true; });

requestPersistence();

const secure = location.protocol === 'https:' || location.hostname === 'localhost';
if ('serviceWorker' in navigator && secure) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker not registered', err));
}

// ── Start-up: links in the address (from a QR code), or a worksheet to reopen ──
(async () => {
  await renderRecent();
  if (location.search) {
    const href = location.href;
    history.replaceState(null, '', location.pathname); // tidy the address bar
    if (parseLink(href)) handleLinkText(href);
    return;
  }
  const m = location.hash.match(/^#ws=(.+)$/);
  if (m) {
    const record = await worksheets.get(decodeURIComponent(m[1])).catch(() => null);
    history.replaceState(null, '', location.pathname);
    if (record) openRecord(record);
  }
})();

// Tells the start-up check in the page that the code loaded.
window.__pagepalReady = true;
