/**
 * Reads file types and dimensions from file headers (type sniffing), without decoding pixels:
 * PNG, JPEG (with EXIF orientation), WebP, GIF, HEIC, MP4/MOV, PDF, CSV and XLSX.
 */
import type { ProbeResult } from '../../ports.js';

const ascii = (b: Uint8Array, start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len));
const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

function indexOf(b: Uint8Array, needle: string, from = 0, to = b.length): number {
  const n = Buffer.from(needle, 'latin1');
  return Buffer.from(b.buffer, b.byteOffset, Math.min(to, b.byteLength)).indexOf(n, from);
}

/* ------------------------------------------------------------------ images */

function png(b: Uint8Array): ProbeResult | null {
  if (b.length < 26 || ascii(b, 12, 4) !== 'IHDR') return null;
  const colorType = b[25]!;
  return { format: 'png', kind: 'image', width: u32be(b, 16), height: u32be(b, 20), hasAlpha: colorType === 4 || colorType === 6 || indexOf(b, 'tRNS') >= 0 };
}

/** EXIF orientation (1–8) from a JPEG APP1 segment body starting at "Exif\0\0" */
function exifOrientation(b: Uint8Array, start: number, end: number): number | null {
  const tiff = start + 6;
  if (tiff + 8 > end) return null;
  const le = ascii(b, tiff, 2) === 'II';
  const r16 = (i: number) => (le ? u16le(b, i) : u16be(b, i));
  const r32 = (i: number) => (le ? (u16le(b, i) | (u16le(b, i + 2) << 16)) >>> 0 : u32be(b, i));
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return null;
  const count = r16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) break;
    if (r16(e) === 0x0112) return r16(e + 8);
  }
  return null;
}

function jpeg(b: Uint8Array): ProbeResult | null {
  let i = 2;
  let orientation: number | null = null;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (marker === 0xe1 && ascii(b, i + 4, 6) === 'Exif\0\0') orientation = exifOrientation(b, i + 4, i + 2 + len);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) return null;
      let height = u16be(b, i + 5);
      let width = u16be(b, i + 7);
      // orientations 5–8 are rotated by 90°: auto-orient swaps the sides
      if (orientation && orientation >= 5 && orientation <= 8) [width, height] = [height, width];
      return { format: 'jpeg', kind: 'image', width, height, hasAlpha: false };
    }
    if (marker === 0xda) return null; // image data before a frame header: corrupt
    i += 2 + len;
  }
  return null;
}

function webp(b: Uint8Array): ProbeResult | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') return { format: 'webp', kind: 'image', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, hasAlpha: false };
  if (chunk === 'VP8L') {
    const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!];
    return { format: 'webp', kind: 'image', width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)), hasAlpha: true };
  }
  if (chunk === 'VP8X') return { format: 'webp', kind: 'image', width: 1 + u24le(b, 24), height: 1 + u24le(b, 27), hasAlpha: (b[20]! & 0x10) !== 0 };
  return null;
}

function gif(b: Uint8Array): ProbeResult | null {
  if (b.length < 10) return null;
  return { format: 'gif', kind: 'image', width: u16le(b, 6), height: u16le(b, 8), hasAlpha: false };
}

/* ------------------------------------------------------------------ ISO base media (HEIC, MP4, MOV) */

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis']);

function isoMedia(b: Uint8Array): ProbeResult | null {
  const brand = ascii(b, 8, 4);
  const ftypEnd = Math.min(b.length, u32be(b, 0));
  const brands = new Set([brand]);
  for (let i = 16; i + 4 <= ftypEnd; i += 4) brands.add(ascii(b, i, 4));
  if ([...brands].some((x) => HEIC_BRANDS.has(x)) && !brands.has('isom') && !brands.has('mp42')) {
    const ispe = indexOf(b, 'ispe');
    if (ispe < 0 || ispe + 16 > b.length) return null;
    return { format: 'heic', kind: 'image', width: u32be(b, ispe + 8), height: u32be(b, ispe + 12), hasAlpha: false };
  }
  let durationSeconds: number | null = null;
  const mvhd = indexOf(b, 'mvhd');
  if (mvhd >= 0 && mvhd + 32 <= b.length) {
    const v = b[mvhd + 4];
    const timescale = v === 1 ? u32be(b, mvhd + 24) : u32be(b, mvhd + 16);
    const duration = v === 1 ? u32be(b, mvhd + 28) * 2 ** 32 + u32be(b, mvhd + 32) : u32be(b, mvhd + 20);
    if (timescale > 0) durationSeconds = Math.round((duration / timescale) * 100) / 100;
  }
  return { format: brand === 'qt  ' ? 'mov' : 'mp4', kind: 'video', durationSeconds };
}

/* ------------------------------------------------------------------ documents */

function pdf(b: Uint8Array): ProbeResult {
  const text = Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');
  const pages = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  return { format: 'pdf', kind: 'document', pageCount: Math.max(1, pages) };
}

function looksLikeText(b: Uint8Array): boolean {
  const sample = b.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.length === b.length ? sample : sample.subarray(0, sample.length - 4));
    return true;
  } catch {
    return false;
  }
}

/** Sniffs the real type from the bytes. The declared type only breaks ties between text formats. */
export function probeBytes(b: Uint8Array, hint: { contentType: string; fileName: string }): ProbeResult | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return png(b);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpeg(b);
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b);
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return gif(b);
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') return isoMedia(b);
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return pdf(b);
  if (b.length >= 4 && ascii(b, 0, 4) === 'PK\x03\x04') return indexOf(b, 'xl/') >= 0 ? { format: 'xlsx', kind: 'spreadsheet' } : null;
  const csvHint = /csv/i.test(hint.contentType) || /\.csv$/i.test(hint.fileName);
  if (csvHint && b.length > 0 && looksLikeText(b)) return { format: 'csv', kind: 'spreadsheet' };
  return null;
}

/* ------------------------------------------------------------------ metadata stripping */

/** JPEG without APP1–APP15 (EXIF, GPS, XMP, ICC) and comment segments */
export function stripJpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda) break; // start of scan: the rest is image data
    const len = u16be(b, i + 2);
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  out.push(b.subarray(i));
  return Buffer.concat(out);
}

const PNG_METADATA = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

/** PNG without EXIF and text chunks */
export function stripPng(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (!PNG_METADATA.has(type)) out.push(b.subarray(i, end));
    i = end;
  }
  return Buffer.concat(out);
}
