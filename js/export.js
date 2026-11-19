// Getting work and data off the device and to the teacher.
//
// 1. Share sheet (navigator.share with a file): on iPad this offers Mail with
//    the report attached, plus AirDrop, Google Classroom, Seesaw, Drive…
// 2. Email summary (mailto:): a plain-text email draft addressed to the
//    teacher. mailto links cannot carry attachments, so this is the fallback.
// 3. Save to Files: downloads the CSV (iPad: Files › Downloads).
// (Planned, Stage 6: "Send to teacher" straight into the teacher's own
//  Google Sheet, set up by scanning a teacher QR code.)

import { downloadBlob } from './ui.js';

export function canShareFiles() {
  try {
    const probe = new File(['x'], 'probe.csv', { type: 'text/csv' });
    return !!(navigator.canShare && navigator.canShare({ files: [probe] }));
  } catch {
    return false;
  }
}

const slug = s => String(s || '').trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

/**
 * Shared base name for everything saved from one sitting, so the CSV and the
 * page images sort together: Sam-Lee_Week-5-Fractions_2026-11-19_1154
 */
export function reportBaseName(student, worksheet, date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}`;
  return [slug(student) || 'student', slug(worksheet) || 'worksheet', day, time].join('_');
}

/** Safe file name from a student and worksheet name. */
export function reportFileName(student, worksheet, ext, date = new Date()) {
  return reportBaseName(student, worksheet, date) + '.' + ext;
}

/**
 * Open the share sheet with the files attached. Must be called from a tap.
 * Returns 'shared' | 'cancelled' | 'unsupported'.
 */
export async function shareFiles({ title, text, files }) {
  if (!canShareFiles() || !navigator.canShare({ files })) return 'unsupported';
  try {
    await navigator.share({ title, text, files });
    return 'shared';
  } catch (err) {
    if (err && err.name === 'AbortError') return 'cancelled';
    // Some browsers refuse text + files together; retry with files only.
    try { await navigator.share({ files }); return 'shared'; } catch { return 'cancelled'; }
  }
}

// Mail apps truncate or reject very long mailto links; keep well under 2000 chars.
const MAILTO_BODY_LIMIT = 1800;

export function mailtoLink({ to = '', subject, body }) {
  let b = body;
  if (b.length > MAILTO_BODY_LIMIT) b = b.slice(0, MAILTO_BODY_LIMIT) + '\n…(shortened: use Save to Files for the full report)';
  return 'mailto:' + encodeURIComponent(to).replace(/%40/g, '@') +
    '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(b);
}

export function openEmailDraft(opts) {
  window.location.href = mailtoLink(opts);
}

export function saveFile(content, filename, type = 'text/csv') {
  // The BOM makes Excel open UTF-8 CSVs (names with accents) correctly.
  const parts = type === 'text/csv' ? [String.fromCharCode(0xFEFF), content] : [content];
  downloadBlob(new Blob(parts, { type }), filename);
}

/** Save several files one after another (browsers ignore downloads fired all at once). */
export async function saveFiles(files) {
  for (let i = 0; i < files.length; i++) {
    if (i) await new Promise(r => setTimeout(r, 600));
    downloadBlob(files[i], files[i].name);
  }
}
