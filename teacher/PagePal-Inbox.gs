/**
 * PagePal Inbox (version 2)
 * Receives work that students send from PagePal and files it in this
 * Google Sheet, with page pictures saved to your Google Drive.
 *
 * Set-up (see the teacher guide):
 *   1. Paste this whole file into Extensions › Apps Script › Code.gs.
 *   2. Project Settings › tick "Show appsscript.json manifest file in editor",
 *      then replace appsscript.json with the one in the guide. That limits the
 *      script to this sheet and to files it creates itself in your Drive.
 *   3. Run setup() once and allow access.
 *   4. Deploy › New deployment › Web app — Execute as: Me, Who has access: Anyone.
 *
 * Security, in brief:
 *   - Class QR codes carry a short-lived JOIN code, not the sending key.
 *     A photographed QR code stops working when it expires.
 *   - Sending needs the KEY, which an iPad only receives by joining.
 *   - resetCode() makes a new key: every iPad must scan a new QR code.
 *   - Files must really be JPEG, PNG or PDF (checked by their contents),
 *     5 MB at most; sends are rate-limited.
 *   - The sheet holds no formulas at all: students' text is stored as text
 *     and the page links are plain links.
 *   - Nothing can be read back through the web address.
 */

const VERSION = 2;
const SHEET_NAME = 'Submissions';
const FOLDER_NAME = 'PagePal submissions';
const HEADERS = [
  'Received', 'Student', 'Worksheet', 'Class',
  'Time working (min)', 'Total time (min)', 'Words written',
  'Typed', 'Spoken', 'Suggestions', 'Spell corrections', 'Assistance %',
  'Times listened', 'Words listened to', 'Answer', 'Page', 'PDF', 'Notes',
];
const MAX_FILE_BYTES = 5 * 1024 * 1024;   // a page picture is usually 0.2–0.5 MB
const MAX_BODY_CHARS = 16 * 1024 * 1024;  // whole request, as text
const MAX_PER_MINUTE = 60;                // a class of 30 sending at once is fine
const MAX_PER_DAY = 1500;
const MAX_JOIN_DAYS = 80;                 // about one school term

// Real file contents start with these bytes, whatever the sender claims.
const SIGNATURES = {
  'image/jpeg': { ext: '.jpg', bytes: [0xFF, 0xD8, 0xFF] },
  'image/png': { ext: '.png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  'application/pdf': { ext: '.pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2D] }, // %PDF-
};

// ── Things you run from the editor ─────────────────────

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('KEY')) props.setProperty('KEY', newCode_(24));
  getSheet_();
  try {
    getFolderId_();
  } catch (err) {
    Logger.log('Set-up could not reach Google Drive: ' + err.message +
      '\nCheck that appsscript.json was replaced as the guide shows, then run setup again.');
    throw err;
  }
  Logger.log('Set-up done. Your secret code is: ' + props.getProperty('KEY') +
    '\nPaste it into the PagePal teacher page to make your class QR code. Keep it private.');
}

/** New secret code. Every iPad must scan a new class QR code afterwards. */
function resetCode() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('KEY', newCode_(24));
  props.deleteProperty('JOINS');
  Logger.log('New secret code: ' + props.getProperty('KEY') +
    '\nMake a new class QR code on the PagePal teacher page; students scan it again.');
}

// ── The web app ────────────────────────────────────────

/** Visiting the address in a browser: a quick "is it working?" check. Reveals nothing. */
function doGet() {
  return json_({ ok: true, app: 'PagePal Inbox', version: VERSION });
}

function doPost(e) {
  const body = (e && e.postData && e.postData.contents) || '';
  if (body.length > MAX_BODY_CHARS) return json_({ ok: false, error: 'too-big' });
  let data;
  try { data = JSON.parse(body || '{}'); } catch (err) { return json_({ ok: false, error: 'bad-request' }); }
  try {
    if (!withLock_(underRateLimit_)) return json_({ ok: false, error: 'busy' });
    if (data.action === 'join') return json_(withLock_(function () { return join_(data); }));
    if (data.action === 'newJoin') return json_(withLock_(function () { return newJoin_(data); }));
    return json_(submit_(data));
  } catch (err) {
    return json_({ ok: false, error: 'server', detail: String(err && err.message || err).slice(0, 200) });
  }
}

