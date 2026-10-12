import type { Snapshot, Topology } from '../api/types'
import { nameOf, pathText } from './narration'

export interface Milestone {
  id: string
  title: string
  reached: (s: Snapshot) => boolean
  /** Two short lines for the coach mark. */
  text: (s: Snapshot, t: Topology | null) => string
  /** Which part of the screen to point at. */
  spot: 'banner' | 'canvas' | 'cards' | 'pipeline' | 'timeline' | 'results'
}

const target = (s: Snapshot): string | null => s.fault_log[0]?.target ?? null

export const MILESTONES: Milestone[] = [
  {
    id: 'fault', title: 'A fault happens', spot: 'pipeline',
    reached: (s) => s.fault_log.length > 0,
    text: (s, t) => `${nameOf(target(s), t)} just failed. Reality changed, but the system has not noticed ` +
      'yet: look at "Reality" and "System knows" in the right panel.',
  },
  {
    id: 'detected', title: 'The system confirms it', spot: 'pipeline',
    reached: (s) => s.events.some((e) => e.kind === 'detect'),
    text: (s) => `${s.config.k_down} failed checks in a row confirm the link is down. ` +
      'The system needed that evidence, so detection is never instant.',
  },
  {
    id: 'rerouted', title: 'Traffic is rerouted', spot: 'canvas',
    reached: (s) => s.route_changes.some((c) => c.kind === 'reroute'),
    text: (s) => {
      const r = s.route_changes.find((c) => c.kind === 'reroute')
      return `Dijkstra ran on the links still working and installed ${r ? pathText(r.to.split('-')) : 'a new path'}. ` +
        'Orange packets keep dying at the broken link; blue packets go around it.'
    },
  },
  {
    id: 'restored', title: 'The link is restored', spot: 'banner',
    reached: (s) => s.fault_log.some((f) => f.restored_tick !== null),
    text: (s, t) => `${nameOf(target(s), t)} is back, but the system does not trust it at once. ` +
      `It needs ${s.config.k_recover} clean checks and a hold-down timer so a flapping link cannot make the route oscillate.`,
  },
  {
    id: 'failback', title: 'Failback', spot: 'cards',
    reached: (s) => s.route_changes.some((c) => c.kind === 'failback'),
    text: (s) => `Traffic is back on the preferred shortest path ${pathText(s.static_path.nodes)}. ` +
      'Press Space once more to finish the run and see the results.',
  },
]

export const FINISH_SPOT = 'results' as const
