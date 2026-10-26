import type { Snapshot, Topology } from '../api/types'
import type { Phase, PhaseId } from './phase'

export type Tone = 'ok' | 'warn' | 'bad' | 'info'
export interface Narration { chip: string; sentence: string; tone: Tone }

export const pathText = (nodes: string[]): string => nodes.join(' > ')

const CHIPS: Record<PhaseId, [string, Tone]> = {
  healthy: ['Normal', 'ok'],
  fault_undetected: ['Fault injected', 'bad'],
  rerouted: ['Rerouted', 'info'],
  off_path_fault: ['Fault, no impact', 'warn'],
  recovering: ['Link restored', 'info'],
  holddown: ['Waiting', 'warn'],
  failback_done: ['Failed back', 'ok'],
  no_path: ['No path', 'bad'],
  no_alternative: ['No alternative', 'warn'],
  topology_changed: ['Topology edit', 'info'],
}

/** "L8 (R5-R7)" when topology is known, otherwise the bare id. */
export function nameOf(id: string | null, topo?: Topology | null): string {
  if (!id) return 'The network'
  const l = topo?.links.find((x) => x.id === id)
  if (l) return `${l.id} (${l.a}-${l.b})`
  return topo?.nodes.some((n) => n.id === id) ? `Router ${id}` : id
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

function undetected(p: Phase, name: string): string {
  const op = p.fault?.op
  const [what, checks] = op === 'degrade_link' ? [`${name} started dropping packets`, 'bad checks']
    : op === 'congest_link' ? [`${name} became overloaded`, 'bad checks']
    : [`${name} just failed`, 'failed checks']
  const seen = p.count === 0 ? 'has not run a check on it yet' : `has seen ${p.count} of ${p.needed} ${checks}`
  return `${what}. The system does not know yet: it ${seen}.`
}

function rerouted(p: Phase, s: Snapshot, name: string): string {
  const to = p.route ? pathText(p.route.to.split('-')) : ''
  const cost = p.route ? ` (cost ${p.route.cost})` : ''
  const what = p.fault?.op === 'fail_node' ? `${name} was confirmed dead at t=${p.detectedTick}`
    : p.fault?.op === 'degrade_link' || p.fault?.op === 'congest_link'
      ? `${name} was confirmed degraded at t=${p.detectedTick}`
      : `${name} was confirmed down at t=${p.detectedTick}`
  const tail = s.kpis.static.available === false
    ? ' Static routing is still sending into the broken link.' : ' Static routing keeps its original route.'
  return `${what}. Self-healing moved traffic to ${to}${cost}.${tail}`
}

/** Turn a phase into the chip and one plain sentence. Templates only, no AI. */
export function narrate(p: Phase, s: Snapshot, topo?: Topology | null): Narration {
  const [chip, tone] = CHIPS[p.id]
  const name = nameOf(p.target, topo)
  const pref = pathText(s.baseline_path.nodes)
  let sentence: string
  switch (p.id) {
    case 'healthy':
      sentence = `All links are healthy. Both flows use ${pathText(s.healing_path?.nodes ?? s.static_path.nodes)}.`
      break
    case 'topology_changed': sentence = p.message; break
    case 'fault_undetected': sentence = undetected(p, name); break
    case 'rerouted': sentence = rerouted(p, s, name); break
    case 'off_path_fault':
      sentence = `${name} is down, but neither flow uses it, so no reroute is needed.`
      break
    case 'no_alternative':
      sentence = `${name} is unhealthy and no better path exists, so self-healing keeps using it.`
      break
    case 'recovering':
      sentence = `${name} is back. The system waits for ${p.needed} clean checks before trusting it ` +
        `(${p.count} of ${p.needed}).`
      break
    case 'holddown':
      sentence = `${p.target ? `${name} is trusted again` : 'The preferred path is healthy again'}. ` +
        `Waiting ${plural(p.remaining, 'more tick')} so the route does not flip back and forth.`
      break
    case 'failback_done':
      sentence = `Traffic is back on the preferred shortest path ${pref}.`
      break
    case 'no_path':
      sentence = 'No working path exists right now. Self-healing will recover as soon as one appears.'
      break
  }
  return { chip, sentence, tone }
}
