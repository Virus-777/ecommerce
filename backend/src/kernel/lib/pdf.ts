/**
 * A tiny PDF writer: plain text lines in Helvetica (the PDF standard fonts, nothing embedded). Used for receipts,
 * invoices, statements, packing slips and labels. A page whose lines do not fit continues on a new page, and a line
 * wider than the page wraps at spaces.
 */

export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** Extra space above the line, in points */
  gap?: number;
}

export interface PdfLayout {
  /** 'letter' is 8.5×11 in (612×792 pt), 'label' is 4×6 in (288×432 pt) */
  page?: 'letter' | 'label';
  /** Font size of lines without one; default 10 */
  size?: number;
}

const PAGES = { letter: { w: 612, h: 792, margin: 50, leading: 4 }, label: { w: 288, h: 432, margin: 18, leading: 6 } } as const;

/** Text the standard fonts can show: accents dropped, typographic marks to ASCII, anything else left out */
export const asciiText = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[•·]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/×/g, 'x')
    .replace(/›/g, '>')
    .replace(/[^\x20-\x7e]/g, '');

const pdfString = (s: string) => asciiText(s).replace(/[\\()]/g, (c) => `\\${c}`);

/** Splits text at spaces into rows of at most `max` characters (a longer word is cut) */
function wrap(text: string, max: number): string[] {
  const rows: string[] = [];
  let row = '';
  for (const word of text.split(' ')) {
    let w = word;
    while (w.length > max) {
      if (row) rows.push(row);
      rows.push(w.slice(0, max));
      w = w.slice(max);
      row = '';
    }
    if (!row) row = w;
    else if (row.length + 1 + w.length <= max) row += ` ${w}`;
    else {
      rows.push(row);
      row = w;
    }
  }
  rows.push(row);
  return rows;
}

/** Lays out the pages (each entry starts a new page) and returns the PDF bytes */
export function renderPdf(pages: PdfLine[][], o: PdfLayout = {}): Uint8Array {
  const { w, h, margin, leading } = PAGES[o.page ?? 'letter'];
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
  const kids: number[] = [];
  const addPage = (ops: string) => {
    const content = `BT\n${ops}ET`;
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${objects.length} 0 R >>`);
    kids.push(objects.length);
  };
  for (const lines of pages.length ? pages : [[]]) {
    let y = h - margin;
    let ops = '';
    for (const l of lines) {
      const size = l.size ?? o.size ?? 10;
      // Helvetica averages about half the font size per character; 0.55 leaves room for capitals
      const rows = wrap(asciiText(l.text), Math.max(8, Math.floor((w - 2 * margin) / (size * 0.55))));
      rows.forEach((row, i) => {
        y -= (i === 0 ? (l.gap ?? 0) : 0) + size + leading;
        if (y < margin && ops) {
          addPage(ops);
          ops = '';
          y = h - margin - size - leading;
        }
        ops += `/${l.bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${margin} ${y} Tm (${pdfString(row)}) Tj\n`;
      });
    }
    addPage(ops);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
