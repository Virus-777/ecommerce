// The category tick of horizontal bars: the name shortened to fit its column (axes.labelColumn), the whole name on
// hover (<title>). A plain <text> rather than Recharts' own tick, which wraps long names onto two lines.

interface TickProps {
  x?: number | string;
  y?: number | string;
  payload?: { value?: unknown };
}

/** A Recharts `tick` render function: <YAxis tick={labelTick(column.fit)} />. */
export function labelTick(fit: (s: string) => string) {
  return ({ x, y, payload }: TickProps) => {
    const name = String(payload?.value ?? '');
    return (
      <text x={x} y={y} dy="0.355em" textAnchor="end" fill="var(--chart-axis)" fontSize={11}>
        <title>{name}</title>
        {fit(name)}
      </text>
    );
  };
}
