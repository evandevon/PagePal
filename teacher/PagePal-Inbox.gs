/**
 * PagePal Inbox (version 4)
 * Receives work that students send from PagePal and Word Helper. Each tool
 * keeps its own spreadsheet and its own folder in your Google Drive:
 *   PagePal     → this Google Sheet; PDFs in
 *                 PagePal submissions › Class › Worksheet › "Student – Worksheet – date time.pdf"
 *   Word Helper → a "Word Helper submissions" spreadsheet that this script makes
 *                 inside a Word Helper submissions folder; PDFs in
 *                 Word Helper submissions › Class › "Student – Word Helper – date time.pdf"
 * One class QR code works for both tools.
 *
 * Set-up (see the teacher guide):
 *   1. Paste this whole file into Extensions › Apps Script › Code.gs.
 *   2. Project Settings › tick "Show appsscript.json manifest file in editor",
 *      then replace appsscript.json with the one in the guide. That limits the
 *      script to this sheet and to files it creates itself in your Drive.
 *   3. Click the + next to "Services" (left-hand side), choose "Google Sheets API",
 *      click Add. (Lets the script fill in the Word Helper spreadsheet it makes.)
 *   4. Run setup() once and allow access.
 *   5. Deploy › New deployment › Web app — Execute as: Me, Who has access: Anyone.
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
 *   - The script can only open this sheet and files it made itself (such as
 *     the Word Helper spreadsheet), never your other files.
 */

