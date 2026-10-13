// Concise progress log: one line per step and per created record, warnings collected for the summary.
const t0 = Date.now();
const stamp = () => {
  const s = Math.round((Date.now() - t0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export const log = {
  warnings: [],
  counts: {},
  step(name, note = '') {
    console.log(`\n[${stamp()}] ▸ ${name}${note ? ` (${note})` : ''}`);
  },
  info(msg) {
    console.log(`[${stamp()}]   ${msg}`);
  },
  created(kind, label) {
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    console.log(`[${stamp()}]   + ${kind}: ${label}`);
  },
  reused(kind, label) {
    console.log(`[${stamp()}]   = ${kind}: ${label}`);
  },
  warn(msg) {
    this.warnings.push(msg);
    console.log(`[${stamp()}]   ! ${msg}`);
  },
  elapsed() {
    return stamp();
  },
};
