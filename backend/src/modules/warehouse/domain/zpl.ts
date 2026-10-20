/** ZPL for thermal label printers: 4×6 in put-away labels with a Code 128 barcode. */
import { asciiText } from '../../../kernel/lib/pdf.js';

const zplText = (s: string) => asciiText(s).replace(/[\^~]/g, ' ');

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
