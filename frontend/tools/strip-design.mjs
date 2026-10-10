// Prints a design export page with inline Lucide SVGs collapsed to <Icon name="..."/>
// and the shared store/back-office chrome optionally removed, so the page body is easy to read.
// Usage: node tools/strip-design.mjs <page.html> [--body]   (--body: only the <main> content)
import { readFileSync } from 'node:fs';
const [file, ...flags] = process.argv.slice(2);
let html = readFileSync(file, 'utf8');
html = html.replace(/<svg\b[^>]*data-lucide="([^"]+)"[^>]*?(?:class="([^"]*)")?[^>]*>[\s\S]*?<\/svg>/g, (m, name) => {
  const cls = (m.match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/).filter((c) => c && !c.startsWith('lucide')).join(' ');
  return `<Icon name="${name}"${cls ? ` className="${cls}"` : ''}/>`;
});
html = html.replace(/<svg viewbox="0 0 32 32"[\s\S]*?<\/svg>/g, '<LogoMark/>');
html = html.replace(/<head>[\s\S]*?<\/head>/, '');
if (flags.includes('--body')) {
  const m = html.match(/<main\b[^>]*>([\s\S]*)<\/main>/);
  if (m) html = m[0];
}
process.stdout.write(html);
