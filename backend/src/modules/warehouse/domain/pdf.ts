/** Minimal PDFs (Helvetica text lines) for packing slips and put-away labels, and ZPL for thermal printers. */

export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  gap?: number;
}

const clean = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[–—]/g, '-')
    .replace(/×/g, 'x')
    .replace(/·/g, '-')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\()]/g, (c) => `\\${c}`);

/** One page per entry; size 'label' is 4×6 in (288×432 pt), 'letter' is 8.5×11 in */
export function renderPdf(pages: PdfLine[][], size: 'label' | 'letter' = 'letter'): Uint8Array {
  const [w, h] = size === 'label' ? [288, 432] : [612, 792];
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
  const kids: number[] = [];
  for (const lines of pages.length ? pages : [[{ text: '' }]]) {
    let y = h - 32;
    let ops = 'BT\n';
    for (const l of lines) {
      const fontSize = l.size ?? 10;
      y -= l.gap ?? 0;
      ops += `/${l.bold ? 'F2' : 'F1'} ${fontSize} Tf 1 0 0 1 18 ${y} Tm (${clean(l.text)}) Tj\n`;
      y -= fontSize + 6;
    }
    ops += 'ET\n';
    objects.push(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}endstream`);
    const contentNo = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNo} 0 R >>`);
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

const zplText = (s: string) => clean(s).replace(/[\^~]/g, ' ');

/** One 4×6 label per entry: a Code 128 barcode of `barcode` and text lines */
export function renderZpl(labels: { barcode: string; lines: string[] }[]): Uint8Array {
  const out = labels
    .map((l) => {
      let y = 40;
      const text = l.lines.map((t) => {
        const row = `^FO40,${y}^A0N,32,32^FD${zplText(t)}^FS`;
        y += 44;
        return row;
      });
      return ['^XA', '^CI28', ...text, `^FO40,${y + 20}^BY3^BCN,120,Y,N,N^FD${zplText(l.barcode)}^FS`, '^XZ'].join('\n');
    })
    .join('\n');
  return new Uint8Array(Buffer.from(out, 'utf8'));
}
