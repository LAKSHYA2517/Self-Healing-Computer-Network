import type { Pt } from '../../domain/layout'
import { COLORS } from '../../domain/colors'

interface Props {
  id: string
  at: Pt
  role: 'source' | 'destination' | null
  dead: boolean
  unconfirmedFault: boolean
  selected: boolean
  fresh?: boolean
  flash?: boolean
  /** Dimmed: not a valid target for the link being drawn. */
  dim?: boolean
  /** Highlighted: a valid target for the link being drawn. */
  target?: boolean
  onDown: () => void
  /** Receives the raw event (used to start a drag from the pointer position). */
  onPointerDownRaw?: (e: React.PointerEvent) => void
  onUp: () => void
}

export const NODE_R = 28

/** A router: big id inside, "Source" or "Destination" below, red cross when detected dead. */
export function NodeView({ id, at, role, dead, unconfirmedFault, selected, fresh, flash, dim, target, onDown, onPointerDownRaw, onUp }: Props) {
  const stroke = dead || unconfirmedFault ? COLORS.down : '#374151'
  return (
    <g role="button" tabIndex={0} aria-label={`Router ${id}${dead ? ', down' : ''}`} data-node-id={id}
      className={`cursor-pointer outline-none ${fresh ? 'pop-in' : ''} ${flash ? 'flash' : ''}`}
      opacity={dim ? 0.3 : 1} onPointerDown={(e) => { e.stopPropagation(); if (onPointerDownRaw) onPointerDownRaw(e); else onDown() }} onPointerUp={onUp}
      onKeyDown={(e) => { if (e.key === 'Enter') { onDown(); onUp() } }}>
      {target && <circle cx={at.x} cy={at.y} r={NODE_R + 8} fill="none" stroke="#22c55e" strokeWidth={4}
        strokeDasharray="6 4" />}
      {selected && <circle cx={at.x} cy={at.y} r={NODE_R + 7} fill="none" stroke="#38bdf8" strokeWidth={5} opacity={0.6} />}
      <circle cx={at.x} cy={at.y} r={NODE_R} fill={dead ? '#fecaca' : role ? '#dbeafe' : 'white'}
        stroke={stroke} strokeWidth={dead ? 4 : 3} strokeDasharray={unconfirmedFault && !dead ? '6 4' : undefined} />
      <text x={at.x} y={at.y + 7} textAnchor="middle" fontSize={21} fontWeight={800} fill="#111827">{id}</text>
      {dead && (
        <g stroke={COLORS.down} strokeWidth={5} strokeLinecap="round" pointerEvents="none">
          <line x1={at.x - 17} y1={at.y - 17} x2={at.x + 17} y2={at.y + 17} />
          <line x1={at.x + 17} y1={at.y - 17} x2={at.x - 17} y2={at.y + 17} />
        </g>
      )}
      {role && (
        <text x={at.x} y={at.y + NODE_R + 22} textAnchor="middle" fontSize={18} fontWeight={600} fill="#374151">
          {role === 'source' ? 'Source' : 'Destination'}
        </text>
      )}
      {dead && (
        <text x={at.x} y={at.y - NODE_R - 10} textAnchor="middle" fontSize={17} fontWeight={800} fill={COLORS.down}>
          ✕ DOWN
        </text>
      )}
    </g>
  )
}
