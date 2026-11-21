import test from 'node:test';
import assert from 'node:assert/strict';
import { groupWords, splitRun, wordAt, speakable, keepWord, splitNumber } from '../js/page-text.js';

const W = (t, x, y, w = 0.06, h = 0.02) => ({ t, x, y, w, h, space: true });

test('words in rows become lines, close lines one block, far ones separate', () => {
  const words = [
    W('is', 0.18, 0.1), W('What', 0.1, 0.1), W('half?', 0.26, 0.1),   // out of order on purpose
    W('of', 0.1, 0.125), W('four', 0.18, 0.125),                       // next line, close: same block
    W('Name:', 0.1, 0.4), W('____', 0.2, 0.4),                          // far below: new block; underscores dropped
  ];
  const blocks = groupWords(words);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].map(w => w.t), ['What', 'is', 'half?', 'of', 'four']);
  assert.deepEqual(blocks[1].map(w => w.t), ['Name:']);
});

test('a wide gap on a row splits columns into separate blocks', () => {
  const blocks = groupWords([W('Left', 0.1, 0.2), W('side', 0.17, 0.2), W('Right', 0.7, 0.2), W('side', 0.77, 0.2)]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map(b => b.map(w => w.t).join(' ')), ['Left side', 'Right side']);
});

test('pieces of one word drawn separately are joined', () => {
  const a = { t: 'frac', x: 0.1, y: 0.1, w: 0.04, h: 0.02, space: false };
  const b = { t: 'tions', x: 0.1401, y: 0.1, w: 0.05, h: 0.02, space: true };
  assert.deepEqual(groupWords([a, b])[0].map(w => w.t), ['fractions']);
});

test('splitRun shares a run between its words', () => {
  const ws = splitRun('one half', { x: 0, y: 0.5, w: 0.8, h: 0.02 });
  assert.deepEqual(ws.map(w => w.t), ['one', 'half']);
  assert.ok(Math.abs(ws[0].w - 0.3) < 1e-9 && Math.abs(ws[1].x - 0.4) < 1e-9);
  assert.equal(ws[0].space, true);
});

test('wordAt finds the tapped word with a little slack, and misses blank space', () => {
  const blocks = groupWords([W('What', 0.1, 0.1), W('is', 0.18, 0.1), W('Name', 0.1, 0.5)]);
  assert.deepEqual(wordAt(blocks, 0.19, 0.11), { block: 0, index: 1 });
  assert.deepEqual(wordAt(blocks, 0.13, 0.0985), { block: 0, index: 0 }); // just above the box
  assert.equal(wordAt(blocks, 0.5, 0.3), null);
});

test('speakable trims bullets and underscores', () => {
  assert.equal(speakable('•Plants'), 'Plants');
  assert.equal(speakable('answer___'), 'answer');
  assert.equal(speakable('half?'), 'half?');
});

test('a ruled line between two lines of text keeps them apart', () => {
  const words = [W('root', 0.15, 0.18, 0.04, 0.014), W('stem', 0.15, 0.196, 0.045, 0.012)];
  assert.equal(groupWords(words).length, 1);
  assert.equal(groupWords(words, 1.414, [{ y: 0.1945, x0: 0.13, x1: 0.42 }]).length, 2);
});

test('unsure words are kept only when they look real', () => {
  assert.equal(keepWord('beautiful', 17), true);
  assert.equal(keepWord('3.', 30), true);
  assert.equal(keepWord('RET', 41), true);      // capitals could be a heading
  assert.equal(keepWord('pecaus€', 18), false);
  assert.equal(keepWord('|_|', 28), false);
  assert.equal(keepWord('—', 90), false);
  assert.equal(keepWord('because', 5), false);  // too unsure
  assert.equal(keepWord('x7#q', 95), true);     // sure: trust it
});

test('a number stuck to a word is split', () => {
  assert.deepEqual(splitNumber('3.school', 0, 80).map(p => p.t), ['3.', 'school']);
  assert.equal(splitNumber('3.school', 0, 80)[0].x1, 20);
  assert.deepEqual(splitNumber('school', 0, 60), [{ t: 'school', x0: 0, x1: 60 }]);
});

test('words on a tilted photo are hit inside their slanted box', () => {
  const r = -0.14; // about 8 degrees
  const blocks = [[{ t: 'Spelling', x: 0.3, y: 0.15, w: 0.1, h: 0.03, r }]];
  // centre (0.35, 0.165): a point along the slant, towards the right end, rising
  const ax = 0.04, ay = Math.tan(r) * ax / 1.414;
  assert.ok(wordAt(blocks, 0.35 + ax, 0.165 + ay));
});
