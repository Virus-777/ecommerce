import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { SCREENS, type Screen } from './catalogue';
import { href } from './href';

// /design/check (dev only): renders every screen view in an iframe and compares it with the
// design export file (served from /.design/ by the dev server). Reports a class-token
// similarity score, classes missing/extra, the h1 count, horizontal overflow and console errors.

interface Row {
  key: string;
  screen: Screen;
  view: string;
  url: string;
  design: string;
  score?: number;
  missing?: string[];
  extra?: string[];
  h1?: number;
  overflow?: boolean;
  errors?: string[];
  stub?: boolean;
}

// Background tabs throttle setTimeout to ~1/min; MessageChannel callbacks are not throttled.
function sleep(ms: number) {
  const end = performance.now() + ms;
  return new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => (performance.now() >= end ? resolve() : ch.port2.postMessage(0));
    ch.port2.postMessage(0);
  });
}

const DESIGN_ROOT = '/.design/marketly-ui-final/pages';
const IGNORE = /^(lucide|lucide-.*|is-active|is-copied|is-scrollable|at-start|at-end|ic-sm)$/;

function tokens(root: ParentNode): Map<string, number> {
  const m = new Map<string, number>();
  const scopes = [root.querySelector('main'), ...Array.from(root.querySelectorAll('.overlay'))].filter(Boolean) as Element[];
  for (const s of scopes) {
    for (const el of [s, ...Array.from(s.querySelectorAll('*'))]) {
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
      for (const c of Array.from(el.classList)) if (!IGNORE.test(c)) m.set(c, (m.get(c) ?? 0) + 1);
    }
  }
  return m;
}

function compare(a: Map<string, number>, b: Map<string, number>) {
  let inter = 0;
  let union = 0;
  const missing: string[] = [];
  const extra: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    inter += Math.min(x, y);
    union += Math.max(x, y);
    if (x && !y) missing.push(k);
    if (y && !x) extra.push(k);
  }
  return { score: union ? inter / union : 1, missing, extra };
}

const allRows = (): Row[] =>
  SCREENS.flatMap((s) => {
    const views = s.views.length ? s.views.map((v) => v.slug) : [''];
    return views.map((v) => ({
      key: `${s.id}@${v}`,
      screen: s as Screen,
      view: v,
      url: href(s.id, v),
      design: `${DESIGN_ROOT}/${s.area}/${s.file}${v ? `--${v}` : ''}.html`,
    }));
  });

export default function DesignCheck() {
  const [rows, setRows] = useState<Row[]>(allRows);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState('');
  const [width, setWidth] = useState(1440);
  const frame = useRef<HTMLIFrameElement>(null);

  const checkOne = async (r: Row): Promise<Row> => {
    const html = await fetch(r.design).then((x) => (x.ok ? x.text() : ''));
    const designDoc = new DOMParser().parseFromString(html, 'text/html');
    const f = frame.current!;
    const errors: string[] = [];
    await new Promise<void>((resolve) => {
      f.onload = () => resolve();
      f.src = r.url;
    });
    const win = f.contentWindow as (Window & typeof globalThis) | null;
    if (win) {
      const orig = win.console.error;
      win.console.error = (...a: unknown[]) => {
        errors.push(a.map(String).join(' ').slice(0, 200));
        orig.apply(win.console, a);
      };
      win.addEventListener('error', (e) => errors.push(String(e.message)));
    }
    // Wait for the lazy page chunk and effects.
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      const d = f.contentDocument;
      if (d?.querySelector('h1') && !d.querySelector('.route-loading')) break;
    }
    await sleep(250);
    const doc = f.contentDocument!;
    const stub = !!doc.body.textContent?.includes('Not built yet');
    const cmp = compare(tokens(designDoc), tokens(doc));
    const el = doc.documentElement;
    return { ...r, ...cmp, stub, h1: doc.querySelectorAll('h1').length, overflow: el.scrollWidth > el.clientWidth + 1, errors };
  };

  const run = async (only?: Row[]) => {
    setRunning(true);
    const list = only ?? rows.filter((r) => !filter || r.key.includes(filter));
    for (const r of list) {
      const res = await checkOne(r).catch((e) => ({ ...r, errors: [String(e)] }));
      setRows((prev) => prev.map((p) => (p.key === r.key ? res : p)));
    }
    setRunning(false);
  };

  const shown = rows.filter((r) => !filter || r.key.includes(filter));
  const done = shown.filter((r) => r.score !== undefined);
  const avg = done.length ? done.reduce((a, r) => a + (r.score ?? 0), 0) / done.length : 0;

  return (
    <main className="container page stack gap-4" id="main">
      <div className="row between wrap gap-3">
        <div className="stack gap-1">
          <h1 className="h1">Design check</h1>
          <p className="small sub">
            {done.length}/{shown.length} checked · average class similarity {(avg * 100).toFixed(1)}% · <Link to="/design">All screens</Link>
          </p>
        </div>
        <div className="row gap-2">
          <select className="select" aria-label="Viewport width" value={width} onChange={(e) => setWidth(Number(e.target.value))}>
            <option value={1440}>Desktop 1440</option>
            <option value={834}>Tablet 834</option>
            <option value={390}>Phone 390</option>
          </select>
          <input className="input" placeholder="Filter (e.g. admin/)" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter screens" />
          <button type="button" className="btn btn-primary" disabled={running} onClick={() => run()}>
            <span>{running ? 'Checking…' : 'Run check'}</span>
          </button>
        </div>
      </div>
      <iframe ref={frame} title="Screen under test" style={{ width, height: 900, border: '1px solid var(--border)', transform: 'scale(.25)', transformOrigin: '0 0', marginBottom: -660 }} />
      <div className="table-wrap">
        <table className="table" id="design-check-results">
          <thead>
            <tr>
              <th>Screen · view</th>
              <th className="r">Similarity</th>
              <th className="r">h1</th>
              <th>Overflow</th>
              <th>Errors</th>
              <th>Missing classes (design only)</th>
              <th>Extra classes (React only)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key}>
                <td className="nowrap">
                  <Link to={r.url}>{r.key}</Link> · <a href={r.design} target="_blank" rel="noreferrer">design</a>
                </td>
                <td className="r num">{r.stub ? 'stub' : r.score === undefined ? '' : `${(r.score * 100).toFixed(0)}%`}</td>
                <td className="r">{r.h1}</td>
                <td>{r.overflow ? 'yes' : ''}</td>
                <td className="xs">{r.errors?.length ? r.errors.join(' | ') : ''}</td>
                <td className="xs">{r.missing?.slice(0, 25).join(' ')}</td>
                <td className="xs">{r.extra?.slice(0, 25).join(' ')}</td>
                <td>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={running} onClick={() => run([r])}>
                    <span>Check</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
