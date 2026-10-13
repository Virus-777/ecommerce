import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api';
import { SCREENS, type Screen, type ScreenId } from './catalogue';
import { CURRENT_APP } from './apps';
import { sampleHref, sampleKey, useDesignSamples, type DesignCheckOptions, type DesignCheckSessions, type DesignSample, type DesignSamplesFile, type SampleSession } from './designSamples';

// /design/check (dev only): renders every screen view in an iframe and compares it with the
// design export file (served from /.design/ by the dev server). Reports a class-token
// similarity score, classes missing/extra, the h1 count, horizontal overflow and console errors.
//
// Each view is opened on the live record its design state needs: web-shared/.seed/design-samples.json (written by
// `npm run seed -- --only design`) gives the params, query and session per "<screenId>@<view>". Rows run grouped
// by session (visitor first, then customer) through the app's `useSessions` hook; apps without one (Seller Center,
// Admin Center for now) keep their current session. The check ends signed in as the samples' customer.

interface Row {
  key: string;
  screen: Screen;
  view: string;
  url: string;
  design: string;
  session?: SampleSession;
  before?: DesignSample['before'];
  /** False when the samples file has no entry for this view (the catalogue example is used). */
  sampled: boolean;
  note?: string;
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

// The design export (npm run design:extract), served by the dev server through /@fs/.
const DESIGN_ROOT = `/@fs/${__DESIGN_DIR__.replace(/^\/+/, '')}/marketly-ui-final/pages`;
const IGNORE = /^(lucide|lucide-.*|is-active|is-copied|is-scrollable|at-start|at-end|ic-sm)$/;
/** Still loading: the route fallback, skeletons, busy regions */
const LOADING = '.route-loading, .sk, .sk-line, .sk-lines, .sk-card, .sk-row, .sk-grid, .sk-list, .sk-img, .sk-thumb, [aria-busy="true"]';
const DEFAULT_CUSTOMER ={ email: 'jordan.lee@example.com', first: 'Jordan', last: 'Lee' };
/** Groups in run order; rows without a session run last, in whatever session the groups left. */
const GROUPS: Array<SampleSession | undefined> = ['visitor', 'customer', undefined];

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

const allRows = (file: DesignSamplesFile | null): Row[] =>
  // Screens added after the design (no design file) have nothing to compare with.
  SCREENS.filter((s) => s.app === CURRENT_APP && s.file).flatMap((s) => {
    const views = s.views.length ? s.views.map((v) => v.slug) : [''];
    return views.map((v) => {
      const key = sampleKey(s.id, v);
      const sample = file?.samples[key];
      return {
        key,
        screen: s as Screen,
        view: v,
        url: sampleHref(s.id as ScreenId, v, sample),
        design: `${DESIGN_ROOT}/${s.area}/${s.file}${v ? `--${v}` : ''}.html`,
        session: sample?.session,
        before: sample?.before,
        sampled: Boolean(sample),
        note: sample?.note,
      };
    });
  });

const noSessions = (): DesignCheckSessions | undefined => undefined;

export default function DesignCheck({ useSessions }: DesignCheckOptions) {
  // A stable hook per app (passed once to createAppRouter), so the hook order never changes.
  const sessions = (useSessions ?? noSessions)();
  const { session } = useApi();
  const samples = useDesignSamples();
  const file = samples.status === 'ready' ? samples.file : null;
  const [rows, setRows] = useState<Row[]>(() => allRows(null));
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState('');
  const [width, setWidth] = useState(1440);
  const [current, setCurrent] = useState<SampleSession | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const currentRef = useRef<SampleSession | null>(null);

  // Rows follow the samples once they are read.
  useEffect(() => {
    if (samples.status !== 'loading') setRows(allRows(file));
  }, [samples.status, file]);

  /** Puts the app in a sample's session; the token call makes the session (and its refresh cookie) exist before an iframe resumes it. */
  const switchTo = async (s: SampleSession) => {
    if (!sessions) return;
    if (s === 'visitor') await sessions.visitor();
    else await sessions.customer(file?.customer ?? DEFAULT_CUSTOMER);
    await session.token();
    currentRef.current = s;
    setCurrent(s);
  };

  /** The sample's set-up requests, in the current session (e.g. a visitor's cart, a guest order look-up). */
  const runBefore = async (r: Row): Promise<string[]> => {
    const problems: string[] = [];
    for (const b of r.before ?? []) {
      const token = await session.token();
      const res = await fetch(b.path, {
        method: b.method,
        headers: { Authorization: `Bearer ${token}`, 'X-Client': 'web', ...(b.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: b.body !== undefined ? JSON.stringify(b.body) : undefined,
      });
      if (!res.ok) problems.push(`set-up ${b.method} ${b.path} → ${res.status}`);
    }
    return problems;
  };

  const checkOne = async (r: Row): Promise<Row> => {
    const setup = await runBefore(r);
    const html = await fetch(r.design).then((x) => (x.ok ? x.text() : ''));
    const designDoc = new DOMParser().parseFromString(html, 'text/html');
    const f = frame.current!;
    const errors: string[] = [...setup];
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
    // Wait for the lazy page chunk, its data (no skeletons left) and a DOM that stopped changing. Pages show their
    // h1 with skeletons at once; in a hidden tab the app's timers are throttled, so data can take a few seconds.
    let last = '';
    let stable = 0;
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      const d = f.contentDocument;
      const ready = !!d?.querySelector('h1') && !d.querySelector(LOADING);
      const sig = d ? `${d.querySelectorAll('*').length}:${d.body?.textContent?.length ?? 0}` : '';
      stable = ready && sig === last ? stable + 1 : 0;
      last = sig;
      if (stable >= 3) break;
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
    let switched = false;
    // a full run always starts each group with a fresh session; single rows reuse the current one
    if (!only) currentRef.current = null;
    try {
      for (const group of GROUPS) {
        const part = list.filter((r) => (sessions ? r.session : undefined) === group);
        if (!part.length) continue;
        if (group && sessions && currentRef.current !== group) {
          await switchTo(group);
          switched = true;
        }
        for (const r of part) {
          const res = await checkOne(r).catch((e) => ({ ...r, errors: [String(e)] }));
          setRows((prev) => prev.map((p) => (p.key === r.key ? res : p)));
        }
      }
    } finally {
      // The store's everyday dev session is the samples' customer: end there.
      if (switched && currentRef.current !== 'customer') await switchTo('customer').catch(() => undefined);
      setRunning(false);
    }
  };

  const shown = rows.filter((r) => !filter || r.key.includes(filter));
  const done = shown.filter((r) => r.score !== undefined);
  const avg = done.length ? done.reduce((a, r) => a + (r.score ?? 0), 0) / done.length : 0;
  const unsampled = shown.filter((r) => !r.sampled).length;
  const samplesLine =
    samples.status === 'loading'
      ? 'Reading the design samples…'
      : samples.status === 'missing'
        ? `Catalogue examples only: ${samples.reason}.`
        : [
            `Samples from ${samples.file.generatedAt ? new Date(samples.file.generatedAt).toLocaleString() : 'the seed'}`,
            unsampled ? `${unsampled} view${unsampled === 1 ? '' : 's'} without a sample` : '',
            sessions ? `sessions: visitor, then ${file?.customer?.first ?? DEFAULT_CUSTOMER.first}` : 'this app keeps its current session',
            current ? `now: ${current}` : '',
          ]
            .filter(Boolean)
            .join(' · ');

  return (
    <main className="container page stack gap-4" id="main">
      <div className="row between wrap gap-3">
        <div className="stack gap-1">
          <h1 className="h1">Design check</h1>
          <p className="small sub">
            {done.length}/{shown.length} checked · average class similarity {(avg * 100).toFixed(1)}% · <Link to="/design">All screens</Link>
          </p>
          <p className="xs muted" id="design-check-samples">
            {samplesLine}
          </p>
        </div>
        <div className="row gap-2">
          <select className="select" aria-label="Viewport width" value={width} onChange={(e) => setWidth(Number(e.target.value))}>
            <option value={1440}>Desktop 1440</option>
            <option value={834}>Tablet 834</option>
            <option value={390}>Phone 390</option>
          </select>
          <input className="input" placeholder="Filter (e.g. admin/)" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter screens" />
          <button type="button" className="btn btn-primary" disabled={running || samples.status === 'loading'} onClick={() => run()}>
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
              <tr key={r.key} data-key={r.key}>
                <td className="nowrap">
                  <Link to={r.url}>{r.key}</Link> · <a href={r.design} target="_blank" rel="noreferrer">design</a>
                  {r.session && <span className="xs muted"> · {r.session}</span>}
                  {!r.sampled && samples.status === 'ready' && <span className="xs muted"> · no sample (catalogue example)</span>}
                  {r.note && <span className="xs muted"> · {r.note}</span>}
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