/**
 * Run fn while holding the script lock. Only short bookkeeping happens
 * inside it; slow uploads happen outside, so a whole class can send at once.
 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('busy');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ── Joining (class QR codes) ───────────────────────────

/** The teacher page asks for a join code (proving it knows the key). */
function newJoin_(data) {
  const props = PropertiesService.getScriptProperties();
  if (!sameCode_(data.secret, props.getProperty('KEY'))) return { ok: false, error: 'wrong-code' };
  const days = Math.max(1, Math.min(MAX_JOIN_DAYS, Number(data.days) || 7));
  const joins = liveJoins_();
  const join = newCode_(16);
  const expires = Date.now() + days * 86400000;
  joins[join] = { exp: expires, label: text_(data.label, 80) };
  props.setProperty('JOINS', JSON.stringify(joins));
  return { ok: true, join: join, expires: expires };
}

/** An iPad scanned a class QR code: swap the join code for the sending key. */
function join_(data) {
  const props = PropertiesService.getScriptProperties();
  const joins = liveJoins_();
  const entry = joins[String(data.join || '')];
  if (!entry) return { ok: false, error: 'expired-join' };
  return { ok: true, key: props.getProperty('KEY'), name: entry.label };
}

/** Join codes that haven't expired (expired ones are tidied away). */
function liveJoins_() {
  const props = PropertiesService.getScriptProperties();
  let joins = {};
  try { joins = JSON.parse(props.getProperty('JOINS') || '{}'); } catch (err) { joins = {}; }
  const now = Date.now();
  Object.keys(joins).forEach(function (k) { if (!(joins[k].exp > now)) delete joins[k]; });
  return joins;
}

// ── Receiving work ─────────────────────────────────────

function submit_(data) {
  if (!sameCode_(data.secret, PropertiesService.getScriptProperties().getProperty('KEY'))) {
    return { ok: false, error: 'wrong-code' };
  }
  const st = data.stats || {};
  const student = text_(data.student, 80) || 'Unknown';
  const worksheet = text_(data.worksheet, 100) || 'Worksheet';
  const label = (data.test ? 'TEST ' : '') + student;
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
  const notes = [];

  let pageUrl = '', pdfUrl = '';
  if (data.image || data.pdf) {
    const folderId = withLock_(function () { return subFolderId_(worksheet.replace(/[\/\\]/g, '-')); });
    pageUrl = saveFile_(folderId, data.image, student + ' – ' + stamp, notes);
    pdfUrl = saveFile_(folderId, data.pdf, student + ' – ' + stamp, notes);
  }

  const row = [
    new Date(), cell_(label), cell_(worksheet), cell_(text_(data.className, 80)),
    mins_(st.workingSecs), mins_(st.totalSecs), num_(st.wordsWritten),
    num_(st.typed), num_(st.dictated), num_(st.suggestion), num_(st.corrected), num_(st.assistanceRate),
    num_(st.listens), cell_(text_((st.wordsListened || []).join(', '), 2000)),
    cell_(text_(data.answer, 40000)),
    '', '', // links are added below as plain links, not formulas
    cell_(notes.join(' ')),
  ];
  withLock_(function () {
    const sheet = getSheet_();
    sheet.appendRow(row);
    const r = sheet.getLastRow();
    setLink_(sheet.getRange(r, 16), pageUrl, 'View page');
    setLink_(sheet.getRange(r, 17), pdfUrl, 'View PDF');
  });
  return { ok: true, warnings: notes };
}

/**
 * file = {type: 'image/jpeg', base64: '...'}. Saved only if its contents
 * really are that type and it's small enough. Returns a Drive link or ''.
 */
function saveFile_(folderId, file, baseName, notes) {
  if (!file || !file.base64) return '';
  const sig = SIGNATURES[file.type];
  if (!sig) { notes.push('File refused: not a picture or PDF.'); return ''; }
  let bytes;
  try { bytes = Utilities.base64Decode(String(file.base64)); } catch (err) { notes.push('File refused: damaged.'); return ''; }
  if (bytes.length > MAX_FILE_BYTES) { notes.push('File refused: over 5 MB.'); return ''; }
  if (!startsWith_(bytes, sig.bytes)) { notes.push('File refused: contents don’t match a ' + sig.ext + ' file.'); return ''; }
  const blob = Utilities.newBlob(bytes, file.type, baseName + sig.ext);
  return driveUpload_(blob, folderId);
}

function startsWith_(bytes, sig) {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if ((bytes[i] & 0xFF) !== sig[i]) return false;
  return true;
}

// ── Google Drive, limited to files this script creates ───
// (Apps Script's built-in DriveApp always asks for your whole Drive, so the
//  Drive API is used directly with the narrower "drive.file" permission.)

const DRIVE = 'https://www.googleapis.com/drive/v3/files';

