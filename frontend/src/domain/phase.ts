import type { FaultEntry, Progress, RouteChange, Snapshot } from '../api/types'

export type PhaseId =
  | 'healthy' | 'fault_undetected' | 'rerouted' | 'off_path_fault' | 'recovering'
  | 'holddown' | 'failback_done' | 'no_path' | 'no_alternative' | 'topology_changed'

export interface Phase {
  id: PhaseId
  /** Element the story is about (link or router id), when there is one. */
  target: string | null
  /** The injected fault behind it, when there is one. */
  fault: FaultEntry | null
  count: number
  needed: number
  /** Ticks left of the hold-down timer. */
  remaining: number
  detectedTick: number | null
  route: RouteChange | null
  /** The server's plain-language description of a topology edit (topology_changed phase). */
  message: string
}

/** How long a topology-edit message stays in the banner unless something newer happens. */
export const TOPOLOGY_BANNER_TICKS = 10

/** How long "Failed back" stays on screen after the failback. */
export const FAILBACK_BANNER_TICKS = 8

/** The tick the snapshot just finished processing (snapshot.tick counts completed ticks). */
export const currentTick = (s: Snapshot): number => Math.max(0, s.tick - 1)

const isOpen = (f: FaultEntry): boolean => f.restored_tick === null

function lastOpenFault(s: Snapshot): FaultEntry | null {
  const open = s.fault_log.filter(isOpen)
  return open.length ? open[open.length - 1] : null
}

/** Does the system already treat this fault's target as unhealthy? */
function isKnown(f: FaultEntry, s: Snapshot): boolean {
  if (f.op === 'fail_node') return s.dead_nodes.includes(f.target)
  return (s.link_health[f.target]?.health ?? 'healthy') !== 'healthy'
}

function affectsStatic(f: FaultEntry, s: Snapshot): boolean {
  return f.op === 'fail_node' ? s.static_path.nodes.includes(f.target) : s.static_path.links.includes(f.target)
}

/** Best "x of y" counter for a target: the link itself, or the busiest link for a router. */
function progressFor(s: Snapshot, target: string | null, want: Progress['pending'][]): Progress | null {
  const own = target ? s.detector_progress[target] : undefined
  if (own && want.includes(own.pending)) return own
  const all = Object.values(s.detector_progress).filter((p) => want.includes(p.pending))
  return all.sort((a, b) => b.count - a.count)[0] ?? null
}

function detectedTickFor(f: FaultEntry, s: Snapshot): number {
  const link = s.link_health[f.target]
  if (f.op !== 'fail_node' && link && link.health !== 'healthy') return link.since
  const hit = s.events.find((e) => e.kind === 'detect' && e.tick >= f.tick)
  return hit ? hit.tick : f.tick
}

const base: Phase = {
  id: 'healthy', target: null, fault: null, count: 0, needed: 0, remaining: 0, detectedTick: null, route: null,
  message: '',
}

/** Pure function of one snapshot: which part of the story is on screen. */
export function derivePhase(s: Snapshot): Phase {
  const cur = currentTick(s)
  const lastChange = s.route_changes[s.route_changes.length - 1] ?? null
  const lastEvent = s.events[s.events.length - 1]
  if (lastEvent?.kind === 'topology' && cur - lastEvent.tick <= TOPOLOGY_BANNER_TICKS) {
    return { ...base, id: 'topology_changed', message: lastEvent.message }
  }
  if (s.healing_path === null) return { ...base, id: 'no_path' }

  const open = lastOpenFault(s)
  if (open) {
    if (!isKnown(open, s)) {
      const p = progressFor(s, open.target, ['down', 'degraded'])
      return { ...base, id: 'fault_undetected', target: open.target, fault: open,
        count: p?.count ?? 0, needed: p?.needed ?? s.config.k_down }
    }
    const route = [...s.route_changes].reverse()
      .find((c) => c.tick >= open.tick && c.kind !== 'failback') ?? null
    const detectedTick = detectedTickFor(open, s)
    if (route) return { ...base, id: 'rerouted', target: open.target, fault: open, detectedTick, route }
    return { ...base, id: affectsStatic(open, s) ? 'no_alternative' : 'off_path_fault',
      target: open.target, fault: open, detectedTick }
  }

  const restored = [...s.fault_log].reverse().find((f) => f.restored_tick !== null) ?? null
  const unhealthy = Object.entries(s.link_health).filter(([, h]) => h.health !== 'healthy').map(([id]) => id)
  if (unhealthy.length || s.dead_nodes.length) {
    const target = restored?.target ?? unhealthy[0] ?? s.dead_nodes[0] ?? null
    const p = progressFor(s, target, ['recover'])
    return { ...base, id: 'recovering', target, fault: restored, count: p?.count ?? 0,
      needed: p?.needed ?? s.config.k_recover }
  }

  const onPreferred = s.healing_path.nodes.join() === s.baseline_path.nodes.join()
  if (!onPreferred) {
    const since = cur - (lastChange?.tick ?? 0)
    return { ...base, id: 'holddown', target: restored?.target ?? null, fault: restored,
      remaining: Math.max(1, s.config.hold_down_ticks - since) }
  }
  if (lastChange?.kind === 'failback' && cur - lastChange.tick < FAILBACK_BANNER_TICKS) {
    return { ...base, id: 'failback_done', route: lastChange }
  }
  return base
}
