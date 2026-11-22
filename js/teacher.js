// Teacher page: makes the two kinds of QR code.
//  1. Worksheet QR — checks a Google Drive (or PDF) link will open for
//     students, then makes a QR code that opens it in PagePal.
//  2. Class QR — tests the teacher's PagePal Inbox (Google Sheet web app)
//     and makes the QR code students scan once to connect.

import qrcode from '../lib/qrcode.js';
import { $, toast, escapeHtml, downloadBlob } from './ui.js';
import { parseLink, worksheetLink, teacherLink, isInboxUrl } from './links.js';
import { driveInfo, driveReady, RemoteError } from './remote.js';
import { unsupportedReason, isDocx, cleanName } from './worksheets.js';
import { inboxVersion, newJoinCode } from './send.js';

const APP_BASE = new URL('./', location.href).href;

// ── QR drawing ─────────────────────────────────────────

function makeQr(text) {
  const qr = qrcode(0, 'M'); // size picked automatically, medium error correction
  qr.addData(text, 'Byte');
  qr.make();
  return qr;
}

function qrSvg(qr) {
  const n = qr.getModuleCount(), m = 4, size = n + m * 2;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/** A printable picture: QR code with the label underneath. */
function qrPng(qr, label, sub) {
  const n = qr.getModuleCount(), cell = 16, margin = 4 * cell, qrSize = n * cell + margin * 2;
  const c = document.createElement('canvas');
  c.width = qrSize;
  c.height = qrSize + 150;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.isDark(r, col)) ctx.fillRect(margin + col * cell, margin + r * cell, cell, cell);
  ctx.textAlign = 'center';
  ctx.font = 'bold 44px system-ui, Arial, sans-serif';
  ctx.fillText(label, c.width / 2, qrSize + 40, c.width - 40);
  ctx.font = '28px system-ui, Arial, sans-serif';
  ctx.fillStyle = '#444';
  ctx.fillText(sub, c.width / 2, qrSize + 95, c.width - 40);
  return new Promise(r => c.toBlob(r, 'image/png'));
}

function setStatus(el, kind, html) {
  el.hidden = !html;
  el.className = 'status ' + kind;
  el.innerHTML = html;
  if (html) reveal(el);
}

/** Results appear below the buttons, often off-screen: bring them into view. */
function reveal(el) {
  requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}

function printCard(section) {
  section.classList.add('printing');
  window.print();
  setTimeout(() => section.classList.remove('printing'), 500);
}

const fileSlug = s => String(s).trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'qr';

// ── 1. Worksheet QR ───────────────────────────────────

const SHARE_HELP = `<ol>
  <li>In Google Drive, right-click the file and choose <strong>Share › Share</strong>.</li>
  <li>Under <strong>General access</strong>, choose <strong>Anyone with the link</strong> (Viewer).</li>
  <li>Click <strong>Copy link</strong>, paste it here and try again.</li></ol>`;

const GOOGLE_TYPES = {
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.presentation': 'Google Slides',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.drawing': 'Google Drawing',
};

