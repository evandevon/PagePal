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

let cache = null;
const listeners = new Set();

function load() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* private mode or corrupt */ }
  cache = { ...DEFAULTS, ...saved };
  return cache;
}

export function getSettings() {
  return { ...load() };
}

export function getSetting(name) {
  return load()[name];
}

export function setSetting(name, value) {
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
