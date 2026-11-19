// Word (.docx) worksheets.
//
// Google won't convert uploaded Word files for a website that isn't signed
// in, so PagePal lays the pages out itself: docx-preview turns the file into
// HTML pages, then html2canvas turns each page into an image. Simple
// worksheets (text, tables, pictures) come out well; complex layouts may
// shift slightly, so the teacher page suggests PDF for an exact copy.
// The libraries (~370 KB) are only downloaded the first time a .docx opens.

const LIB = new URL('../lib/docx/', import.meta.url);
let libsPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

function loadLibs() {
  if (!libsPromise) {
    libsPromise = (async () => {
      if (!window.JSZip) await loadScript(new URL('jszip.min.js', LIB).href);
      if (!window.docx) await loadScript(new URL('docx-preview.min.js', LIB).href);
      if (!window.html2canvas) await loadScript(new URL('html2canvas.min.js', LIB).href);
    })();
    libsPromise.catch(() => { libsPromise = null; });
  }
  return libsPromise;
}

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Lay out a .docx and return one canvas per page. */
export async function docxToCanvases(blob, { onProgress } = {}) {
  await loadLibs();
  // Laid out off-screen, at the page's real size, then photographed page by page.
  const host = document.createElement('div');
  host.className = 'docx-host';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  try {
    await window.docx.renderAsync(blob, host, null, {
      className: 'docx',
      inWrapper: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      useBase64URL: true, // pictures as data: URLs, so html2canvas can draw them
    });
    // Let web fonts and pictures finish loading before taking the images.
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await Promise.all([...host.querySelectorAll('img')].map(img => (img.complete ? null : img.decode().catch(() => null))));

    const pages = [...host.querySelectorAll('section.docx')];
    if (!pages.length) throw new Error('No pages found in the Word file');
    const canvases = [];
    for (let i = 0; i < pages.length; i++) {
      onProgress && onProgress(i + 1, pages.length);
      const page = pages[i];
      const scale = Math.min(2, 1700 / page.offsetWidth); // about 1700 px wide, like a 200 dpi scan
      canvases.push(await window.html2canvas(page, { scale, backgroundColor: '#ffffff', logging: false }));
    }
    return canvases;
  } finally {
    host.remove();
  }
}
