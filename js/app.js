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
import { initViewer, openWorksheet, closeWorksheet, currentWorksheet, pageImages } from './viewer.js';
import { shareWork, saveWork, emailSummary, sendToTeacher, needsName } from './send.js';

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
    await openWorksheet(record);
    wsSession = new SessionLog({ student: getSetting('studentName'), worksheet: record.title });
    wsSession.logEvent('open');
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
  closeWorksheet();
  wsSession = null;
  renderRecent();
}

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

function connectTeacher(teacher) {
  if (!confirm(`Send your work to ${teacher.name}?`)) return;
  setSetting('teacher', teacher);
  renderTeacher();
  toast(`Connected. Your work will go to ${teacher.name}.`, 4000);
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
  if (link.type === 'teacher') connectTeacher(link.teacher);
  else openLink(link);
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
      if (handleLinkText(text)) return;
      return;
    }
  }
  toast('There’s no picture to paste. Copy a picture or a worksheet link first.', 5000);
}
$('#btn-paste').addEventListener('click', pasteFromClipboard);

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
const worksheetWork = () => ({ session: wsSession, answer: '', pageImages });

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
  onSend: () => {
    if (!wsSession) return;
    const ws = currentWorksheet();
    wsSession.worksheet = ws ? ws.title : wsSession.worksheet;
    const teacher = getSetting('teacher');
    $('#send-dialog-who').textContent = (wsSession.student ? wsSession.student + ' · ' : '') + wsSession.worksheet;
    renderStatsInto($('#send-dialog-stats'), wsSession, '');
    $('#sd-teacher').hidden = !teacher;
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