const VERSION = 4;
const SHEET_NAME = 'Submissions';
const FOLDER_NAME = 'PagePal submissions';
const HEADERS = [
  'Received', 'Student', 'Worksheet', 'Class',
  'Time working (min)', 'Total time (min)', 'Words written',
  'Typed', 'Spoken', 'Suggestions', 'Spell corrections', 'Assistance %',
  'Times listened', 'Words listened to', 'Answer', 'Page', 'PDF', 'Notes',
];
const WH_HEADERS = [
  'Received', 'Student', 'Class',
  'Time working (min)', 'Total time (min)', 'Words written',
  'Typed', 'Spoken', 'Suggestions', 'Spell corrections', 'Assistance %',
  'Times listened', 'Words listened to', 'Words defined', 'Writing', 'PDF', 'Notes',
];
// Each tool's Drive folder, and the script properties that remember it.
const TOOLS = {
  pagepal: { folder: FOLDER_NAME, folderProp: 'FOLDER_ID', subsProp: 'SUBFOLDERS' },
  'word-helper': { folder: 'Word Helper submissions', folderProp: 'WH_FOLDER_ID', subsProp: 'WH_SUBFOLDERS',
    sheetName: 'Word Helper submissions', sheetProp: 'WH_SHEET_ID', tabProp: 'WH_SHEET_TAB' },
};
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
    getFolderId_('pagepal');
    withLock_(wordHelperSheet_); // makes the Word Helper folder and spreadsheet
  } catch (err) {
    if (/Sheets API/.test(err.message)) {
      Logger.log('One more switch to turn on: in the Apps Script editor, click the + next to "Services" ' +
        '(left-hand side), choose "Google Sheets API", click Add, then run setup again. ' +
        '(It lets this script fill in the Word Helper spreadsheet it makes; it still can\'t open your other files.)');
    } else {
      Logger.log('Set-up could not reach Google Drive: ' + err.message +
        '\nCheck that appsscript.json was replaced as the guide shows, then run setup again.');
    }
    throw err;
  }
  Logger.log('Set-up done. Word Helper work goes to: https://docs.google.com/spreadsheets/d/' +
    props.getProperty('WH_SHEET_ID') + '\nYour secret code is: ' + props.getProperty('KEY') +
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
  return json_({ ok: true, app: 'PagePal Inbox', version: VERSION, tools: Object.keys(TOOLS) });
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
  const tool = data.tool === undefined ? 'pagepal' : String(data.tool);
  if (tool === 'word-helper') return wordHelperSubmit_(data);
  if (tool !== 'pagepal') return { ok: false, error: 'bad-request' };
  const st = data.stats || {};
  const student = text_(data.student, 80) || 'Unknown';
  const worksheet = text_(data.worksheet, 100) || 'Worksheet';
  const label = (data.test ? 'TEST ' : '') + student;
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
  const notes = [];

  // Drive: PagePal submissions › Class › Worksheet › "Student – Worksheet – date time.pdf"
  // so a class's answers to one worksheet sit together, sorted by student.
  let pageUrl = '', pdfUrl = '';
  if (data.image || data.pdf) {
    const className = safeName_(text_(data.className, 80)) || 'My class';
    const folderId = withLock_(function () { return subFolderId_('pagepal', [className, safeName_(worksheet)]); });
    const fileName = [label, worksheet, stamp].map(safeName_).join(' – ');
    pageUrl = saveFile_(folderId, data.image, fileName, notes);
    pdfUrl = saveFile_(folderId, data.pdf, fileName, notes);
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
 * Word Helper writing → the Word Helper spreadsheet. A PDF, if sent, goes in
 * Word Helper submissions › Class › "Student – Word Helper – date time.pdf".
 */
function wordHelperSubmit_(data) {
  const st = data.stats || {};
  const student = text_(data.student, 80) || 'Unknown';
  const label = (data.test ? 'TEST ' : '') + student;
  const className = text_(data.className, 80);
  const tz = Session.getScriptTimeZone();
  const notes = [];
  let pdfUrl = '';
  if (data.pdf) {
    const folderId = withLock_(function () { return subFolderId_('word-helper', [safeName_(className) || 'My class']); });
    const stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HHmm');
    pdfUrl = saveFile_(folderId, data.pdf, [label, 'Word Helper', stamp].map(safeName_).join(' – '), notes);
  }
  const words = function (list) { return text_((Array.isArray(list) ? list : []).join(', '), 2000); };
  const row = [
    Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'), label, className,
    mins_(st.workingSecs), mins_(st.totalSecs), num_(st.wordsWritten),
    num_(st.typed), num_(st.dictated), num_(st.suggestion), num_(st.corrected), num_(st.assistanceRate),
    num_(st.listens), words(st.wordsListened), words(st.wordsDefined),
    text_(data.answer, 40000), { link: pdfUrl, label: 'View PDF' }, notes.join(' '),
  ];
  const target = withLock_(wordHelperSheet_);
  appendCells_(target, [row]);
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

// ── Google Drive and Sheets, limited to files this script creates ───
// (Apps Script's built-in DriveApp and SpreadsheetApp.openById ask for your
//  whole Drive or every spreadsheet, so the Drive and Sheets APIs are used
//  directly with the narrower "drive.file" permission.)

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

function driveCall_(method, url, payload, contentType) {
  const res = UrlFetchApp.fetch(url, {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    contentType: contentType,
    payload: payload,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code >= 300) throw new Error('Google error ' + code + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

function createFolder_(name, parentId) {
  const meta = { name: name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  return driveCall_('post', DRIVE + '?fields=id', JSON.stringify(meta), 'application/json').id;
}

function fileExists_(id) {
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

/** A tool's top folder in Drive, made if it's missing or was deleted. */
function getFolderId_(tool) {
  const t = TOOLS[tool];
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(t.folderProp);
  if (id && fileExists_(id)) return id;
  const created = createFolder_(t.folder);
  props.setProperty(t.folderProp, created);
  props.deleteProperty(t.subsProp);
  return created;
}

/**
 * Nested sub-folders, e.g. ['3/4K', 'Fractions page 12'], each made once and
 * remembered by its path. Names that differ only in capitals share a folder.
 */
function subFolderId_(tool, names) {
  const props = PropertiesService.getScriptProperties();
  const subsProp = TOOLS[tool].subsProp;
  let map = {};
  try { map = JSON.parse(props.getProperty(subsProp) || '{}'); } catch (err) { map = {}; }
  let parent = getFolderId_(tool), path = '', changed = false;
  names.forEach(function (name) {
    path += '/' + name.toLowerCase();
    if (!(map[path] && fileExists_(map[path]))) { map[path] = createFolder_(name, parent); changed = true; }
    parent = map[path];
  });
  if (changed) props.setProperty(subsProp, JSON.stringify(map));
  return parent;
}

/**
 * The Word Helper spreadsheet: {id, tab}. Made by this script inside the
 * Word Helper folder (so "drive.file" covers it), and made again if deleted.
 */
function wordHelperSheet_() {
  const t = TOOLS['word-helper'];
  const props = PropertiesService.getScriptProperties();
  let created = props.getProperty(t.sheetProp);
  if (created && fileExists_(created)) {
    const ready = props.getProperty(t.tabProp);
    if (ready !== null) return { id: created, tab: Number(ready) };
    // made on an earlier run that stopped part-way: finish preparing it below
  } else {
    const meta = { name: t.sheetName, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [getFolderId_('word-helper')] };
    created = driveCall_('post', DRIVE + '?fields=id', JSON.stringify(meta), 'application/json').id;
    props.setProperty(t.sheetProp, created);
    props.deleteProperty(t.tabProp);
  }
  const info = driveCall_('get', SHEETS + '/' + encodeURIComponent(created) + '?fields=sheets.properties.sheetId');
  const tab = info.sheets[0].properties.sheetId;
  driveCall_('post', SHEETS + '/' + encodeURIComponent(created) + ':batchUpdate', JSON.stringify({ requests: [
    { updateSheetProperties: { properties: { sheetId: tab, title: 'Submissions', gridProperties: { frozenRowCount: 1 } },
      fields: 'title,gridProperties.frozenRowCount' } },
  ] }), 'application/json');
  appendCells_({ id: created, tab: tab }, [WH_HEADERS], true);
  props.setProperty(t.tabProp, String(tab)); // marks it ready
  return { id: created, tab: tab };
}

/**
 * Add rows to a sheet through the Sheets API. Text goes in as plain text
 * (never a formula, whatever it starts with); {link, label} becomes a plain
 * link, only to Drive files this script made.
 */
function appendCells_(target, rows, bold) {
  const cellOf = function (v) {
    if (v && typeof v === 'object') {
      if (!/^https:\/\/drive\.google\.com\/[\w\/?=&.-]+$/.test(v.link || '')) return {};
      return { userEnteredValue: { stringValue: v.label }, textFormatRuns: [{ startIndex: 0, format: { link: { uri: v.link } } }] };
    }
    if (typeof v === 'number') return { userEnteredValue: { numberValue: v } };
    if (v === '' || v === null || v === undefined) return {};
    const c = { userEnteredValue: { stringValue: String(v) } };
    if (bold) c.userEnteredFormat = { textFormat: { bold: true } };
    return c;
  };
  const body = { requests: [{ appendCells: {
    sheetId: target.tab,
    rows: rows.map(function (r) { return { values: r.map(cellOf) }; }),
    fields: '*',
  } }] };
  driveCall_('post', SHEETS + '/' + encodeURIComponent(target.id) + ':batchUpdate', JSON.stringify(body), 'application/json');
}

/** A name that's safe and tidy as a Drive file or folder name. */
function safeName_(s) {
  return String(s || '').replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100);
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
