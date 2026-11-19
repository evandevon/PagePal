/**
 * PagePal Inbox
 * Receives work that students send from PagePal and files it in this
 * Google Sheet, with images and PDFs saved to your Google Drive.
 *
 * Set-up (see the teacher guide):
 *   1. Paste this whole file into Extensions › Apps Script › Code.gs.
 *   2. Run setup() once and allow access.
 *   3. Deploy › New deployment › Web app — Execute as: Me, Who has access: Anyone.
 *
 * resetCode() makes a new secret code, cutting off any iPad connected with
 * the old one (use it if a class QR code is shared too widely).
 */

const SHEET_NAME = 'Submissions';
const FOLDER_NAME = 'PagePal submissions';
const HEADERS = [
  'Received', 'Student', 'Worksheet', 'Class',
  'Time working (min)', 'Total time (min)', 'Words written',
  'Typed', 'Spoken', 'Suggestions', 'Spell corrections', 'Assistance %',
  'Times listened', 'Words listened to', 'Answer', 'Page', 'PDF',
];
const ALLOWED_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' };
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET')) props.setProperty('SECRET', newSecret_());
  getSheet_();
  getFolder_();
  Logger.log('Set-up done. Your PagePal secret code is: ' + props.getProperty('SECRET'));
}

function resetCode() {
  const code = newSecret_();
  PropertiesService.getScriptProperties().setProperty('SECRET', code);
  Logger.log('New secret code: ' + code + '. Make and print a new class QR code.');
}

/** Visiting the web app address in a browser: a quick "is it working?" check. */
function doGet() {
  return json_({ ok: true, app: 'PagePal Inbox' });
}

/** PagePal sends work here. */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || data.secret !== secret) return json_({ ok: false, error: 'wrong-code' });

    const st = data.stats || {};
    const student = text_(data.student, 80) || 'Unknown';
    const worksheet = text_(data.worksheet, 100) || 'Worksheet';
    const label = (data.test ? 'TEST ' : '') + student;
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');

    let pageUrl = '', pdfUrl = '';
    if (data.image || data.pdf) {
      const folder = subFolder_(getFolder_(), worksheet.replace(/[\/\\]/g, '-'));
      pageUrl = saveFile_(folder, data.image, student + ' – ' + stamp);
      pdfUrl = saveFile_(folder, data.pdf, student + ' – ' + stamp);
    }

    getSheet_().appendRow([
      new Date(), cell_(label), cell_(worksheet), cell_(text_(data.className, 80)),
      mins_(st.workingSecs), mins_(st.totalSecs), num_(st.wordsWritten),
      num_(st.typed), num_(st.dictated), num_(st.suggestion), num_(st.corrected), num_(st.assistanceRate),
      num_(st.listens), cell_(text_((st.wordsListened || []).join(', '), 2000)),
      cell_(text_(data.answer, 40000)),
      link_(pageUrl, 'View page'), link_(pdfUrl, 'View PDF'),
    ]);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// ── Helpers ─────────────────────────────────────────────

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

function getFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* deleted: make a new one */ }
  }
  const folder = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function subFolder_(parent, name) {
  const found = parent.getFoldersByName(name);
  return found.hasNext() ? found.next() : parent.createFolder(name);
}

/** file = {type: 'image/jpeg', base64: '...'} → Drive link, or '' */
function saveFile_(folder, file, baseName) {
  if (!file || !file.base64) return '';
  const ext = ALLOWED_TYPES[file.type];
  if (!ext) return '';
  const bytes = Utilities.base64Decode(file.base64);
  if (bytes.length > MAX_FILE_BYTES) return '';
  const blob = Utilities.newBlob(bytes, file.type, baseName + ext);
  return folder.createFile(blob).getUrl();
}

function newSecret_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function text_(value, max) {
  return value === undefined || value === null ? '' : String(value).slice(0, max).trim();
}

/** Stop text that starts with = + - @ being treated as a spreadsheet formula. */
function cell_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function num_(n) {
  return typeof n === 'number' && isFinite(n) ? n : '';
}

function mins_(secs) {
  return typeof secs === 'number' && isFinite(secs) ? Math.round(secs / 6) / 10 : '';
}

function link_(url, label) {
  return url ? '=HYPERLINK("' + url.replace(/"/g, '') + '","' + label + '")' : '';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
