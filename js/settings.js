// Per-device settings, kept in localStorage.
// (Worksheets and session logs are bigger and live in IndexedDB — see store.js.)

const KEY = 'pagepal.settings';

const DEFAULTS = {
  studentName: '',
  sizeLevels: { text: 0, stamp: 1, ink: 1 }, // small/medium/large (0-2): the last size tapped for each kind
  displayMode: 'dyslexia', // see display-modes.js
  voiceName: '',           // '' = pick the best English voice automatically
  speechRate: 0.88,        // same default as Word Helper
  teacherEmail: '',        // pre-fills "Email summary"
  teacher: null,           // {name, url, secret} from the class QR code (Send to teacher)
};

// Other pages on the same site share these settings: the Classroom Inbox
// join page, and Word Helper (connecting or disconnecting a teacher). So the
// copy in memory is re-read when another tab saves, and before every save,
// so a change made elsewhere is never written over with an old value.
let cache = null;
const listeners = new Set();

function load() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* private mode or corrupt */ }
  cache = { ...DEFAULTS, ...saved };
  return cache;
}

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Re-read the saved settings, telling listeners about anything that changed. */
export function reloadSettings() {
  const before = load();
  cache = null;
  const after = load();
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!same(before[name], after[name])) listeners.forEach(fn => fn(name, after[name]));
  }
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', e => {
    if (e.key === KEY || e.key === null) reloadSettings(); // null: storage was cleared
  });
}

export function getSettings() {
  return { ...load() };
}

export function getSetting(name) {
  return load()[name];
}

export function setSetting(name, value) {
  reloadSettings(); // pick up changes from other tabs first
  const s = load();
  if (s[name] === value) return;
  s[name] = value;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage full or blocked */ }
  listeners.forEach(fn => fn(name, value));
}

/** Call fn(name, value) whenever a setting changes. Returns an unsubscribe function. */
export function onSettingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
