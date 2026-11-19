// Getting a student's work to the teacher, from the home screen or a
// worksheet. Every route uses the same files, named so they pair up:
//   Sam-Lee_Week-5-Fractions_2026-11-19_1154.csv
//   Sam-Lee_Week-5-Fractions_2026-11-19_1154.jpg   (_p1, _p2… for more pages)

import { toast } from './ui.js';
import { getSetting } from './settings.js';
import { toCSV, toText } from './session-log.js';
import { shareFiles, openEmailDraft, saveFiles, reportBaseName } from './export.js';
import { blobToCanvas, canvasToBlob } from './image-tools.js';

/**
 * A "work" object describes what is being sent:
 *   { session: SessionLog, answer: string, pageImages?: () => Promise<Blob[]> }
 */

const BOM = String.fromCharCode(0xFEFF);

async function buildFiles(work, when = new Date()) {
  const { session, answer } = work;
  const base = reportBaseName(session.student, session.worksheet, when);
  const files = [new File([BOM + toCSV(session, answer)], base + '.csv', { type: 'text/csv' })];
  const images = work.pageImages ? await work.pageImages() : [];
  images.forEach((blob, i) => {
    const suffix = images.length > 1 ? `_p${i + 1}` : '';
    files.push(new File([blob], `${base}${suffix}.jpg`, { type: 'image/jpeg' }));
  });
  return files;
}

export function needsName(work, focusEl) {
  if (work.session.student) return false;
  toast('Type your name first, so your teacher knows it’s yours.');
  if (focusEl) focusEl.focus();
  return true;
}

export function emailSummary(work) {
  openEmailDraft({
    to: getSetting('teacherEmail') || '',
    subject: `PagePal: ${work.session.student} – ${work.session.worksheet}`,
    body: toText(work.session, work.answer),
  });
}

export async function shareWork(work) {
  const files = await buildFiles(work);
  const result = await shareFiles({
    title: `PagePal: ${work.session.student} – ${work.session.worksheet}`,
    text: toText(work.session, work.answer),
    files,
  });
  if (result === 'unsupported') {
    toast('Sharing files isn’t available here, so an email draft is opening instead. Use Save to Files for the full report.', 5000);
    emailSummary(work);
  }
  return result;
}

export async function saveWork(work) {
  const files = await buildFiles(work);
  await saveFiles(files);
  toast(files.length > 1
    ? `Saved ${files.length} files. On iPad, look in Files › Downloads.`
    : 'Saved. On iPad, look in Files › Downloads.', 4000);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Shrink a page image for uploading (about 200–500 KB). */
async function uploadImage(blob) {
  const canvas = await blobToCanvas(blob, 1600);
  return canvasToBlob(canvas, 'image/jpeg', 0.8);
}

/**
 * Post to the teacher's PagePal Inbox (their Google Sheet's Apps Script).
 * Plain text body = a "simple" request, so the browser sends it without a
 * pre-flight check that Apps Script can't answer.
 */
export async function postToInbox(teacher, payload) {
  let res;
  try {
    res = await fetch(teacher.url, { method: 'POST', body: JSON.stringify({ ...payload, secret: teacher.secret }) });
  } catch {
    return { ok: false, error: 'network' };
  }
  try {
    return await res.json();
  } catch {
    return { ok: false, error: 'bad-reply' };
  }
}

export const INBOX_ERRORS = {
  'wrong-code': 'Your teacher’s class QR code has changed. Scan the new one in Settings.',
  network: 'Couldn’t reach your teacher’s sheet. Check the wifi and try again.',
  'bad-reply': 'Your teacher’s sheet didn’t answer properly. Tell your teacher.',
};

export async function sendToTeacher(work) {
  const teacher = getSetting('teacher');
  if (!teacher) { toast('Connect to your teacher first: Settings › Connect to my teacher.'); return false; }
  const images = work.pageImages ? await work.pageImages() : [];
  const image = images.length ? { type: 'image/jpeg', base64: await blobToBase64(await uploadImage(images[0])) } : undefined;
  const result = await postToInbox(teacher, {
    student: work.session.student,
    worksheet: work.session.worksheet,
    className: teacher.name,
    sentAt: new Date().toISOString(),
    stats: work.session.stats(work.answer),
    answer: work.answer,
    image,
  });
  if (result.ok) {
    toast(`Sent to ${teacher.name} ✓`, 4000);
    return true;
  }
  toast(INBOX_ERRORS[result.error] || 'Couldn’t send: ' + result.error, 6000);
  return false;
}