/** Decide whether students will be able to open this Drive file. */
function judgeDriveFile(meta) {
  const type = meta.mimeType || '';
  const name = meta.name || '';
  if (type === 'application/pdf') return { kind: 'ok', text: 'PDF: ready to go.' };
  if (GOOGLE_TYPES[type]) {
    const extra = type.endsWith('spreadsheet') ? ' Check the print layout (File › Print preview) looks right, as that is what students see.' : '';
    return { kind: 'ok', text: `${GOOGLE_TYPES[type]}: PagePal opens it as a PDF.${extra}` };
  }
  if (isDocx(type, name)) {
    return { kind: 'warn', text: 'Word file: PagePal lays it out on the iPad. Simple worksheets look right; text boxes, columns or WordArt may shift. For an exact copy, open it in Drive and choose <strong>File › Download › PDF</strong>, upload the PDF and use that link.' };
  }
  if (/^image\/(heic|heif)$/.test(type)) {
    return { kind: 'warn', text: 'iPhone photo (HEIC): opens on iPads but not on Chromebooks. A JPG or PDF works everywhere.' };
  }
  if (/^image\//.test(type)) return { kind: 'ok', text: 'Picture: ready to go.' };
  if (type.startsWith('application/vnd.google-apps.')) {
    return { kind: 'error', text: 'This kind of Google file (for example a Form or Site) can’t be opened as a worksheet. Use a Doc, Slides, PDF or picture.' };
  }
  const reason = unsupportedReason(type, name);
  return { kind: 'error', text: reason || `PagePal can’t open this type of file (${escapeHtml(type || 'unknown')}). Save it as a PDF and use that.` };
}

let wsQr = null;

async function makeWorksheetQr() {
  const status = $('#ws-status');
  const result = $('#ws-result');
  const raw = $('#ws-link').value.trim();
  result.hidden = true;
  const link = parseLink(raw);
  if (!link || link.type === 'teacher') {
    setStatus(status, 'error', 'Paste a Google Drive share link (or the web address of a PDF).');
    return;
  }
  let title = $('#ws-title').value.trim();
  let kind = 'ok', message = '';

  if (link.type === 'drive') {
    if (!driveReady()) {
      kind = 'warn';
      message = 'PagePal’s Google API key isn’t set up yet, so this link can’t be checked and students can’t open Drive worksheets until it is (see the README, “Google Drive set-up”).';
    } else {
      setStatus(status, 'ok', 'Checking the file…');
      let meta;
      try {
        meta = await driveInfo(link.id);
      } catch (err) {
        setStatus(status, 'error', (err instanceof RemoteError ? escapeHtml(err.message) : 'Couldn’t check that file.') + SHARE_HELP);
        return;
      }
      const verdict = judgeDriveFile(meta);
      if (verdict.kind === 'error') { setStatus(status, 'error', verdict.text); return; }
      kind = verdict.kind;
      message = `<strong>${escapeHtml(meta.name)}</strong>: ${verdict.text}`;
      if (!title) title = cleanName(meta.name);
    }
  } else {
    kind = 'warn';
    message = 'PDF link: the website hosting it must allow other sites to download it. Tap <strong>Test it</strong> before printing. Google Drive is more reliable.';
    if (unsupportedReason('', link.url)) { setStatus(status, 'error', unsupportedReason('', link.url)); return; }
  }

  const url = worksheetLink(APP_BASE, { driveId: link.id, kind: link.kind, pdfUrl: link.url, title });
  wsQr = { qr: makeQr(url), url, label: title || 'Worksheet' };
  setStatus(status, kind, message);
  $('#ws-qr').innerHTML = qrSvg(wsQr.qr);
  $('#ws-label').textContent = wsQr.label;
  $('#ws-link-out').textContent = url;
  $('#ws-test').href = url;
  result.hidden = false;
  reveal(result);
}

$('#ws-make').addEventListener('click', makeWorksheetQr);
$('#ws-link').addEventListener('keydown', e => { if (e.key === 'Enter') makeWorksheetQr(); });
$('#ws-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(wsQr.url); toast('Link copied.'); } catch { toast('Couldn’t copy. Select the link below and copy it.'); }
});
$('#ws-png').addEventListener('click', async () => {
  downloadBlob(await qrPng(wsQr.qr, wsQr.label, 'Scan with PagePal'), `QR-${fileSlug(wsQr.label)}.png`);
});
$('#ws-print').addEventListener('click', () => printCard($('#ws-result').closest('section')));

// ── 2. Class inbox QR ─────────────────────────────────
// The QR code holds a join code that expires, issued by the teacher's own
// script. The secret code (the sending key) is never put in the QR code.

let inQr = null;

