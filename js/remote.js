// Downloading worksheets from Google Drive or the web.
//
// Google Drive's ordinary share and download links can't be fetched by
// another website, so Drive files are downloaded through the Drive API with
// a browser API key (see config.js). That works for files shared as
// "Anyone with the link can view". Google Docs, Slides and Drawings are
// exported as PDFs.

import { GOOGLE_API_KEY } from './config.js';

const API = 'https://www.googleapis.com/drive/v3/files/';

export class RemoteError extends Error {}

function driveProblem(status) {
  if (status === 403 || status === 404) {
    return 'PagePal can’t open that Drive file. Ask your teacher to share it as “Anyone with the link can view”.';
  }
  if (status === 400) return 'That Drive link doesn’t look right. Ask your teacher for a new QR code.';
  return 'Google Drive didn’t answer (error ' + status + '). Check the wifi and try again.';
}

export const driveReady = () => !!GOOGLE_API_KEY;

function keyParam() {
  if (!GOOGLE_API_KEY) {
    throw new RemoteError('Google Drive worksheets aren’t switched on yet: a Google API key needs adding to PagePal (js/config.js).');
  }
  return 'key=' + encodeURIComponent(GOOGLE_API_KEY);
}

/** Name and type of a Drive file. Throws RemoteError if it can't be reached. */
export async function driveInfo(id) {
  const key = keyParam();
  try {
    const res = await fetch(`${API}${encodeURIComponent(id)}?fields=name,mimeType,size&supportsAllDrives=true&${key}`);
    if (!res.ok) throw new RemoteError(driveProblem(res.status));
    return await res.json();
  } catch (err) {
    if (err instanceof RemoteError) throw err;
    throw new RemoteError('Couldn’t reach Google Drive. Check the wifi and try again.');
  }
}

/** @returns {Promise<{blob: Blob, name: string, type: string}>} */
export async function fetchDrive({ id }) {
  const key = keyParam();
  const meta = await driveInfo(id);

  const googleType = meta.mimeType && meta.mimeType.startsWith('application/vnd.google-apps.');
  const url = googleType
    ? `${API}${encodeURIComponent(id)}/export?mimeType=application%2Fpdf&${key}`
    : `${API}${encodeURIComponent(id)}?alt=media&supportsAllDrives=true&${key}`;
  const res = await fetch(url).catch(() => null);
  if (!res) throw new RemoteError('Couldn’t download the worksheet. Check the wifi and try again.');
  if (!res.ok) throw new RemoteError(driveProblem(res.status));
  const blob = await res.blob();
  const type = googleType ? 'application/pdf' : (meta.mimeType || blob.type);
  return { blob, name: (meta.name || 'Worksheet').replace(/\.(pdf|png|jpe?g)$/i, ''), type };
}

/** Download a PDF (or image) from any web address that allows it. */
export async function fetchUrl(url) {
  let res;
  try {
    res = await fetch(url, { mode: 'cors' });
  } catch {
    throw new RemoteError('That website won’t let PagePal open the file. Put the worksheet in Google Drive instead.');
  }
  if (!res.ok) throw new RemoteError('Couldn’t download the worksheet (error ' + res.status + ').');
  const blob = await res.blob();
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Worksheet').replace(/\.(pdf|png|jpe?g)$/i, '');
  return { blob, name, type: blob.type };
}

/** Is this blob a PDF? (Checks the first bytes, since servers often send the wrong type.) */
export async function looksLikePdf(blob) {
  const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  return String.fromCharCode(...head) === '%PDF-';
}
