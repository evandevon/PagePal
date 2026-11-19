// Tests for link parsing (QR codes, pasted links, page address) and the
// four-corner page straightening maths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, driveFileId, worksheetLink, teacherLink, decodeTeacher, encodeTeacher } from '../js/links.js';
import { rectToQuad, applyH, quadOutputSize, isFullFrame } from '../js/image-tools.js';
import { unsupportedReason, isDocx, cleanName } from '../js/worksheets.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const APP = 'https://evandevon.github.io/PagePal/';

test('Drive ids come out of every common Drive and Docs link', () => {
  for (const link of [
    `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${ID}/view?usp=drive_link`,
    `https://drive.google.com/open?id=${ID}`,
    `https://drive.google.com/uc?id=${ID}&export=download`,
    `https://docs.google.com/document/d/${ID}/edit?usp=sharing`,
    `https://docs.google.com/presentation/d/${ID}/edit#slide=id.p`,
    `https://drive.google.com/file/u/1/d/${ID}/view`,
  ]) assert.equal(driveFileId(link), ID, link);
  assert.equal(driveFileId('https://example.com/file/d/' + ID), null);
});

test('parseLink understands Drive, PDF, PagePal and teacher links', () => {
  assert.deepEqual(parseLink(`https://drive.google.com/file/d/${ID}/view`), { type: 'drive', id: ID, kind: 'file', title: undefined });
  assert.equal(parseLink(`https://docs.google.com/document/d/${ID}/edit`).kind, 'document');
  assert.deepEqual(parseLink('https://example.com/sheets/maths.pdf'), { type: 'pdf', url: 'https://example.com/sheets/maths.pdf', title: undefined });
  assert.deepEqual(parseLink(`${APP}?drive=${ID}&title=Week%205`), { type: 'drive', id: ID, kind: 'file', title: 'Week 5' });
  assert.deepEqual(parseLink(`${APP}?pdf=worksheets/a.pdf`), { type: 'pdf', url: APP + 'worksheets/a.pdf', title: undefined });
  assert.equal(parseLink('hello there'), null);
  assert.equal(parseLink('https://example.com/page'), null);
  assert.equal(parseLink(`${APP}?pdf=javascript:alert(1)`), null);
  assert.equal(parseLink(`${APP}?drive=short`), null);
});

test('worksheet links round-trip through parseLink', () => {
  const url = worksheetLink(APP, { driveId: ID, kind: 'file', title: 'Week 5 Fractions' });
  assert.equal(url, `${APP}?drive=${ID}&title=Week+5+Fractions`);
  assert.deepEqual(parseLink(url), { type: 'drive', id: ID, kind: 'file', title: 'Week 5 Fractions' });
});

test('teacher codes round-trip, including non-English names', () => {
  const t = { name: 'Ms Ngô, 3/4B', url: 'https://script.google.com/macros/s/AKfy/exec', secret: 'abc123' };
  assert.deepEqual(decodeTeacher(encodeTeacher(t)), t);
  assert.deepEqual(parseLink(teacherLink(APP, t)), { type: 'teacher', teacher: t });
  // Only Google Apps Script addresses are accepted as inboxes.
  assert.equal(decodeTeacher(encodeTeacher({ ...t, url: 'https://evil.example/exec' })), null);
  assert.equal(decodeTeacher('not-a-code'), null);
});

test('rectToQuad maps rectangle corners onto the photo corners', () => {
  const quad = [[100, 50], [900, 80], [950, 1200], [60, 1150]];
  const H = rectToQuad(800, 1100, quad);
  [[0, 0], [800, 0], [800, 1100], [0, 1100]].forEach(([x, y], i) => {
    const [u, v] = applyH(H, x, y);
    assert.ok(Math.abs(u - quad[i][0]) < 1e-6 && Math.abs(v - quad[i][1]) < 1e-6);
  });
});

test('output size follows the page edges and is capped', () => {
  assert.deepEqual(quadOutputSize([[0, 0], [1000, 0], [1000, 2000], [0, 2000]], 2400), { width: 1000, height: 2000 });
  assert.deepEqual(quadOutputSize([[0, 0], [3000, 0], [3000, 4800], [0, 4800]], 2400), { width: 1500, height: 2400 });
  assert.ok(isFullFrame([[0, 0], [10, 0], [10, 20], [0, 20]], 10, 20));
  assert.ok(!isFullFrame([[5, 0], [10, 0], [10, 20], [0, 20]], 10, 20));
});

test('file types: Word is accepted, other Office files get advice', () => {
  assert.ok(isDocx('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x'));
  assert.ok(isDocx('', 'Week 5.docx'));
  assert.match(unsupportedReason('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'a.pptx'), /Google Slides/);
  assert.match(unsupportedReason('', 'marks.xlsx'), /Google Sheets/);
  assert.match(unsupportedReason('application/msword', 'old.doc'), /PDF or a \.docx/);
  assert.equal(unsupportedReason('application/pdf', 'a.pdf'), null);
  assert.equal(cleanName('Week_5_Fractions.pdf'), 'Week 5 Fractions');
});

test('class QR codes carry a join code and expiry, never the sending key', () => {
  const t = { name: 'Mr Evans, 3/4B', url: 'https://script.google.com/macros/s/AKfy/exec', join: 'j0in1234567890ab', expires: 1765000000000 };
  const decoded = parseLink(teacherLink(APP, t)).teacher;
  assert.deepEqual(decoded, t);
  assert.equal(decoded.secret, undefined);
  // Older codes that held the key directly still work.
  const old = { name: 'Ms Lee', url: 'https://script.google.com/macros/s/X/exec', secret: 'k3y' };
  assert.deepEqual(decodeTeacher(encodeTeacher(old)), old);
});