function readInbox() {
  const name = $('#in-name').value.trim();
  const url = $('#in-url').value.trim();
  const secret = $('#in-secret').value.trim();
  const status = $('#in-status');
  if (!name) { setStatus(status, 'error', 'Type your name and class, as students know it.'); return null; }
  if (!isInboxUrl(url)) { setStatus(status, 'error', 'The web app URL should start with https://script.google.com/ and end in /exec. Copy it from Deploy › Manage deployments.'); return null; }
  if (!secret) { setStatus(status, 'error', 'Paste the secret code from the Apps Script Execution log (run <code>setup</code> to see it again).'); return null; }
  return { name, url, secret };
}

const CHECKLIST = `<ul>
  <li>the address is the <strong>Web app URL</strong> ending in <code>/exec</code>;</li>
  <li>in Deploy › Manage deployments, <strong>Execute as</strong> is Me and <strong>Who has access</strong> is Anyone;</li>
  <li>opening the address in a new tab shows <code>{"ok":true</code>.</li></ul>`;

$('#in-make').addEventListener('click', async () => {
  const teacher = readInbox();
  if (!teacher) return;
  const status = $('#in-status');
  $('#in-result').hidden = true;
  setStatus(status, 'ok', 'Checking your sheet…');

  const version = await inboxVersion(teacher.url);
  if (version === 0) { setStatus(status, 'error', 'Couldn’t reach your sheet. Check:' + CHECKLIST); return; }
  if (version < 2) {
    setStatus(status, 'error', 'Your sheet is running an older PagePal Inbox script. Paste in the new <code>PagePal-Inbox.gs</code> and <code>appsscript.json</code> (see the guide), run <code>setup</code>, then <strong>Deploy › Manage deployments › Edit › New version</strong>.');
    return;
  }
  const days = Number($('#in-days').value) || 7;
  const result = await newJoinCode(teacher.url, teacher.secret, days, teacher.name);
  if (!result.ok) {
    setStatus(status, 'error', result.error === 'wrong-code'
      ? 'Your sheet answered, but the secret code doesn’t match. Copy it again from the Execution log (run <code>setup</code> to show it).'
      : result.error === 'busy' ? 'Your sheet is busy. Wait a minute and try again.' : 'Couldn’t make the code. Check:' + CHECKLIST);
    return;
  }
  setStatus(status, 'ok', 'Connected to your sheet. Print or show the QR code below.' + (version < 4
    ? ' <br>This QR code works for PagePal now. To also take work from Word Helper (it gets its own spreadsheet), update the script to version 4: paste in the new <code>PagePal-Inbox.gs</code>, run <code>setup</code>, then <strong>Deploy › Manage deployments › Edit › New version</strong>.'
    : ''));
  const url = teacherLink(APP_BASE, { name: teacher.name, url: teacher.url, join: result.join, expires: result.expires });
  inQr = { qr: makeQr(url), url, label: teacher.name, expires: result.expires };
  const until = new Date(result.expires).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  $('#in-qr').innerHTML = qrSvg(inQr.qr);
  $('#in-label').textContent = 'Send your work to ' + teacher.name;
  $('#in-expiry').textContent = 'Connects new iPads until ' + until;
  $('#in-result').hidden = false;
  reveal($('#in-result'));
  try { localStorage.setItem('pagepal.teacherPage', JSON.stringify({ name: teacher.name, url: teacher.url })); } catch { /* ignore */ }
});

$('#in-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(inQr.url); toast('Class link copied. Paste it where a student would scan the QR code.'); }
  catch { toast('Couldn’t copy the link. Use the QR code instead.'); }
});
$('#in-png').addEventListener('click', async () => {
  downloadBlob(await qrPng(inQr.qr, inQr.label, $('#in-expiry').textContent), `Class-QR-${fileSlug(inQr.label)}.png`);
});
$('#in-print').addEventListener('click', () => printCard($('#in-result').closest('section')));

// Remember the name and address (never the secret code) for next time.
try {
  const saved = JSON.parse(localStorage.getItem('pagepal.teacherPage') || 'null');
  if (saved) { $('#in-name').value = saved.name || ''; $('#in-url').value = saved.url || ''; }
} catch { /* ignore */ }

// Tells the start-up check in the page that the code loaded.
window.__pagepalReady = true;
