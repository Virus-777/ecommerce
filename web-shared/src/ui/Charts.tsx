import type { ReactNode } from 'react';

// SVG charts drawn to scale, with hover tooltips (CSS: .chart .hov:hover .tip).
// Series colours come from the design tokens (.s1/.s2 = chart-1/chart-2: Official Store vs sellers).

function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

type Fmt = (v: number) => string;

export function LineChart({ labels, series, height = 220, width = 640, fmt = (v) => String(v), area, label = 'Line chart' }: { labels: string[]; series: Array<{ name: string; data: number[] }>; height?: number; /** Drawing width (viewBox units). Pass the container's pixel width so text keeps its size in wide cards. */ width?: number; fmt?: Fmt; area?: boolean; label?: string }) {
  const W = width, H = height, L = 40, R = 16, T = 12, B = 26;
  const all = series.flatMap((s) => s.data);
  const stepV = niceMax((Math.max(...all) * 1.05) / 4);
  const max = Math.ceil((Math.max(...all) * 1.05) / stepV) * stepV;
  const n = labels.length;
  const x = (i: number) => L + (i * (W - L - R)) / (n - 1);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += stepV) ticks.push(t);
  const every = Math.ceil(n / 7);
  const colW = (W - L - R) / (n - 1);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {ticks.map((t) => (
        <g key={t}>
          <line className="grid-line" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
          <text x={L - 8} y={y(t) + 4} textAnchor="end">{fmt(t)}</text>
        </g>
      ))}
      {labels.map((l, i) => (i % every === 0 || i === n - 1 ? <text key={l + i} x={x(i)} y={H - 6} textAnchor="middle">{l}</text> : null))}
      {series.map((s, si) => {
        const pts = s.data.map((v, i) => `${x(i)},${y(v)}`).join(' ');
        return (
          <g key={s.name}>
            {area && si === 0 && <polygon className="a1" points={`${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}`} />}
            <polyline className={`s${si + 1}`} points={pts} />
            <circle className={`end${si + 1}`} cx={x(n - 1)} cy={y(s.data[n - 1])} r="4.5" />
          </g>
        );
      })}
      {labels.map((l, i) => {
        const tipW = 150;
        const tx = Math.min(Math.max(x(i) - tipW / 2, L), W - R - tipW);
        const lines = series.map((s) => `${s.name}: ${fmt(s.data[i])}`);
        return (
          <g className="hov" key={`h${i}`}>
            <rect className="hit" x={x(i) - colW / 2} y={T} width={colW} height={H - T - B} />
            <g className="tip">
              <line x1={x(i)} x2={x(i)} y1={T} y2={H - B} stroke="var(--border-strong)" />
              <rect x={tx} y={T} width={tipW} height={18 + lines.length * 16} rx="6" />
              <text x={tx + 10} y={T + 16}>{l}</text>
              {lines.map((t, k) => (
                <text key={k} x={tx + 10} y={T + 32 + k * 16}>{t}</text>
              ))}
            </g>
          </g>
        );
      })}
    </svg>
  );
}

export function BarChart({ labels, data, height = 200, width = 640, fmt = (v) => String(v), s2, label = 'Bar chart' }: { labels: string[]; data: number[]; height?: number; /** Drawing width (viewBox units); see LineChart. */ width?: number; fmt?: Fmt; s2?: boolean; label?: string }) {
  const W = width, H = height, L = 40, R = 8, T = 12, B = 26;
  const n = labels.length;
  const max = niceMax(Math.max(...data) * 1.05);
  const step = (W - L - R) / n;
  const bw = step * 0.62;
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line className="grid-line" x1={L} x2={W - R} y1={y(max * t)} y2={y(max * t)} />
          <text x={L - 8} y={y(max * t) + 4} textAnchor="end">{fmt(max * t)}</text>
        </g>
      ))}
      {data.map((v, i) => {
        const cx = L + step * i + step / 2;
        const top = y(v);
        const h = y(0) - top;
        const r = Math.min(4, h);
        const d = `M${cx - bw / 2},${y(0)} V${top + r} q0,-${r} ${r},-${r} H${cx + bw / 2 - r} q${r},0 ${r},${r} V${y(0)} Z`;
        return (
          <g className="hov" key={i}>
            <path className={`${s2 ? 'b2' : 'b1'} bar-hl`} d={d} />
            <rect className="hit" x={cx - step / 2} y={T} width={step} height={H - T - B} />
            <text x={cx} y={H - 6} textAnchor="middle">{labels[i]}</text>
            <g className="tip">
              <rect x={cx - 40} y={Math.max(top - 30, 0)} width="80" height="22" rx="6" />
              <text x={cx} y={Math.max(top - 30, 0) + 15} textAnchor="middle">{fmt(v)}</text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

export function Sparkline({ data, series = 1 }: { data: number[]; series?: 1 | 2 }) {
  const W = 120, H = 32;
  const max = Math.max(...data), min = Math.min(...data);
  const x = (i: number) => (i * W) / (data.length - 1);
  const y = (v: number) => 3 + (H - 6) * (1 - (v - min) / (max - min || 1));
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} style={{ width: W, height: H }} aria-hidden="true">
      <polyline className={`s${series}`} points={data.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
      <circle className={`end${series}`} cx={x(data.length - 1)} cy={y(data[data.length - 1])} r="3" />
    </svg>
  );
}

export function Legend({ items }: { items: ReactNode[] }) {
  return (
    <div className="legend">
      {items.map((t, i) => (
        <span key={i}>
          <i className={`l${i + 1}`} />
          {t}
        </span>
      ))}
    </div>
  );
}

/** Two-part share bar (Official Store vs sellers). */
export function SplitBar({ a, b }: { a: number; b: number }) {
  return (
    <div className="splitbar" role="img" aria-label={`${a}% and ${b}%`}>
      <i className="l1" style={{ width: `${a}%` }} />
      <i className="l2" style={{ width: `${b}%` }} />
    </div>
  );
}
