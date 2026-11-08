/** Minimal SVG area chart. Values are plotted as given; nothing is smoothed or interpolated. */
export function Sparkline(props: { values: (number | null)[]; max?: number; color?: string; height?: number; label?: string }) {
  const { values, height = 44, color = 'var(--color-secondary)' } = props
  const w = 200
  const present = values.filter((v): v is number => v !== null)
  const max = props.max ?? Math.max(1, ...present) * 1.1
  const n = Math.max(values.length, 2)
  const pts: string[] = []
  values.forEach((v, i) => {
    if (v === null) return
    const x = (i / (n - 1)) * w
    const y = height - (Math.min(v, max) / max) * (height - 2) - 1
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  const line = pts.join(' ')
  const area = pts.length ? `0,${height} ${line} ${pts[pts.length - 1].split(',')[0]},${height}` : ''
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }} role="img" aria-label={props.label}>
      {[0.25, 0.5, 0.75].map(f => (
        <line key={f} x1="0" x2={w} y1={height * f} y2={height * f} stroke="var(--color-line)" strokeWidth="0.5" />
      ))}
      {area && <polygon points={area} fill={color} opacity="0.12" />}
      {line && <polyline points={line} fill="none" stroke={color} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />}
    </svg>
  )
}

/** Horizontal bar with a label and value text. */
export function Bar(props: { label: string; value: number; max: number; text: string; color?: string }) {
  const pct = props.max > 0 ? Math.min(100, (props.value / props.max) * 100) : 0
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[11px]">
      <div className="flex justify-between gap-2">
        <span className="truncate text-muted">{props.label}</span>
        <span className="shrink-0 text-text">{props.text}</span>
      </div>
      <div className="h-1.5 bg-line">
        <div className={`h-full transition-[width] duration-500 ${props.color ?? 'bg-secondary'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
