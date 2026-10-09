/**
 * A tiny PDF writer for seller statements: plain text lines in Helvetica on Letter pages.
 * Statements are frozen at issue, so the PDF is rendered from the stored sections.
 */

export interface PdfLine {
  text: string;
  bold?: boolean;
  size?: number;
  gap?: number;
}

const escape = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[•·]/g, '-')
    .replace(/[–—−]/g, '-')
    .replace(/×/g, 'x')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\()]/g, (c) => `\\${c}`);

export function renderPdf(lines: PdfLine[]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageIds: number[] = [];
  const chunks: string[] = [];
  let y = 750;
  let ops = 'BT\n';
  for (const l of lines) {
    const size = l.size ?? 9;
    y -= (l.gap ?? 0) + size + 4;
    if (y < 50) {
      chunks.push(`${ops}ET`);
      ops = 'BT\n';
      y = 750 - size - 4;
    }
    ops += `/${l.bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 50 ${y} Tm (${escape(l.text)}) Tj\n`;
  }
  chunks.push(`${ops}ET`);
  for (const content of chunks) {
    const stream = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
