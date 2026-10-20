import { chartColor } from './model';

// A single 100% bar split into parts (Official Store vs marketplace sellers), with a key that states each part's
// share and amount, so the numbers never depend on colour. Replaces the old SplitBar. Parts take the series
// slots in order (Official Store is --chart-1 everywhere).

export interface SharePart {
  key: string;
  label: string;
  /** Share of the whole, 0–100. */
  pct: number;
  /** Optional amount text, e.g. "$140.2k". */
  value?: string;
}

export function ShareBar({ parts, label }: { parts: SharePart[]; label: string }) {
  const text = parts.map((p) => `${p.label} ${Math.round(p.pct)}%${p.value ? `, ${p.value}` : ''}`).join('; ');
  return (
    <div className="chart-share">
      <div className="chart-share-bar" role="img" aria-label={`${label}: ${text}`}>
        {parts.map((p, i) =>
          p.pct > 0 ? <i key={p.key} style={{ width: `${Math.min(100, p.pct)}%`, background: chartColor(i) }} /> : null,
        )}
      </div>
      <div className="chart-share-key xs" aria-hidden="true">
        {parts.map((p, i) => (
          <span key={p.key}>
            <i className="chart-key is-rect" style={{ ['--key' as string]: chartColor(i) }} />
            {p.label} <b>{Math.round(p.pct)}%</b>
            {p.value && <span className="muted"> · {p.value}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
