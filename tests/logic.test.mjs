// Unit tests for PagePal's pure logic. Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoChunks, wordIndexAt, rankVoice } from '../js/tts.js';
import { SessionLog, toCSV, toText, IDLE_MS } from '../js/session-log.js';
import { mailtoLink, reportFileName, reportBaseName } from '../js/export.js';

test('splitIntoChunks keeps offsets that point back into the original text', () => {
  const text = 'Read the question. Then write your answer! Is it right?';
  const chunks = splitIntoChunks(text);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.equal(text.slice(c.offset, c.offset + c.text.length), c.text);
});

test('splitIntoChunks breaks very long sentences at spaces', () => {
  const text = Array.from({ length: 120 }, (_, i) => 'word' + i).join(' ');
  const chunks = splitIntoChunks(text, 100);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every(c => c.text.length <= 100));
  assert.equal(chunks.map(c => c.text).join(''), text);
});

test('wordIndexAt maps a character position to the word containing it', () => {
  const starts = [0, 4, 9, 15]; // "The cat sat down"
  assert.equal(wordIndexAt(starts, 0), 0);
  assert.equal(wordIndexAt(starts, 5), 1);
  assert.equal(wordIndexAt(starts, 9), 2);
  assert.equal(wordIndexAt(starts, 40), 3);
});

test('rankVoice prefers Australian voices and rejects novelty or non-English ones', () => {
  const karen = { name: 'Karen', lang: 'en-AU', localService: true };
  const zarvox = { name: 'Zarvox', lang: 'en-US', localService: true };
  const french = { name: 'Thomas', lang: 'fr-FR', localService: true };
  const generic = { name: 'English United States', lang: 'en-US', localService: false };
  assert.ok(rankVoice(karen) > rankVoice(generic));
  assert.equal(rankVoice(zarvox), -1);
  assert.equal(rankVoice(french), -1);
});

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

test('SessionLog counts words by how they were entered', () => {
  const clock = fakeClock();
  const log = new SessionLog({ student: 'Sam', now: clock.now });
  log.logWord('The', 'typed');
  log.logPhrase('cat sat on the mat.', 'dictated');
  log.logWord('happily', 'suggestion', 'hapily');
  log.logListen('cat', 'word');
  const st = log.stats('The cat sat on the mat happily');
  assert.equal(st.typed, 1);
  assert.equal(st.dictated, 5);
  assert.equal(st.suggestion, 1);
  assert.equal(st.assistanceRate, 86); // 6 of 7 assisted
  assert.equal(st.wordsWritten, 7);
  assert.equal(st.ttr, 0.86);          // 6 unique of 7
  assert.deepEqual(st.wordsListened, ['cat']);
  assert.equal(log.words[1].word, 'cat');
  assert.equal(log.words[5].word, 'mat');  // punctuation stripped
});

test('SessionLog pauses "time working" after the idle gap', () => {
  const clock = fakeClock();
  const log = new SessionLog({ now: clock.now });
  log.activity();
  clock.advance(3000); log.activity();     // 3 s active
  clock.advance(60_000); log.activity();   // long gap: counts IDLE_MS, then restarts
  clock.advance(2000); log.activity();
  const expected = Math.round((3000 + IDLE_MS + 2000) / 1000);
  assert.equal(log.workingSecs(), expected);
  assert.equal(log.totalSecs(), 65);
});

test('CSV quotes commas and quotes, and lists every word', () => {
  const log = new SessionLog({ student: 'Ava "AJ" Jones', worksheet: 'Week 5, Fractions' });
  log.logWord('half', 'typed');
  const csv = toCSV(log, 'one half, please');
  assert.match(csv, /"Ava ""AJ"" Jones"/);
  assert.match(csv, /"Week 5, Fractions"/);
  assert.match(csv, /\n1,half,Typed,,/);
  assert.match(toText(log, 'one half'), /Words written: 2/);
});

test('mailto links are encoded and shortened', () => {
  const link = mailtoLink({ to: 'teacher@school.edu.au', subject: 'Hi & bye', body: 'x'.repeat(5000) });
  assert.ok(link.startsWith('mailto:teacher@school.edu.au?subject=Hi%20%26%20bye&body='));
  assert.ok(decodeURIComponent(link.split('&body=')[1]).length < 1900);
});

test('report file names are safe and pair up by date and time', () => {
  const when = new Date(2026, 10, 19, 9, 5);
  assert.equal(reportFileName('Zoë O’Brien', 'Week 5: Fractions!', 'csv', when), 'Zoë-O-Brien_Week-5-Fractions_2026-11-19_0905.csv');
  assert.equal(reportBaseName('', '', when), 'student_worksheet_2026-11-19_0905');
});

test('CSV never lets an answer become a spreadsheet formula', async () => {
  const { csvCell } = await import('../js/session-log.js');
  assert.equal(csvCell('=HYPERLINK("http://bad","Click")'), `"'=HYPERLINK(""http://bad"",""Click"")"`);
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-SUM(A1)'), "'-SUM(A1)");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell(-5), '-5');           // real numbers are left alone
  assert.equal(csvCell('half, quarter'), '"half, quarter"');
  const log = new SessionLog({ student: '=cmd|"/c calc"!A1', worksheet: 'W' });
  assert.match(toCSV(log, '=1+1'), /Student,"'=cmd\|""\/c calc""!A1"/);
});

test('PDF maker: one page per picture, and every cross-reference points at its object', async () => {
  const { jpegsToPdf } = await import('../js/pdf-writer.js');
  const fakeJpeg = n => new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, ...Array(n).fill(7), 0xFF, 0xD9]);
  const pdf = jpegsToPdf([{ bytes: fakeJpeg(50), width: 1600, height: 2263 }, { bytes: fakeJpeg(80), width: 1600, height: 1131 }], { title: 'Zoë (Week 5)' });
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Type \/Pages \/Count 2 \/Kids \[4 0 R 7 0 R\]/);
  assert.match(text, /\/Title \(Zoe \\\(Week 5\\\)\)/);         // ASCII only, brackets escaped
  assert.match(text, /\/MediaBox \[0 0 595\.28 841\.\d+\]/);      // A4 portrait page
  assert.match(text, /\/MediaBox \[0 0 595\.28 420\.\d+\]/);      // a wide picture gets a shorter page
  const xrefAt = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.ok(text.slice(xrefAt).startsWith('xref'));
  const entries = text.slice(xrefAt).split('\n').slice(3).filter(l => / n $/.test(l));
  entries.forEach((l, i) => assert.ok(text.slice(Number(l.slice(0, 10))).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
});

test('a corrected word replaces its typed entry; definitions are listed', async () => {
  const { SessionLog } = await import('../js/session-log.js');
  let t = 0;
  const log = new SessionLog({ now: () => t });
  log.logWord('I', 'typed'); log.logWord('sed', 'typed');
  t = 1000; log.replaceWord('sed', 'said', 'corrected');
  log.logWord('beautiful', 'suggestion');
  log.logDefinition('beautiful');
  const st = log.stats('I said beautiful');
  assert.equal(st.typed, 1);
  assert.equal(st.corrected, 1);
  assert.equal(st.suggestion, 1);
  assert.deepEqual(st.wordsDefined, ['beautiful']);
  assert.equal(log.words.find(w => w.how === 'corrected').from, 'sed');
});
