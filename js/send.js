// Getting a student's work to the teacher, from the home screen or a
// worksheet. Every route uses the same files, named so they pair up:
//   Sam-Lee_Week-5-Fractions_2026-11-19_1154.csv
//   Sam-Lee_Week-5-Fractions_2026-11-19_1154.jpg   (_p1, _p2… for more pages)

import { toast } from './ui.js';
import { getSetting } from './settings.js';
import { toCSV, toText } from './session-log.js';
import { shareFiles, openEmailDraft, saveFiles, reportBaseName } from './export.js';
import { blobToCanvas, canvasToBlob } from './image-tools.js';
import { jpegsToPdf } from './pdf-writer.js';

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
  return 'saved';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * One PDF for the teacher's sheet: each worksheet page (with the answers
 * drawn on) as its own PDF page. Shrinks the pictures if a long worksheet
 * would go over the inbox's 5 MB limit.
 */
export async function workPdf(blobs, title) {
  const LIMIT = 4.5 * 1024 * 1024;
  const sources = [];
  for (const b of blobs) sources.push(await blobToCanvas(b, 1600));
  for (const [maxWidth, quality] of [[1600, 0.8], [1400, 0.7], [1200, 0.6], [1000, 0.5], [800, 0.45]]) {
    const pages = [];
    for (const src of sources) {
      const scale = Math.min(1, maxWidth / src.width);
      const c = document.createElement('canvas');
      c.width = Math.round(src.width * scale);
      c.height = Math.round(src.height * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(src, 0, 0, c.width, c.height);
      const jpeg = await canvasToBlob(c, 'image/jpeg', quality);
      pages.push({ bytes: new Uint8Array(await jpeg.arrayBuffer()), width: c.width, height: c.height });
    }
    const pdf = jpegsToPdf(pages, { title });
    if (pdf.length < LIMIT || maxWidth === 800) return new Blob([pdf], { type: 'application/pdf' });
  }
}

/**
 * Post to the teacher's PagePal Inbox (their Google Sheet's Apps Script).
 * Plain text body = a "simple" request, so the browser sends it without a
 * pre-flight check that Apps Script can't answer.
 */
async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: 'network' };
  }
  try {
    return await res.json();
  } catch {
    return { ok: false, error: 'bad-reply' };
  }
}

export function postToInbox(teacher, payload) {
  return postJson(teacher.url, { action: 'submit', tool: 'pagepal', ...payload, secret: teacher.secret });
}

/** Swap a class QR code's join code for the sending key. */
export function joinInbox(url, join) {
  return postJson(url, { action: 'join', join });
}

export const INBOX_ERRORS = {
  'wrong-code': 'Your teacher’s class QR code has changed. Scan the new one (Settings › Scan class QR code).',
  'expired-join': 'That class QR code has expired. Ask your teacher for a new one.',
  busy: 'Your teacher’s inbox is very busy right now. Wait a minute and try again.',
  'too-big': 'This work is too big to send. Try sending fewer pages.',
  network: 'Couldn’t reach your teacher’s inbox. Check the wifi and try again.',
  'bad-reply': 'Your teacher’s inbox didn’t answer properly. Tell your teacher.',
  'bad-request': 'Your teacher’s inbox didn’t understand the message. Tell your teacher.',
  server: 'Your teacher’s inbox had a problem. Tell your teacher.',
  paused: 'Your teacher’s inbox is turned off right now. Tell your teacher.',
};

export async function sendToTeacher(work) {
  const teacher = getSetting('teacher');
  if (!teacher) { toast('Connect to your teacher first: Settings › Connect to my teacher.'); return false; }
  const images = work.pageImages ? await work.pageImages() : [];
  const title = `${work.session.student} – ${work.session.worksheet}`;
  const pdf = images.length ? { type: 'application/pdf', base64: await blobToBase64(await workPdf(images, title)) } : undefined;
  const result = await postToInbox(teacher, {
    student: work.session.student,
    worksheet: work.session.worksheet,
    className: teacher.name,
    sentAt: new Date().toISOString(),
    stats: work.session.stats(work.answer),
    answer: work.answer,
    pdf,
  });
  if (result.ok) {
    toast(result.warnings && result.warnings.length
      ? `Sent to ${teacher.name}, but the PDF of your work wasn’t accepted.`
      : `Sent to ${teacher.name} ✓`, 4000);
    return true;
  }
  toast(INBOX_ERRORS[result.error] || 'Couldn’t send: ' + result.error, 6000);
  return false;
}

// ── What each option does (shown under the buttons, and in full with ⓘ) ──

export const SEND_HELP = {
  teacher: {
    hint: 'Straight to your teacher’s inbox.',
    details: [
      'Goes to the inbox your teacher set up in their Google Drive (from the class QR code you scanned). Nothing else is opened.',
      'Sends: your name, the worksheet name, time spent working, how many words you typed, said or picked from suggestions, the words you listened to, your answers as text, and a PDF of the worksheet with your answers on every page.',
      'Your teacher sees a new row in their sheet, with a link to the PDF.',
    ],
  },
  share: {
    hint: 'Attach your report and page pictures to Mail, Classroom, Seesaw, AirDrop…',
    details: [
      'Opens this device’s share menu. Nothing is sent until you choose where: Mail, Google Classroom, Seesaw, AirDrop, Drive and so on.',
      'Attaches: a report file (CSV, opens in Excel or Google Sheets) with your time, word counts, words you listened to, your answers and every word you wrote; and a picture of each page with your answers on it.',
      'If this device can’t share files, an email draft with a short text summary opens instead.',
    ],
  },
  email: {
    hint: 'A short text summary in a new email. No files attached.',
    details: [
      'Opens a new email in your mail app, addressed to the teacher’s email from Settings (if one is set). You check it and press Send yourself.',
      'The email contains text only: your name, the worksheet, time spent, word counts, words you listened to and your answers.',
      'No report file or page pictures: email links can’t carry attachments. Use “Email or share” for those.',
    ],
  },
  save: {
    hint: 'Keep a copy on this device. Nothing is sent.',
    details: [
      'Downloads the report file (CSV) and a picture of each page to this device. On iPad they go to Files › Downloads.',
      'All the files share one name (your name, the worksheet, the date and time) so they stay together, e.g. Sam_Week-5_2026-11-19_1154.csv and …_p1.jpg.',
      'Nothing is sent to anyone. You can attach the files to an email or upload them later.',
    ],
  },
};