function driveCall_(method, url, payload, contentType) {
  const res = UrlFetchApp.fetch(url, {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    contentType: contentType,
    payload: payload,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code >= 300) throw new Error('Drive error ' + code + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

function createFolder_(name, parentId) {
  const meta = { name: name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  return driveCall_('post', DRIVE + '?fields=id', JSON.stringify(meta), 'application/json').id;
}

function folderExists_(id) {
  const cache = CacheService.getScriptCache();
  if (cache.get('folder-' + id)) return true; // checked in the last 10 minutes
  try {
    const f = driveCall_('get', DRIVE + '/' + encodeURIComponent(id) + '?fields=id,trashed');
    if (f.trashed) return false;
    cache.put('folder-' + id, '1', 600);
    return true;
  } catch (err) {
    return false;
  }
}

function getFolderId_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id && folderExists_(id)) return id;
  const created = createFolder_(FOLDER_NAME);
  props.setProperty('FOLDER_ID', created);
  props.deleteProperty('SUBFOLDERS');
  return created;
}

/** One sub-folder per worksheet, remembered by name. */
function subFolderId_(name) {
  const props = PropertiesService.getScriptProperties();
  const parent = getFolderId_();
  let map = {};
  try { map = JSON.parse(props.getProperty('SUBFOLDERS') || '{}'); } catch (err) { map = {}; }
  if (map[name] && folderExists_(map[name])) return map[name];
  map[name] = createFolder_(name, parent);
  props.setProperty('SUBFOLDERS', JSON.stringify(map));
  return map[name];
}

function driveUpload_(blob, folderId) {
  const boundary = 'pagepal' + newCode_(12);
  const meta = JSON.stringify({ name: blob.getName(), parents: [folderId] });
  const head = Utilities.newBlob('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta +
    '\r\n--' + boundary + '\r\nContent-Type: ' + blob.getContentType() + '\r\n\r\n').getBytes();
  const tail = Utilities.newBlob('\r\n--' + boundary + '--').getBytes();
  const body = head.concat(blob.getBytes(), tail);
  const file = driveCall_('post',
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    body, 'multipart/related; boundary=' + boundary);
  return file.webViewLink || ('https://drive.google.com/file/d/' + file.id + '/view');
}

// ── Helpers ────────────────────────────────────────────

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  } else if (sheet.getRange(1, HEADERS.length).getValue() === '') {
    sheet.getRange(1, HEADERS.length).setValue(HEADERS[HEADERS.length - 1]).setFontWeight('bold'); // added "Notes" in v2
  }
  return sheet;
}

/** Limits how fast the sheet can be filled, so a leaked code can't flood it. */
function underRateLimit_() {
  const cache = CacheService.getScriptCache();
  const minuteKey = 'm' + Math.floor(Date.now() / 60000);
  const perMinute = Number(cache.get(minuteKey) || 0) + 1;
  cache.put(minuteKey, String(perMinute), 120);
  if (perMinute > MAX_PER_MINUTE) return false;
  const props = PropertiesService.getScriptProperties();
  const dayKey = 'day-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  let day = { key: '', n: 0 };
  try { day = JSON.parse(props.getProperty('DAYCOUNT') || '{"key":"","n":0}'); } catch (err) { /* reset */ }
  if (day.key !== dayKey) day = { key: dayKey, n: 0 };
  day.n += 1;
  props.setProperty('DAYCOUNT', JSON.stringify(day));
  return day.n <= MAX_PER_DAY;
}

function newCode_(length) {
  let s = '';
  while (s.length < length) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, length);
}

/** Compare codes without leaking how much matched through timing. */
function sameCode_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function text_(value, max) {
  return value === undefined || value === null ? '' : String(value).slice(0, max).trim();
}

/**
 * Text starting with = + - @ (or a tab / return) is stored as plain text,
 * never a formula. The leading apostrophe is Sheets' "this is text" mark:
 * it isn't shown in the cell, so "-5" or "= 10" appear exactly as typed.
 */
function cell_(s) {
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function num_(n) {
  return typeof n === 'number' && isFinite(n) ? n : '';
}

function mins_(secs) {
  return typeof secs === 'number' && isFinite(secs) ? Math.round(secs / 6) / 10 : '';
}

/** A plain clickable link (no formula), only to Drive files this script made. */
function setLink_(range, url, label) {
  if (!/^https:\/\/drive\.google\.com\/[\w\/?=&.-]+$/.test(url || '')) return;
  range.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(label).setLinkUrl(url).build());
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
