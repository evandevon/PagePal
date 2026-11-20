// A tiny PDF maker: one JPEG picture per page, nothing else.
// Enough to turn a finished worksheet (page pictures with the answers drawn
// on) into a PDF the teacher can open, scroll and print. No library needed:
// JPEGs go into a PDF as they are (the DCTDecode filter).

const PAGE_WIDTH_PT = 595.28; // A4 width in points; height follows each picture's shape

const enc = new TextEncoder();

/**
 * @param {{bytes: Uint8Array, width: number, height: number}[]} pages  JPEG bytes and pixel size
 * @param {{title?: string}} [info]
 * @returns {Uint8Array} the PDF file
 */
export function jpegsToPdf(pages, info = {}) {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = part => {
    const b = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(b);
    length += b.length;
  };
  const startObject = n => { offsets[n] = length; push(`${n} 0 obj\n`); };

  // Objects: 1 catalog, 2 page list, 3 info, then per page: page, content, image.
  const n = pages.length;
  const pageObj = i => 4 + i * 3;
  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // marks the file as containing binary data

  startObject(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  startObject(2);
  push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>\nendobj\n`);
  startObject(3);
  push(`<< /Producer (PagePal) /Title (${pdfText(info.title || 'PagePal worksheet')}) >>\nendobj\n`);

  pages.forEach((p, i) => {
    const w = PAGE_WIDTH_PT;
    const h = +(PAGE_WIDTH_PT * p.height / p.width).toFixed(2);
    const page = pageObj(i), content = page + 1, image = page + 2;
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    startObject(page);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>\nendobj\n`);
    startObject(content);
    push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream\nendobj\n`);
    startObject(image);
    push(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`);
    push(p.bytes);
    push('\nendstream\nendobj\n');
  });

  const total = 4 + n * 3; // object count including the free object 0
  const xref = length;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(table);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

/** Text for a PDF string: ASCII only, with ( ) \ escaped. */
function pdfText(s) {
  return String(s).normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/[()\\]/g, '\\$&').slice(0, 200);
}
