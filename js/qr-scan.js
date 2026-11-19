// QR code scanner: camera view with a frame to aim at.
// Uses the browser's own BarcodeDetector where there is one (Chrome,
// Chromebooks), and jsQR otherwise (iPad Safari). Resolves with the text in
// the QR code, or null if the student cancels.

import { $ } from './ui.js';
import { blobToCanvas } from './image-tools.js';

let jsQRPromise = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsQRPromise) {
    jsQRPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../lib/jsQR.js', import.meta.url).href;
      s.onload = () => resolve(window.jsQR);
      s.onerror = () => { jsQRPromise = null; reject(new Error('Could not load the QR reader')); };
      document.head.appendChild(s);
    });
  }
  return jsQRPromise;
}

async function makeDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const bd = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async source => {
          const codes = await bd.detect(source);
          return codes.length ? codes[0].rawValue : null;
        };
      }
    } catch { /* fall back to jsQR */ }
  }
  const jsQR = await loadJsQR();
  return async canvas => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
    return code ? code.data : null;
  };
}

/** Read a QR code from a photo (for when the camera can't be used live). */
export async function decodeQrFromImage(blob) {
  const canvas = await blobToCanvas(blob, 1600);
  const detect = await makeDetector();
  return detect(canvas);
}

export function scanQr() {
  return new Promise(resolve => {
    const screen = $('#scanner');
    const video = $('#scanner-video');
    const msg = $('#scanner-msg');
    const work = document.createElement('canvas');
    let stream = null, running = true, timer = null;

    const stop = result => {
      running = false;
      clearTimeout(timer);
      if (stream) stream.getTracks().forEach(t => t.stop());
      video.srcObject = null;
      screen.hidden = true;
      $('#scanner-cancel').removeEventListener('click', onCancel);
      $('#scanner-photo').removeEventListener('change', onPhoto);
      resolve(result);
    };
    const onCancel = () => stop(null);
    const onPhoto = async e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      msg.textContent = 'Reading the photo…';
      const text = await decodeQrFromImage(file).catch(() => null);
      if (text) stop(text);
      else msg.textContent = 'No QR code found in that photo. Try again, closer and in focus.';
    };

    $('#scanner-cancel').addEventListener('click', onCancel);
    $('#scanner-photo').addEventListener('change', onPhoto);
    msg.textContent = 'Point the camera at the QR code.';
    screen.hidden = false;

    (async () => {
      let detect;
      try {
        detect = await makeDetector();
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (err) {
        if (!running) return;
        msg.textContent = err && err.name === 'NotAllowedError'
          ? 'The camera is blocked. Allow it in Settings › Safari › Camera, or use “Choose a photo” below.'
          : 'The camera isn’t available. Use “Choose a photo” of the QR code instead.';
        return;
      }
      if (!running) { stream.getTracks().forEach(t => t.stop()); return; }
      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      await video.play().catch(() => {});

      const tick = async () => {
        if (!running) return;
        if (video.readyState >= 2 && video.videoWidth) {
          // Look at the middle of the picture, scaled down: faster, and it's where the frame is.
          const side = Math.min(video.videoWidth, video.videoHeight);
          const size = Math.min(720, side);
          work.width = work.height = size;
          work.getContext('2d', { willReadFrequently: true }).drawImage(
            video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, size, size);
          const text = await detect(work).catch(() => null);
          if (text && running) {
            if (navigator.vibrate) navigator.vibrate(60);
            stop(text);
            return;
          }
        }
        timer = setTimeout(tick, 120);
      };
      tick();
    })();
  });
}
