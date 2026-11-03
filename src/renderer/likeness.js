'use strict';

// Pictures compared without any model (the method of storytold/craft-anything's checks):
//  - blank: almost every pixel the same brightness (luma spread under 2 on a 64×36 thumbnail);
//  - likeness: the mean of perceptual detail (SSIM on brightness) and coarse layout (16-px tiles
//    whose average colour is within 24 of the other picture's), both pictures brought to the same
//    size first, as a percentage.
// Pure: works on RGBA byte arrays (ImageData-style). The renderer decodes and resizes.

(() => {
const lumaAt = (rgba, o) => 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];

// Box-average an RGBA picture down (or up) to w×h, as RGBA floats.
function resize(rgba, width, height, w, h) {
  const out = new Float64Array(w * h * 4);
  const n = new Uint32Array(w * h);
  for (let y = 0; y < height; y++) {
    const ty = Math.min(h - 1, Math.floor((y * h) / height));
    for (let x = 0; x < width; x++) {
      const tx = Math.min(w - 1, Math.floor((x * w) / width));
      const i = ty * w + tx;
      const o = (y * width + x) * 4;
      out[i * 4] += rgba[o];
      out[i * 4 + 1] += rgba[o + 1];
      out[i * 4 + 2] += rgba[o + 2];
      out[i * 4 + 3] += rgba[o + 3];
      n[i]++;
    }
  }
  // A target bigger than the source leaves cells empty: fill them from the nearest source pixel.
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const i = ty * w + tx;
      if (n[i]) {
        for (let k = 0; k < 4; k++) out[i * 4 + k] /= n[i];
      } else {
        const o = (Math.min(height - 1, Math.floor((ty * height) / h)) * width + Math.min(width - 1, Math.floor((tx * width) / w))) * 4;
        for (let k = 0; k < 4; k++) out[i * 4 + k] = rgba[o + k];
      }
    }
  }
  return out;
}

function isBlank(rgba, width, height) {
  if (!width || !height) return true;
  const s = resize(rgba, width, height, 64, 36);
  const l = [];
  for (let i = 0; i < 64 * 36; i++) l.push(lumaAt(s, i * 4));
  const mean = l.reduce((a, b) => a + b, 0) / l.length;
  const sd = Math.sqrt(l.reduce((a, b) => a + (b - mean) ** 2, 0) / l.length);
  return sd < 2;
}

// Mean SSIM over 8×8 windows of brightness; 1 = the same picture.
function ssim(a, b, w, h) {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let sum = 0;
  let count = 0;
  for (let y0 = 0; y0 < h; y0 += 8) {
    for (let x0 = 0; x0 < w; x0 += 8) {
      let ma = 0;
      let mb = 0;
      let n = 0;
      for (let y = y0; y < Math.min(h, y0 + 8); y++) for (let x = x0; x < Math.min(w, x0 + 8); x++) {
        ma += lumaAt(a, (y * w + x) * 4);
        mb += lumaAt(b, (y * w + x) * 4);
        n++;
      }
      ma /= n;
      mb /= n;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let y = y0; y < Math.min(h, y0 + 8); y++) for (let x = x0; x < Math.min(w, x0 + 8); x++) {
        const la = lumaAt(a, (y * w + x) * 4) - ma;
        const lb = lumaAt(b, (y * w + x) * 4) - mb;
        va += la * la;
        vb += lb * lb;
        cov += la * lb;
      }
      va /= n;
      vb /= n;
      cov /= n;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count++;
    }
  }
  return count ? Math.max(0, sum / count) : 0;
}

// Share of 16-px tiles whose average colour matches the other picture's within `threshold`.
function blockSimilarity(a, b, w, h, block = 16, threshold = 24) {
  let same = 0;
  let counted = 0;
  for (let y0 = 0; y0 < h; y0 += block) {
    for (let x0 = 0; x0 < w; x0 += block) {
      const ma = [0, 0, 0];
      const mb = [0, 0, 0];
      let n = 0;
      for (let y = y0; y < Math.min(h, y0 + block); y++) for (let x = x0; x < Math.min(w, x0 + block); x++) {
        const o = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) {
          ma[k] += a[o + k];
          mb[k] += b[o + k];
        }
        n++;
      }
      counted++;
      if (ma.every((v, k) => Math.abs(v / n - mb[k] / n) <= threshold)) same++;
    }
  }
  return counted ? same / counted : 1;
}

const COMPARE = [320, 200];

// How alike two pictures look, 0–100. Each is { rgba, width, height }.
function likeness(p, q) {
  const [w, h] = COMPARE;
  const a = resize(p.rgba, p.width, p.height, w, h);
  const b = resize(q.rgba, q.width, q.height, w, h);
  return Math.round((ssim(a, b, w, h) + blockSimilarity(a, b, w, h)) * 50);
}

// The widths a web page is compared at: desktop, tablet, phone.
const WIDTHS = [1440, 768, 390];

function normWidths(list) {
  const ws = (Array.isArray(list) ? list : []).map((n) => Math.round(Number(n))).filter((n) => n >= 240 && n <= 3840);
  return ws.length ? [...new Set(ws)].slice(0, 4) : WIDTHS;
}

// The result line for one width.
function likenessLine(width, score) {
  const verdict = score >= 85 ? 'close' : score >= 65 ? 'similar, with differences' : 'clearly different';
  return `At ${width}px wide it looks about ${score}% like the reference (${verdict}).`;
}

const LikenessExports = { resize, isBlank, ssim, blockSimilarity, likeness, WIDTHS, normWidths, likenessLine };
if (typeof module !== 'undefined' && module.exports) module.exports = LikenessExports;
if (typeof window !== 'undefined') window.Likeness = LikenessExports;
})();
