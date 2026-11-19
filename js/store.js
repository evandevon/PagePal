// On-device storage for worksheets and session logs (IndexedDB).
// Page images and PDFs are far too big for localStorage, so they live here.
//
// Note: Safari may clear storage for websites that haven't been opened for
// a while. Adding PagePal to the Home Screen keeps it, so the app nudges
// students to do that (see the install card in index.html).

const DB_NAME = 'pagepal';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB not available')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('worksheets')) {
        // {id, title, source, createdAt, updatedAt, pages, textLayer, annotations}
        const ws = db.createObjectStore('worksheets', { keyPath: 'id' });
        ws.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('sessions')) {
        // {id, worksheetId, student, startedAt, log}
        const ss = db.createObjectStore('sessions', { keyPath: 'id' });
        ss.createIndex('worksheetId', 'worksheetId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export function put(storeName, value) {
  return tx(storeName, 'readwrite', s => s.put(value));
}

export function get(storeName, id) {
  return tx(storeName, 'readonly', s => s.get(id));
}

export function remove(storeName, id) {
  return tx(storeName, 'readwrite', s => s.delete(id));
}

/** Most recently updated worksheets first. */
export async function recentWorksheets(limit = 10) {
  const all = await tx('worksheets', 'readonly', s => s.getAll());
  return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit);
}

/** Ask the browser not to clear our data when space is short. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* not supported */ }
  return false;
}
