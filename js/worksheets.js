// Worksheets: turning a PDF, Word file or photos into a saved worksheet.
//
// A worksheet record (IndexedDB "worksheets" store):
//   { id, title, kind: 'pdf' | 'images', file?: Blob (the PDF),
//     pages?: [{ blob, width, height }] (page images), pageCount,
//     thumb: Blob, from: 'file' | 'camera' | 'paste' | 'drive' | 'web',
//     sourceKey?: 'drive:<id>' | '<url>', createdAt, updatedAt }
// Later stages add the text layer, the student's answers and the session log.

import * as store from './store.js';
import { openPdf, pdfThumbnail, pdfTitle } from './pdf-doc.js';
import { canvasToBlob, thumbnail, blobToCanvas } from './image-tools.js';
import { docxToCanvases, DOCX_TYPE } from './docx-doc.js';
import { looksLikePdf } from './remote.js';
import { renderTemplate, getTemplate, TEMPLATES } from './templates.js';

export class UnsupportedFileError extends Error {}

// Common files we can't open in the browser, and what the teacher can do instead.
const NOT_SUPPORTED = [
  [/presentationml|ms-powerpoint|opendocument\.presentation|\.pptx?$|\.odp$|\.key$/i, 'PowerPoint',
    'In Google Drive, open it and choose File › Save as Google Slides (or File › Download › PDF), then use that.'],
  [/spreadsheetml|ms-excel|opendocument\.spreadsheet|\.xlsx?$|\.ods$|\.numbers$|text\/csv/i, 'spreadsheet',
    'In Google Drive, open it and choose File › Save as Google Sheets (or File › Download › PDF), then use that.'],
  [/msword$|opendocument\.text|rtf|\.doc$|\.odt$|\.rtf$|\.pages$/i, 'older Word or text document',
    'Save it as a PDF or a .docx (in Google Drive: File › Save as Google Docs), then use that.'],
];

export function unsupportedReason(type = '', name = '') {
  const s = type + ' ' + name;
  for (const [re, what, fix] of NOT_SUPPORTED) if (re.test(s)) return `PagePal can’t open a ${what} file directly. ${fix}`;
  return null;
}

export function isDocx(type = '', name = '') {
  return type === DOCX_TYPE || /\.docx$/i.test(name);
}

const now = () => Date.now();

