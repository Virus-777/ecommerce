// Real files to upload: PNG product photos (solid tinted background with a simple shape) and one-page PDFs.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
function chunk(type, data) {
  const t = Buffer.from(type, 'latin1');
  return Buffer.concat([u32(data.length), t, data, u32(crc32(Buffer.concat([t, data])))]);
}

export function hexRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));

/**
 * A PNG of width×height: a light tint of `color` as background, a soft floor shadow and a shape in `color`
 * (circle, rounded square, ring or diamond). `variant` shifts the shape so photos 1..n of a product differ.
 */
export function productPng({ width = 1200, height = 1200, color = '#4a6fa5', shape = 'circle', variant = 0 }) {
  const fg = hexRgb(color);
  const bg = mix(fg, [255, 255, 255], 0.92);
  const shadow = mix(bg, [0, 0, 0], 0.12);
  const highlight = mix(fg, [255, 255, 255], 0.35);
  const cx = width / 2 + (variant % 3 - 1) * width * 0.08;
  const cy = height * 0.46 - (variant % 2) * height * 0.04;
  const r = Math.min(width, height) * (0.27 - (variant % 4) * 0.02);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      let inside = false;
      let edge = 1;
      switch (shape) {
        case 'square': {
          const k = r * 0.25;
          const ax = Math.max(Math.abs(dx) - (r - k), 0);
          const ay = Math.max(Math.abs(dy) - (r - k), 0);
          inside = ax * ax + ay * ay <= k * k;
          break;
        }
        case 'ring': {
          const d = Math.sqrt(dx * dx + dy * dy);
          inside = d <= r && d >= r * 0.55;
          break;
        }
        case 'diamond':
          inside = Math.abs(dx) + Math.abs(dy) <= r * 1.2;
          break;
        case 'bar':
          inside = Math.abs(dx) <= r * 1.3 && Math.abs(dy) <= r * 0.45;
          break;
        default:
          inside = dx * dx + dy * dy <= r * r;
      }
      let c = bg;
      const sy = y - (cy + r * 1.25);
      const sx = (x - cx) / (r * 1.1);
      if (sy * sy / (r * 0.12) ** 2 + sx * sx <= 1) c = shadow;
      if (inside) {
        // a highlight band in the top-left part of the shape
        edge = (dx + dy) / (r * 2);
        c = edge < -0.35 ? highlight : fg;
      }
      raw[p++] = c[0];
      raw[p++] = c[1];
      raw[p++] = c[2];
    }
  }
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** A wide banner: two-tone gradient with a large circle (homepage campaign banner) */
export function bannerPng({ width = 1600, height = 600, from = '#1f4e79', to = '#3a7d5c' }) {
  const a = hexRgb(from);
  const b = hexRgb(to);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  const cx = width * 0.78;
  const cy = height * 0.5;
  const r = height * 0.36;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      let c = mix(a, b, x / width);
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) c = mix(c, [255, 255, 255], 0.25);
      raw[p++] = c[0];
      raw[p++] = c[1];
      raw[p++] = c[2];
    }
  }
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** A valid one-page PDF with a line of text (seller verification documents) */
export function onePagePdf(text) {
  const safe = String(text).replace(/[()\\]/g, ' ');
  const stream = `BT /F1 18 Tf 72 720 Td (${safe}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
