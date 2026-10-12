import type { Flow, Snapshot } from '../api/types'
import { currentTick } from './phase'

export type FlowStatus = 'delivering' | 'degraded' | 'broken' | 'recovering'

export const STATUS_WORD: Record<FlowStatus, string> = {
  delivering: 'Delivering', degraded: 'Degraded', broken: 'BROKEN', recovering: 'Recovering',
}
export const STATUS_ICON: Record<FlowStatus, string> = {
  delivering: '✓', degraded: '▲', broken: '✕', recovering: '↻',
}

/** Status of one flow on this tick. Self-healing shows "Recovering" for the 2 ticks after a reroute. */
export function flowStatus(flow: Flow, s: Snapshot): FlowStatus {
  const k = s.kpis[flow]
  const delivery = k.delivery_pct ?? 100
  if (flow === 'healing') {
    const cur = currentTick(s)
    const last = [...s.route_changes].reverse().find((c) => c.kind !== 'failback')
    if (last && cur - last.tick <= 1 && s.tick > 0) return 'recovering'
  }
  if (delivery <= 0) return 'broken'
  if (k.available === false) return 'degraded'
  return 'delivering'
}
