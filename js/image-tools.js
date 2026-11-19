// Image processing for photographed worksheets: straighten a page from its
// four corners, rotate, and "scan" it (even out shadows, whiten the paper).
// The maths is plain JavaScript on pixel arrays, so it runs on any iPad.

/** Largest side we keep for a page photo. Enough for clear text, small enough to store. */
export const MAX_SIDE = 2400;

/** Load an image Blob into a canvas, shrinking big camera photos. */
export async function blobToCanvas(blob, maxSide = 3200) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent screenshots become white paper
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Rotate a canvas a quarter turn. dir = 1 clockwise, -1 anticlockwise. */
export function rotateCanvas(src, dir = 1) {
  const c = document.createElement('canvas');
  c.width = src.height;
  c.height = src.width;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(dir * Math.PI / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.88) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not save image'))), type, quality));
}

export function thumbnail(canvas, width = 240) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round(canvas.height * width / canvas.width);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return canvasToBlob(c, 'image/jpeg', 0.8);
}

// ── Perspective (four-corner) correction ──────────────

/**
 * Homography mapping the rectangle (0,0)-(w,h) onto quad [tl, tr, br, bl].
 * Returns 9 numbers (row-major 3x3, last = 1).
 */
export function rectToQuad(w, h, quad) {
  const src = [[0, 0], [w, 0], [w, h], [0, h]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = quad[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h8 = solve(A, b);
  return [...h8, 1];
}

/** Gaussian elimination with partial pivoting. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    if (Math.abs(d) < 1e-12) throw new Error('Corners are in a straight line');
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      if (f) for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Output size for a quad: average of opposite edges, longest side capped. */
export function quadOutputSize(quad, maxSide = MAX_SIDE) {
  const [tl, tr, br, bl] = quad;
  let w = (dist(tl, tr) + dist(bl, br)) / 2;
  let h = (dist(tl, bl) + dist(tr, br)) / 2;
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Is the quad simply the whole image? Then no warp is needed. */
export function isFullFrame(quad, w, h, tol = 2) {
  const full = [[0, 0], [w, 0], [w, h], [0, h]];
  return quad.every((p, i) => dist(p, full[i]) <= tol);
}

/** Straighten the page inside `quad` (corners in src pixels: tl, tr, br, bl). */
export function warpQuad(src, quad, maxSide = MAX_SIDE) {
  const { width: W, height: H } = quadOutputSize(quad, maxSide);
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const octx = out.getContext('2d');

  if (isFullFrame(quad, src.width, src.height)) {
    octx.drawImage(src, 0, 0, W, H);
    return out;
  }

  const sw = src.width, sh = src.height;
  const sdata = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const img = octx.createImageData(W, H);
  const d = img.data;
  const M = rectToQuad(W, H, quad);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w = M[6] * px + M[7] * py + M[8];
      let u = (M[0] * px + M[1] * py + M[2]) / w - 0.5;
      let v = (M[3] * px + M[4] * py + M[5]) / w - 0.5;
      const o = (y * W + x) * 4;
      if (u < 0) u = 0; else if (u > sw - 1) u = sw - 1;
      if (v < 0) v = 0; else if (v > sh - 1) v = sh - 1;
      const x0 = u | 0, y0 = v | 0;
      const x1 = x0 + 1 < sw ? x0 + 1 : x0, y1 = y0 + 1 < sh ? y0 + 1 : y0;
      const fx = u - x0, fy = v - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sdata[i00 + c] + (sdata[i10 + c] - sdata[i00 + c]) * fx;
        const bot = sdata[i01 + c] + (sdata[i11 + c] - sdata[i01 + c]) * fx;
        d[o + c] = top + (bot - top) * fy;
      }
      d[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// ── "Scan" clean-up ───────────────────────────────────

/**
 * Even out shadows and whiten the paper, like a document scanner.
 * Estimates the paper brightness across the page (ignoring the dark ink),
 * then divides each pixel by it.
 */
export function enhanceDocument(canvas) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;

  // Brightness map at 1/16 scale.
  const step = 16;
  const bw = Math.ceil(W / step), bh = Math.ceil(H / step);
  let bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let max = 0;
      // Brightest pixel in the block (sampled) = local paper colour.
      for (let y = by * step; y < Math.min(H, (by + 1) * step); y += 2) {
        for (let x = bx * step; x < Math.min(W, (bx + 1) * step); x += 2) {
          const i = (y * W + x) * 4;
          const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (l > max) max = l;
        }
      }
      bg[by * bw + bx] = max;
    }
  }
  // Smooth the paper estimate so it follows shadows gently, without blotches.
  const smooth = src => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let acc = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || yy >= bh || xx < 0 || xx >= bw) continue;
            acc += src[yy * bw + xx]; n++;
          }
        }
        out[y * bw + x] = acc / n;
      }
    }
    return out;
  };
  bg = smooth(smooth(bg));

  for (let y = 0; y < H; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / step - 0.5));
    const y0 = fy | 0, y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / step - 0.5));
      const x0 = fx | 0, x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      const top = bg[y0 * bw + x0] + (bg[y0 * bw + x1] - bg[y0 * bw + x0]) * tx;
      const bot = bg[y1 * bw + x0] + (bg[y1 * bw + x1] - bg[y1 * bw + x0]) * tx;
      const paper = top + (bot - top) * ty;
      // Brighten shadowed paper, but don't blow up genuinely dark areas
      // (a desk edge, a photo on the worksheet) into odd colours.
      const k = Math.min(2.2, 255 / Math.max(1, paper));
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = d[i + c] * k;
        // Gentle S-curve: darker ink, cleaner white.
        v = v >= 235 ? 255 : v < 80 ? v * 0.85 : v;
        d[i + c] = v;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
