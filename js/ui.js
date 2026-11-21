// Small DOM helpers shared across PagePal screens.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer = null;

/** Show a short message at the bottom of the screen. */
export function toast(message, ms = 3000) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 250);
  }, ms);
}

/** Put away the current message straight away. */
export function hideToast() {
  const el = $('#toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.classList.remove('show');
  el.hidden = true;
}

/** Escape text for safe insertion into innerHTML. */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Trigger a file download from a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Full-screen "please wait" card. Returns a function that hides it. */
export function showBusy(message) {
  const el = $('#busy');
  if (!el) return () => {};
  $('#busy-text').textContent = message;
  el.hidden = false;
  return () => { el.hidden = true; };
}

export function setBusyText(message) {
  const t = $('#busy-text');
  if (t) t.textContent = message;
}

/**
 * Open a file picker and resolve with the chosen File (or null if cancelled).
 * Must be called straight from a tap, or iPad Safari ignores it.
 */
export function pickFile(input) {
  return new Promise(resolve => {
    const done = file => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.value = '';
      resolve(file);
    };
    const onChange = () => done(input.files && input.files[0] ? input.files[0] : null);
    const onCancel = () => done(null);
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    input.click();
  });
}
