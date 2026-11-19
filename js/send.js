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

/**
 * One picture for the teacher's sheet: every page stacked top to bottom,
 * shrunk to stay well under the inbox's 5 MB limit (usually 0.3–1.5 MB).
 */
export async function uploadImage(blobs) {
  const pages = [];
  for (const b of blobs) pages.push(await blobToCanvas(b, 1600));
  // iPad Safari can't make canvases much over 16 million pixels.
  const MAX_PIXELS = 14e6;
  let width = Math.min(1400, Math.max(...pages.map(p => p.width)));
  const heightAt = w => pages.reduce((h, p) => h + p.height * (w / p.width), 0) + 16 * (pages.length - 1);
  while (width * heightAt(width) > MAX_PIXELS && width > 500) width = Math.round(width * 0.85);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = Math.round(heightAt(width));
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#D0D5DA'; // grey gaps between pages
  ctx.fillRect(0, 0, out.width, out.height);
  let y = 0;
  for (const p of pages) {
    const h = Math.round(p.height * (width / p.width));
    ctx.drawImage(p, 0, y, width, h);
    y += h + 16;
  }
  for (const q of [0.8, 0.65, 0.5]) {
    const blob = await canvasToBlob(out, 'image/jpeg', q);
    if (blob.size < 4.5 * 1024 * 1024) return blob;
  }
  return canvasToBlob(out, 'image/jpeg', 0.4);
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
  return postJson(teacher.url, { action: 'submit', ...payload, secret: teacher.secret });
}

/** Swap a class QR code's join code for the sending key. */
export function joinInbox(url, join) {
  return postJson(url, { action: 'join', join });
}

/** Teacher page: ask the script for a new join code (proves the secret code is right). */
export function newJoinCode(url, secret, days, label) {
  return postJson(url, { action: 'newJoin', secret, days, label });
}

/** Teacher page: which version of the PagePal Inbox script is deployed. */
export async function inboxVersion(url) {
  try {
    const res = await fetch(url);
    const o = await res.json();
    return o && o.app === 'PagePal Inbox' ? (o.version || 1) : 0;
  } catch {
    return 0;
  }
}

export const INBOX_ERRORS = {
  'wrong-code': 'Your teacher’s class QR code has changed. Scan the new one (Settings › Scan class QR code).',
  'expired-join': 'That class QR code has expired. Ask your teacher for a new one.',
  busy: 'Your teacher’s sheet is very busy right now. Wait a minute and try again.',
  'too-big': 'This work is too big to send. Try sending fewer pages.',
  network: 'Couldn’t reach your teacher’s sheet. Check the wifi and try again.',
  'bad-reply': 'Your teacher’s sheet didn’t answer properly. Tell your teacher.',
  'bad-request': 'Your teacher’s sheet didn’t understand the message. Tell your teacher.',
  server: 'Your teacher’s sheet had a problem. Tell your teacher.',
};

export async function sendToTeacher(work) {
  const teacher = getSetting('teacher');
  if (!teacher) { toast('Connect to your teacher first: Settings › Connect to my teacher.'); return false; }
  const images = work.pageImages ? await work.pageImages() : [];
  const image = images.length ? { type: 'image/jpeg', base64: await blobToBase64(await uploadImage(images)) } : undefined;
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
    toast(result.warnings && result.warnings.length
      ? `Sent to ${teacher.name}, but the picture of your work wasn’t accepted.`
      : `Sent to ${teacher.name} ✓`, 4000);
    return true;
  }
  toast(INBOX_ERRORS[result.error] || 'Couldn’t send: ' + result.error, 6000);
  return false;
}

// ── What each option does (shown under the buttons, and in full with ⓘ) ──

export const SEND_HELP = {
  teacher: {
    hint: 'Straight into your teacher’s Google Sheet.',
    details: [
      'Goes to the Google Sheet your teacher set up (from the class QR code you scanned). Nothing else is opened.',
      'Sends: your name, the worksheet name, time spent working, how many words you typed, said or picked from suggestions, the words you tapped to hear, your answers as text, and one picture with all your pages.',
      'Your teacher sees a new row in their sheet, with a link to the picture.',
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
