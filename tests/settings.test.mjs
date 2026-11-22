// Settings shared with other pages on the same site (Classroom Inbox's join
// page, Word Helper): a change made in another tab must show up here, and
// must never be written over by this tab's older copy.
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.window = new EventTarget();
const storageEvent = key => Object.assign(new Event('storage'), { key });

const KEY = 'pagepal.settings';
store.set(KEY, JSON.stringify({ studentName: 'Mia S', teacher: null, wordHelperOnly: 'keep me' }));
const { getSetting, setSetting, onSettingChange } = await import('../js/settings.js');
const saved = () => JSON.parse(store.get(KEY));
const TEACHER = { name: 'Mr Evans 3/4B', url: 'https://script.google.com/macros/s/X/exec', secret: 'k'.repeat(24) };

test('a teacher connected in another tab shows up here, and listeners hear about it', () => {
  assert.equal(getSetting('teacher'), null);
  const heard = [];
  const stop = onSettingChange((name, value) => heard.push([name, value]));
  store.set(KEY, JSON.stringify({ ...saved(), teacher: TEACHER })); // the join page saves
  window.dispatchEvent(storageEvent(KEY));
  assert.deepEqual(getSetting('teacher'), TEACHER);
  assert.deepEqual(heard, [['teacher', TEACHER]], 'only what changed');
  window.dispatchEvent(storageEvent('something.else'));
  assert.equal(heard.length, 1, 'other keys are ignored');
  stop();
});

test('saving here never writes over a newer change from another tab', () => {
  // Another tab disconnects (and adds a field) without a storage event reaching us yet.
  store.set(KEY, JSON.stringify({ ...saved(), teacher: null, newField: 1 }));
  setSetting('speechRate', 0.75);
  const s = saved();
  assert.equal(s.teacher, null, 'the disconnect stands');
  assert.equal(s.newField, 1);
  assert.equal(s.wordHelperOnly, 'keep me');
  assert.equal(s.speechRate, 0.75);
  assert.equal(s.studentName, 'Mia S');
});

test('storage cleared in another tab: back to the defaults', () => {
  store.clear();
  window.dispatchEvent(storageEvent(null));
  assert.equal(getSetting('teacher'), null);
  assert.equal(getSetting('studentName'), '');
});
