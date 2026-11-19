// Showing PDF worksheets with PDF.js (lib/pdfjs, loaded only when needed).

let pdfjsPromise = null;
const LIB = new URL('../lib/pdfjs/', import.meta.url);

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(new URL('pdf.min.mjs', LIB).href).then(lib => {
      lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', LIB).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

/** Open a PDF from a Blob. Resolves to a PDF.js document. */
export async function openPdf(blob) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({
    data,
    standardFontDataUrl: new URL('standard_fonts/', LIB).href,
    isEvalSupported: false,
  }).promise;
}

/** Page sizes in PDF points, used to lay pages out before they're drawn. */
export async function pageSizes(doc) {
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    sizes.push({ width: vp.width, height: vp.height });
  }
  return sizes;
}

/**
 * Draw page `n` (1-based) into `canvas` at `cssWidth` CSS pixels wide.
 * Returns the PDF.js render task so a slow render can be cancelled.
 */
export async function renderPage(doc, n, canvas, cssWidth) {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  // Cap the pixel count: iPad Safari refuses canvases over ~16 million pixels.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let scale = (cssWidth / base.width) * dpr;
  const maxPixels = 12e6;
  if (base.width * base.height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (base.width * base.height));
  const vp = page.getViewport({ scale });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
  await task.promise;
  return task;
}

/** A small JPEG of page 1, for the recent worksheets list. */
export async function pdfThumbnail(doc, width = 240) {
  const canvas = document.createElement('canvas');
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / base.width });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8));
}

/** The PDF's own title, if it has a sensible one. */
export async function pdfTitle(doc) {
  try {
    const { info } = await doc.getMetadata();
    const t = info && info.Title && String(info.Title).trim();
    if (t && t.length < 120 && !/^untitled|^microsoft word|\.docx?$/i.test(t)) return t;
  } catch { /* no metadata */ }
  return '';
}