export function defaultPhotoTitle(prefix = 'Photo') {
  const d = new Date();
  return `${prefix} ${d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * Save a worksheet. Its thumbnail is kept as plain bytes inside the record
 * (thumbBytes), not as a separate picture: Safari sometimes loses track of
 * saved pictures until the page is refreshed, and the thumbnails on the
 * home screen would vanish. (record.thumb is the in-memory picture.)
 */
async function save(record) {
  if (record.thumb && !record.thumbBytes) {
    try {
      record.thumbBytes = await record.thumb.arrayBuffer();
      record.thumbType = record.thumb.type || 'image/jpeg';
    } catch { /* unreadable right now: remade from page 1 next time it's opened */ }
  }
  const { thumb, ...stored } = record;
  await store.put('worksheets', stored);
  return record;
}

/** Store converted thumbnail bytes, changing nothing else in the saved worksheet. */
async function keepThumb(id, bytes, type) {
  const fresh = await store.get('worksheets', id);
  if (!fresh || fresh.thumbBytes) return;
  fresh.thumbBytes = bytes;
  fresh.thumbType = type;
  delete fresh.thumb;
  await store.put('worksheets', fresh);
}

/** The thumbnail as a picture, from the bytes kept in the record. */
function thumbOf(record) {
  return record.thumbBytes ? new Blob([record.thumbBytes], { type: record.thumbType || 'image/jpeg' }) : null;
}

/** Make the thumbnail again from page 1 (for worksheets whose old thumbnail Safari lost). */
async function remakeThumb(record) {
  try {
    if (record.kind === 'pdf') {
      const doc = await openPdf(record.file);
      try { record.thumb = await pdfThumbnail(doc); } finally { doc.destroy(); }
    } else if (record.pages && record.pages[0]) {
      record.thumb = await thumbnail(await blobToCanvas(record.pages[0].blob, 1200));
    }
    record.thumbBytes = null;
    await save(record);
  } catch (err) {
    console.warn('Could not remake the thumbnail', err);
  }
}

export async function fromPdf(blob, { title, from = 'file', sourceKey } = {}) {
  const doc = await openPdf(blob);
  try {
    const thumb = await pdfThumbnail(doc);
    const t = title || (await pdfTitle(doc)) || 'Worksheet';
    return save({
      id: store.newId(), title: t, kind: 'pdf', file: blob, pageCount: doc.numPages,
      thumb, from, sourceKey, createdAt: now(), updatedAt: now(),
    });
  } finally {
    doc.destroy();
  }
}

export async function fromCanvases(canvases, { title, from = 'camera', sourceKey, template, imageType = 'image/jpeg' } = {}) {
  const pages = [];
  for (const c of canvases) pages.push({ blob: await canvasToBlob(c, imageType, 0.88), width: c.width, height: c.height });
  return save({
    id: store.newId(), title: title || defaultPhotoTitle(), kind: 'images', pages, pageCount: pages.length,
    thumb: await thumbnail(canvases[0]), from, sourceKey, template, createdAt: now(), updatedAt: now(),
  });
}

/** A new page for students' own work: lined, grid, dots… (PNG keeps lines crisp and small). */
export function fromTemplate(templateId, title) {
  const t = getTemplate(templateId);
  return fromCanvases([renderTemplate(t.id)], { title: title || t.name, from: 'new', template: t.id, imageType: 'image/png' });
}

/** Add another page of the same kind to the end of a template worksheet. */
export async function addTemplatePage(record) {
  const c = renderTemplate(record.template);
  record.pages.push({ blob: await canvasToBlob(c, 'image/png'), width: c.width, height: c.height });
  record.pageCount = record.pages.length;
  return update(record);
}

/**
 * Make a worksheet from any downloaded or chosen file.
 * Images are used as they are (no crop step); see app.js for the photo flow.
 */
export async function fromFile(blob, { name = '', type = blob.type, title, from = 'file', sourceKey, onProgress } = {}) {
  if (type === 'application/pdf' || /\.pdf$/i.test(name) || await looksLikePdf(blob)) {
    return fromPdf(blob, { title: title || cleanName(name), from, sourceKey });
  }
  if (isDocx(type, name)) {
    const canvases = await docxToCanvases(blob, { onProgress });
    return fromCanvases(canvases, { title: title || cleanName(name) || 'Worksheet', from, sourceKey });
  }
  if (/^image\//.test(type) || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(name)) {
    let canvas;
    try {
      canvas = await blobToCanvas(blob, 2400);
    } catch {
      throw new UnsupportedFileError('This picture type can’t be shown on this device. Save it as a JPG, PNG or PDF.');
    }
    return fromCanvases([canvas], { title: title || cleanName(name), from, sourceKey });
  }
  const reason = unsupportedReason(type, name);
  throw new UnsupportedFileError(reason || 'PagePal can open PDFs, Word (.docx) files and pictures. Save the worksheet as a PDF and try again.');
}

export function cleanName(name) {
  return String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').trim();
}

/**
 * A saved copy of the same worksheet (same Drive file or link) for this
 * student. On a shared iPad, another student's copy is never reused: they
 * get a fresh one.
 */
export async function findBySource(sourceKey, student = '') {
  if (!sourceKey) return null;
  const all = await store.recentWorksheets(1000);
  const who = sameName(student);
  return all.find(w => w.sourceKey === sourceKey && (!w.student || !who || sameName(w.student) === who)) || null;
}

const sameName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** True for names PagePal made up ("Photo 21 Nov 2:30 pm", "Lined"), which a teacher won't recognise. */
export function isPlaceholderTitle(title) {
  const t = String(title || '').trim();
  if (!t) return true;
  if (/^(Photo|Picture|Pasted picture) \d{1,2} \w{3,4}\b/.test(t)) return true;
  return TEMPLATES.some(x => x.name === t);
}

export async function rename(record, title) {
  record.title = title;
  record.updatedAt = now();
  return save(record);
}

/** Save the worksheet as it is now (answers, session data…). */
export async function update(record) {
  record.updatedAt = now();
  return save(record);
}

export async function touch(record) {
  record.updatedAt = now();
  return save(record);
}

export const get = id => store.get('worksheets', id);

/**
 * A worksheet ready to open: its PDF or page pictures copied into the
 * page's own memory, so they keep working even if Safari restarts its
 * storage process while the worksheet is open (see store.reconnect). If the
 * saved pictures can't be read, reconnect to storage and try once more.
 */
export async function load(id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const record = await get(id);
    if (!record) return null;
    try {
      if (record.file) record.file = await inMemory(record.file);
      if (record.pages) for (const p of record.pages) if (p.blob) p.blob = await inMemory(p.blob);
      record.thumb = thumbOf(record);
      if (!record.thumb) remakeThumb(record); // in the background
      return record;
    } catch (err) {
      if (attempt) throw new PicturesUnreadableError(err);
      store.reconnect();
    }
  }
  return null;
}

export class PicturesUnreadableError extends Error {
  constructor(cause) {
    super('The worksheet’s pictures couldn’t be read. Reload PagePal (pull down, or the reload button) and open it again.');
    this.cause = cause;
  }
}

async function inMemory(blob) {
  return new Blob([await blob.arrayBuffer()], { type: blob.type });
}

/**
 * The worksheet list with thumbnails. Thumbnails come from the bytes kept in
 * each record, so they can't vanish. Older worksheets kept them as separate
 * pictures: those are converted now if Safari can read them (otherwise
 * they're remade when the worksheet is next opened).
 */
export async function recentWithThumbs() {
  const items = await recent();
  for (const w of items) {
    const legacy = w.thumb instanceof Blob ? w.thumb : null;
    w.thumb = thumbOf(w);
    if (!w.thumb && legacy) {
      try {
        w.thumbBytes = await legacy.arrayBuffer();
        w.thumbType = legacy.type || 'image/jpeg';
        w.thumb = thumbOf(w);
        keepThumb(w.id, w.thumbBytes, w.thumbType).catch(() => {}); // keep the converted thumbnail
      } catch { /* Safari has lost it for now */ }
    }
  }
  return items;
}
export const remove = id => store.remove('worksheets', id);
export const recent = () => store.recentWorksheets(20);
