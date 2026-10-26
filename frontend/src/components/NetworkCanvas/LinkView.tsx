import type { Health, Impairment, LinkMetric, TopoLink } from '../../api/types'
import { COLORS, HEALTH_DASH } from '../../domain/colors'
import { midpoint, type Pt } from '../../domain/layout'

interface RoadProps {
  link: TopoLink
  a: Pt
  b: Pt
  health: Health
  selected: boolean
  fresh?: boolean
  flash?: boolean
  onSelect: () => void
}

interface LabelProps {
  link: TopoLink
  a: Pt
  b: Pt
  health: Health
  reason: string | null
  metric?: LinkMetric
  impairment?: Impairment
  /** A fault was injected here but the system has not confirmed it yet. */
  unconfirmedFault: boolean
  dropped: number | null
}

const ROAD: Record<Health, string> = { healthy: '#e5e7eb', degraded: '#fde68a', down: '#fecaca' }

function Pill({ x, y, text, fill, stroke, color, width }: {
  x: number; y: number; text: string; fill: string; stroke: string; color: string; width: number
}) {
  return (
    <g pointerEvents="none">
      <rect x={x - width / 2} y={y - 12} width={width} height={24} rx={12} fill={fill} stroke={stroke} strokeWidth={1.5} />
      <text x={x} y={y + 6} textAnchor="middle" fontSize={16} fontWeight={700} fill={color}>{text}</text>
    </g>
  )
}

function geometry(a: Pt, b: Pt) {
  const mid = midpoint(a, b)
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { mid, nx: -dy / len, ny: dx / len }
}

/** The link itself: a road tinted by detected health. Drawn under the flow lanes. */
export function LinkRoad({ link, a, b, health, selected, fresh, flash, onSelect }: RoadProps) {
  const label = `Link ${link.id} between ${link.a} and ${link.b}, ${health}`
  return (
    <g role="button" tabIndex={0} aria-label={label} data-link-id={link.id}
      className={`cursor-pointer outline-none ${fresh ? 'pop-in' : ''} ${flash ? 'flash' : ''}`}
      onClick={onSelect} onKeyDown={(e) => { if (e.key === 'Enter') onSelect() }}>
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={30} />
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={ROAD[health]} strokeWidth={15} strokeLinecap="round" />
      {selected && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#38bdf8" strokeWidth={21}
        strokeLinecap="round" opacity={0.45} />}
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={COLORS[health]} strokeWidth={2.5}
        strokeDasharray={HEALTH_DASH[health]} strokeLinecap="round" />
    </g>
  )
}

/** Latency and fault labels. Drawn above the lanes so they are always readable. */
export function LinkLabels({ link, a, b, health, reason, metric, impairment, unconfirmedFault, dropped }: LabelProps) {
  const { mid, nx, ny } = geometry(a, b)
  const badge = { x: mid.x + nx * 30, y: mid.y + ny * 30 }
  const loss = Math.round(metric?.loss_pct ?? impairment?.loss_pct ?? 0)
  const busy = Math.round(metric?.util_pct ?? impairment?.util_pct ?? 0)
  const why = reason === 'congestion' ? `${busy}% busy` : reason === 'latency' ? 'slow' : `${loss}% loss`
  return (
    <g pointerEvents="none">
      <Pill x={mid.x} y={mid.y} text={`${link.latency} ms`} fill="white" stroke="#9ca3af" color="#111827" width={60} />
      {health === 'down' && (
        <Pill x={badge.x} y={badge.y} text="✕ DOWN" fill="#fef2f2" stroke={COLORS.down} color={COLORS.down} width={92} />
      )}
      {health === 'degraded' && (
        <Pill x={badge.x} y={badge.y} text={`▲ ${why}`} fill="#fffbeb" stroke={COLORS.degraded}
          color={COLORS.degraded} width={118} />
      )}
      {health === 'healthy' && unconfirmedFault && (
        <Pill x={badge.x} y={badge.y} text="⚡ fault" fill="#fef2f2" stroke={COLORS.down} color={COLORS.down} width={96} />
      )}
      {dropped !== null && dropped > 0 && (
        <Pill x={mid.x - nx * 30} y={mid.y - ny * 30} text={`−${dropped} pkts`} fill="#fef2f2"
          stroke={COLORS.down} color={COLORS.down} width={110} />
      )}
    </g>
  )
}
