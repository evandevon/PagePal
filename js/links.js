// Understanding links: what a scanned QR code, a pasted link or the page's
// own address is asking PagePal to do. Pure functions, unit-tested.
//
// PagePal links (what the teacher page puts in QR codes):
//   …/PagePal/?drive=<Google Drive file id>&title=Week%205   → open a Drive worksheet
//   …/PagePal/?pdf=<web address of a PDF>                    → open a PDF from the web
//   …/PagePal/?teacher=<code>                                → connect this iPad to a teacher's inbox
// Raw Google Drive / Docs links and plain PDF addresses are understood too.

/** Pull a Google Drive file id out of any common Drive / Docs link. */
export function driveFileId(text) {
  let url;
  try { url = new URL(String(text).trim()); } catch { return null; }
  if (!/(^|\.)google\.com$/.test(url.hostname)) return null;
  const m = url.pathname.match(/\/(?:file|document|presentation|spreadsheets|drawings)\/(?:u\/\d+\/)?d\/([\w-]{20,})/);
  if (m) return m[1];
  const id = url.searchParams.get('id');
  if (id && /^[\w-]{20,}$/.test(id)) return id;
  return null;
}

/** Google Docs / Slides links need exporting to PDF rather than downloading. */
export function driveKindFromLink(text) {
  if (/docs\.google\.com\/document\//.test(text)) return 'document';
  if (/docs\.google\.com\/presentation\//.test(text)) return 'presentation';
  if (/docs\.google\.com\/drawings\//.test(text)) return 'drawing';
  return 'file';
}

// ── Teacher inbox codes ───────────────────────────────
// A class QR code is base64url JSON: {n: label, u: web app URL, j: join code,
// x: expiry (ms)}. The iPad swaps the join code for the sending key with the
// teacher's script, so the key itself never appears on the wall. Older codes
// ({n, u, k: key}) made before version 2 of the script are still understood.

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

export function isInboxUrl(u) {
  return /^https:\/\/script\.google(usercontent)?\.com\/.+/.test(String(u || ''));
}

export function encodeTeacher({ name, url, join, expires, secret }) {
  const o = join ? { n: name, u: url, j: join, x: expires } : { n: name, u: url, k: secret };
  return b64urlEncode(JSON.stringify(o));
}

export function decodeTeacher(code) {
  try {
    const o = JSON.parse(b64urlDecode(String(code)));
    if (!o || !isInboxUrl(o.u)) return null;
    const name = String(o.n || 'my teacher').slice(0, 80);
    if (o.j) return { name, url: o.u, join: String(o.j), expires: Number(o.x) || 0 };
    if (o.k) return { name, url: o.u, secret: String(o.k) };
    return null;
  } catch {
    return null;
  }
}

/**
 * Work out what some text (QR contents, pasted text, page address) means.
 * Returns one of:
 *   {type:'drive', id, kind, title?}  {type:'pdf', url, title?}
 *   {type:'teacher', teacher}          null (not something PagePal can open)
 */
export function parseLink(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const p = url.searchParams;
  const title = p.get('title') || undefined;
  if (p.get('teacher')) {
    const teacher = decodeTeacher(p.get('teacher'));
    return teacher ? { type: 'teacher', teacher } : null;
  }
  if (p.get('drive')) {
    const id = p.get('drive');
    if (/^[\w-]{20,}$/.test(id)) return { type: 'drive', id, kind: p.get('kind') || 'file', title };
    return null;
  }
  if (p.get('pdf')) {
    try {
      const target = new URL(p.get('pdf'), url);
      if (target.protocol === 'https:' || target.protocol === 'http:') return { type: 'pdf', url: target.href, title };
    } catch { /* fall through */ }
    return null;
  }
  const id = driveFileId(raw);
  if (id) return { type: 'drive', id, kind: driveKindFromLink(raw), title };
  if (/\.pdf$/i.test(url.pathname)) return { type: 'pdf', url: url.href, title };
  return null;
}

/** Build the app link that goes into a worksheet QR code. */
export function worksheetLink(appBase, { driveId, kind, pdfUrl, title }) {
  const u = new URL(appBase);
  u.search = '';
  u.hash = '';
  if (driveId) {
    u.searchParams.set('drive', driveId);
    if (kind && kind !== 'file') u.searchParams.set('kind', kind);
  } else if (pdfUrl) {
    u.searchParams.set('pdf', pdfUrl);
  }
  if (title) u.searchParams.set('title', title);
  return u.href;
}

export function teacherLink(appBase, teacher) {
  const u = new URL(appBase);
  u.search = '';
  u.hash = '';
  u.searchParams.set('teacher', encodeTeacher(teacher));
  return u.href;
}

/** The first web address inside some text (a pasted message), or ''. */
export function firstLinkIn(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[).,;!?]+$/, '') : '';
}
