import test from 'node:test';
import assert from 'node:assert/strict';
import { groupWords, splitRun, speakable, keepWord, splitNumber, fixCapitalI, swipeArea } from '../js/page-text.js';

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

test('speakable trims bullets and underscores', () => {
  assert.equal(speakable('•Plants'), 'Plants');
  assert.equal(speakable('answer___'), 'answer');
  assert.equal(speakable('half?'), 'half?');
});

test('a ruled line between two lines of text keeps them apart', () => {
  const words = [W('tap', 0.15, 0.18, 0.04, 0.014), W('root', 0.2, 0.18, 0.04, 0.014),
    W('thin', 0.15, 0.196, 0.045, 0.014), W('stem', 0.2, 0.196, 0.045, 0.014)];
  assert.equal(groupWords(words).length, 1);
  assert.equal(groupWords(words, 1.414, [{ y: 0.1945, x0: 0.13, x1: 0.42 }]).length, 2);
});

test('unsure words are kept only when they look real', () => {
  assert.equal(keepWord('beautiful', 17), true);
  assert.equal(keepWord('3.', 55), true);
  assert.equal(keepWord('RET', 41), false);     // unsure capitals: usually a picture misread
  assert.equal(keepWord('Citi', 21), false);
  assert.equal(keepWord('I', 92), true);
  assert.equal(keepWord('cc', 17), false);
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

test('a capital I read as | or l before a word becomes I', () => {
  assert.deepEqual(fixCapitalI(['|', 'see', 'the']), ['I', 'see', 'the']);
  assert.deepEqual(fixCapitalI(['Can', 'l', 'go']), ['Can', 'I', 'go']);
  assert.deepEqual(fixCapitalI(['1', 'see', 'it']), ['I', 'see', 'it']);
  assert.deepEqual(fixCapitalI(['1', 'apple']), ['1', 'apple']);
  assert.deepEqual(fixCapitalI(['a', '|', 'B']), ['a', '|', 'B']);
});

test('stacked single words stay separate', () => {
  const blocks = groupWords([W('deer', 0.8, 0.232, 0.12, 0.043), W('door', 0.8, 0.283, 0.12, 0.044)]);
  assert.equal(blocks.length, 2);
});

test('a swipe covers its own box, widened by half the highlighter', () => {
  const a = swipeArea([[0.2, 0.3], [0.5, 0.31], [0.6, 0.3]], 0.04, 1.414);
  assert.ok(Math.abs(a.x0 - 0.18) < 1e-9 && Math.abs(a.x1 - 0.62) < 1e-9);
  assert.ok(Math.abs(a.y0 - (0.3 - 0.02 / 1.414)) < 1e-9 && Math.abs(a.y1 - (0.31 + 0.02 / 1.414)) < 1e-9);
  const edge = swipeArea([[0.001, 0.999]], 0.04, 1.414);
  assert.equal(edge.x0, 0); assert.equal(edge.y1, 1);
});

test('word suggestions: completions, corrections and tidied definitions (offline)', async () => {
  const sp = await import('../js/spelling.js');
  sp.setOnline(false);
  assert.deepEqual(sp.completions('beau'), ['beauty', 'beautiful']);
  assert.equal(sp.misspelt('sed'), true);
  assert.equal(sp.misspelt('because'), false);
  assert.ok((await sp.spellingSuggestions('frend')).some(s => s.word === 'friend'));
  assert.equal(await sp.definition('dictionary'), 'Book listing');    // unfinished "(usu" removed
  assert.equal(await sp.definition('said'), null);                     // "Past and past part" isn't shown
  assert.match(await sp.definition('happy'), /pleasure/);
});

test('the word at the cursor, and the word just finished', async () => {
  const { wordAround, wordBefore } = await import('../js/word-helper.js').catch(() => ({}));
  if (!wordAround) return; // needs a browser (it touches window)
  assert.deepEqual(wordAround('I sed it', 4), { start: 2, end: 5, word: 'sed' });
  assert.deepEqual(wordBefore('I sed ', 6), { start: 2, end: 5, word: 'sed' });
});
