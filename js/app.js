// PagePal — home screen wiring (Stage 0).
// Each feature lives in its own module; this file connects them to the page.

import { APP_VERSION } from './config.js';
import { $, $$, toast, escapeHtml } from './ui.js';
import { getSettings, setSetting } from './settings.js';
import { DISPLAY_MODES, applyDisplayMode } from './display-modes.js';
import * as tts from './tts.js';
import { Dictation, dictationStatus } from './dictation.js';
import { makeReadable } from './readable.js';
import { SessionLog, toCSV, toText, fmtDuration } from './session-log.js';
import { shareFiles, openEmailDraft, saveFile, reportFileName } from './export.js';
import { recentWorksheets, requestPersistence } from './store.js';

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
  session.student = name;
});

// ── Practice session data ──────────────────────────────
const session = new SessionLog({ student: settings.studentName, worksheet: 'Practice' });

// ── Worksheet buttons (built in later stages) ─────────
$$('[data-coming]').forEach(btn => {
  btn.addEventListener('click', () => toast(btn.dataset.coming + ' is coming in the next update.'));
});

// ── Recent worksheets ──────────────────────────────────
async function renderRecent() {
  const list = $('#recent-list');
  let items = [];
  try { items = await recentWorksheets(); } catch { /* IndexedDB unavailable */ }
  list.innerHTML = items.map(w => `<li class="card">${escapeHtml(w.title || 'Worksheet')}</li>`).join('');
  $('#recent-empty').hidden = items.length > 0;
}
renderRecent();

// ── Practice: tap-to-hear text ─────────────────────────
const readable = makeReadable(
  $('#practice-text'),
  'Tap any word to hear it, or press play to hear the whole sentence.',
  { onListen: (text, scope) => { session.logListen(text, scope); renderStats(); } },
);
$('#btn-play').addEventListener('click', () => readable.play());

// ── Practice: typing ───────────────────────────────────
const answer = $('#practice-answer');

// Log a typed word each time the student finishes one (space or punctuation).
answer.addEventListener('beforeinput', e => {
  if (e.inputType === 'insertLineBreak' || (e.inputType === 'insertText' && /^[\s.,!?;:]$/.test(e.data || ''))) {
    const before = answer.value.slice(0, answer.selectionStart);
    const m = before.match(/([\p{L}\p{N}'’-]+)$/u);
    if (m) session.logWord(m[1], 'typed');
  }
});
answer.addEventListener('input', () => { session.activity(); renderStats(); });

/** Insert text at the cursor, adding spaces where needed. */
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

// ── Practice: dictation ────────────────────────────────
const micBtn = $('#btn-mic');
const micPreview = $('#mic-preview');
const micMessage = $('#mic-message');
const status = dictationStatus();

if (status !== 'ok') {
  micBtn.hidden = true;
  micMessage.hidden = false;
  micMessage.textContent = status === 'insecure'
    ? 'Talking needs a secure (https) page.'
    : 'Talking isn’t available in this browser. Try Safari on iPad, or Chrome.';
} else {
  const dictation = new Dictation({
    onPreview: text => { micPreview.textContent = text || ''; },
    onState: on => {
      micBtn.classList.toggle('listening', on);
      micBtn.setAttribute('aria-pressed', String(on));
      micBtn.querySelector('span').textContent = on ? 'Listening… let go to stop' : 'Hold to talk';
      if (on) { tts.stop(); session.logEvent('dictation_start'); }
    },
    onResult: text => {
      insertAtCursor(answer, text);
      session.logPhrase(text, 'dictated');
      renderStats();
    },
    onEmpty: () => {
      session.logEvent('dictation_retry');
      toast('I didn’t catch that. Hold the button and try again.');
    },
    onError: msg => toast(msg, 5000),
  });
  dictation.attachHoldButton(micBtn);
}

// ── Practice: hear my answer, clear ────────────────────
$('#btn-hear-answer').addEventListener('click', () => {
  const text = answer.value.trim();
  if (!text) { toast('Write or say an answer first.'); return; }
  session.logListen(text, 'answer');
  tts.speak(text);
  renderStats();
});

$('#btn-clear').addEventListener('click', () => {
  if (answer.value && !confirm('Clear your answer and start again?')) return;
  answer.value = '';
  Object.assign(session, new SessionLog({ student: session.student, worksheet: 'Practice' }));
  renderStats();
});

// ── Stats and sending to the teacher ──────────────────
function renderStats() {
  const st = session.stats(answer.value);
  const items = [
    ['Time working', fmtDuration(st.workingSecs)],
    ['Words', st.wordsWritten],
    ['Typed', st.typed],
    ['Spoken', st.dictated],
    ['Listened', st.listens],
  ];
  $('#stats').innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}
renderStats();
setInterval(() => { if (session.start) renderStats(); }, 1000);

function needName() {
  if (session.student) return false;
  toast('Type your name first, so your teacher knows it’s yours.');
  nameInput.focus();
  return true;
}

function emailSummary() {
  openEmailDraft({
    to: getSettings().teacherEmail || '',
    subject: `PagePal: ${session.student} – ${session.worksheet}`,
    body: toText(session, answer.value),
  });
}

$('#btn-share').addEventListener('click', async () => {
  if (needName()) return;
  const csv = toCSV(session, answer.value);
  const file = new File(['﻿' + csv], reportFileName(session.student, session.worksheet, 'csv'), { type: 'text/csv' });
  const result = await shareFiles({
    title: `PagePal: ${session.student}`,
    text: toText(session, answer.value),
    files: [file],
  });
  if (result === 'unsupported') {
    toast('Sharing files isn’t available here, so an email draft is opening instead.');
    emailSummary();
  }
});

$('#btn-email').addEventListener('click', () => { if (!needName()) emailSummary(); });

$('#btn-save').addEventListener('click', () => {
  if (needName()) return;
  saveFile(toCSV(session, answer.value), reportFileName(session.student, session.worksheet, 'csv'));
  toast('Saved. On iPad, look in the Files app › Downloads.');
});

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
  const chosen = getSettings().voiceName;
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

$('#app-version').textContent = 'v' + APP_VERSION;
$('#btn-settings').addEventListener('click', () => dialog.showModal());
// Close when tapping the dimmed area outside the dialog.
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
