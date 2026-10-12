import type { Flow } from '../api/types'
import { flowStatus, STATUS_ICON, STATUS_WORD, type FlowStatus } from '../domain/flowStatus'
import { pathText } from '../domain/narration'
import { useDisplayed, ring } from '../hooks'
import { useSimStore } from '../store/useSimStore'
import { Tip } from './Tip'

const BADGE: Record<FlowStatus, string> = {
  delivering: 'bg-ok text-white',
  degraded: 'bg-warn text-white',
  broken: 'bg-bad text-white',
  recovering: 'bg-heal text-white',
}
const BORDER: Record<FlowStatus, string> = {
  delivering: 'border-line', degraded: 'border-warn', broken: 'border-bad', recovering: 'border-heal',
}

const META: Record<Flow, { title: string; sub: string; swatch: string }> = {
  static: { title: 'Static routing', sub: 'never changes route', swatch: 'border-t-4 border-dashed border-stat' },
  healing: { title: 'Self-healing', sub: 'detects and reroutes', swatch: 'border-t-4 border-solid border-heal' },
}

const fmt = (v: number | null | undefined, d = 0): string => (v === null || v === undefined ? '–' : v.toFixed(d))

export function FlowCard({ flow }: { flow: Flow }) {
  const snap = useDisplayed()
  const spot = useSimStore((s) => s.spotlight)
  if (!snap) return null
  const k = snap.kpis[flow]
  const status = flowStatus(flow, snap)
  const path = flow === 'static' ? snap.static_path : snap.healing_path
  const m = META[flow]
  const lastRecovery = flow === 'healing' ? k.last_recovery_ticks : null
  return (
    <section aria-label={`${m.title} flow`}
      className={`rounded-lg border-2 bg-panel px-2 py-1 ${BORDER[status]} ${ring(spot === 'cards')}`}>
      <div className="flex items-center gap-2">
        <span aria-hidden className={`inline-block w-8 ${m.swatch}`} />
        <h2 className="text-base font-bold">{m.title}: <span className="font-normal text-mute">{m.sub}</span></h2>
        <span className={`ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-sm font-bold ${BADGE[status]}`}>
          <span aria-hidden className={status === 'recovering' ? 'inline-block animate-spin' : ''}>
            {STATUS_ICON[status]}
          </span>
          {STATUS_WORD[status]}
        </span>
      </div>
      <p className="truncate font-mono text-sm" title={path ? pathText(path.nodes) : 'no path'}>
        {path ? pathText(path.nodes) : 'No path'}
        {lastRecovery !== null && lastRecovery !== undefined && (
          <span className="ml-2 font-sans text-mute">· last recovery {lastRecovery} ticks</span>
        )}
      </p>
      <dl className="grid grid-cols-4 gap-1 text-center">
        <Stat label={<Tip term="delivery">Delivered</Tip>} value={`${fmt(k.delivery_pct)}%`} />
        <Stat label={<Tip term="delay">Delay</Tip>} value={k.delay_ms === null ? '–' : `${fmt(k.delay_ms)} ms`} />
        <Stat label="Packets lost" value={String(k.lost_packets)} />
        <Stat label={<Tip term="availability">Availability</Tip>} value={`${fmt(k.availability_pct, 1)}%`} />
      </dl>
    </section>
  )
}

function Stat({ label, value }: { label: React.ReactNode; value: string }) {
  return (
    <div>
      <dt className="text-sm text-mute">{label}</dt>
      <dd className="text-base font-bold leading-tight">{value}</dd>
    </div>
  )
}
