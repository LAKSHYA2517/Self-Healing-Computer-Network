import type { Snapshot, TopoLink, Topology } from '../api/types'

/** Prefilled latency for a new link: distance / 25 ms, at least 1. Mirrors topology.default_latency (tested). */
export function defaultLatency(a: [number, number], b: [number, number]): number {
  const d = Math.hypot(a[0] - b[0], a[1] - b[1])
  return Math.max(1, Math.floor(d / 25 + 0.5))
}

export const linkBetween = (t: Topology, a: string, b: string): TopoLink | undefined =>
  t.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))

export const incidentLinks = (t: Topology, id: string): TopoLink[] => t.links.filter((l) => l.a === id || l.b === id)

export const neighborsOf = (t: Topology, id: string): string[] =>
  incidentLinks(t, id).map((l) => (l.a === id ? l.b : l.a))

/** Can a link be drawn from `from` to `to`? Mirrors the server rules so invalid targets can be dimmed. */
export function canLinkTo(t: Topology, from: string, to: string): { ok: boolean; reason?: string } {
  if (from === to) return { ok: false, reason: 'A link needs two different routers' }
  const existing = linkBetween(t, from, to)
  if (existing) return { ok: false, reason: `${existing.id} already connects ${existing.a} and ${existing.b}` }
  return { ok: true }
}

export interface DeleteInfo { links: string[]; text: string; blocked: string | null }

/** What deleting a router takes with it, in the words shown in the confirmation. */
export function deleteRouterInfo(t: Topology, snap: Snapshot | null, id: string): DeleteInfo {
  const links = incidentLinks(t, id).map((l) => l.id)
  const blocked = id === t.source ? `${id} is the source. Choose another source first`
    : id === t.destination ? `${id} is the destination. Choose another destination first` : null
  const plural = links.length === 1 ? 'link' : 'links'
  let text = links.length ? `Removes ${id} and ${links.length} ${plural}: ${links.join(', ')}.` : `Removes ${id}.`
  if (snap?.static_path.nodes.includes(id)) text += ` The static route uses ${id} and will break.`
  return { links, text, blocked }
}
