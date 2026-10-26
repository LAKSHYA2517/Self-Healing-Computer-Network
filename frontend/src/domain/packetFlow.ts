import type { Flow, LinkMetric, PathResult, TopoLink } from '../api/types'
import type { Pt } from './layout'

/** Packets emitted per flow per tick. */
export const PER_TICK = 6
const TAIL = 3
const TAIL_STEP = 0.028        // distance between tail dots, as a share of the whole trip
const BURST_MS = 520           // how long a drop burst lives
const ARRIVAL_MS = 380

/** A flow's lane as a polyline, with how long each step takes (longer links take longer). */
export interface Geo {
  pts: Pt[]
  /** Cumulative travel time at each point (arbitrary units). */
  tcum: number[]
  /** Share of the trip (0..1) where doomed packets die: just inside a down or lossy link. */
  dropU: number
}

export const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1)))
  return t * t * (3 - 2 * t)
}
export const easeOut = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3

/** Mix two #rrggbb colours (k = 0 gives a, 1 gives b). */
export function mixColor(a: string, b: string, k: number): string {
  const c = (h: string, i: number): number => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  const ch = (i: number): number => Math.round(c(a, i) + (c(b, i) - c(a, i)) * k)
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`
}

/**
 * Build the lane polyline of a path. Time per link follows its latency (tempered, so a 14 ms link is
 * visibly slower than a 4 ms one without crawling). A link that no longer exists ends the lane there.
 */
export function buildGeo(path: PathResult | null, links: TopoLink[], segment: (l: TopoLink) => [Pt, Pt],
  metrics: Record<string, LinkMetric | undefined>): Geo | null {
  if (!path || path.nodes.length === 0) return null
  const known = path.links.map((id) => links.find((l) => l.id === id))
  const mean = known.reduce((s, l) => s + (l?.latency ?? 5), 0) / Math.max(1, known.length)
  const pts: Pt[] = []
  const tcum: number[] = []
  const starts: { from: number; w: number }[] = []
  let missing = false
  for (const [i, l] of known.entries()) {
    if (!l) { missing = true; break }
    const [pa, pb] = segment(l)
    const [from, to] = path.nodes[i] === l.a ? [pa, pb] : [pb, pa]
    const w = 0.5 * mean + 0.5 * l.latency
    if (pts.length) { pts.push(from); tcum.push(tcum[tcum.length - 1] + 0.001) } else { pts.push(from); tcum.push(0) }
    starts.push({ from: pts.length - 1, w })
    pts.push(to)
    tcum.push(tcum[tcum.length - 1] + w)
  }
  if (pts.length < 2) return null
  const total = tcum[tcum.length - 1]
  // where do doomed packets die? first down link, otherwise the lossiest one
  let culprit = known.findIndex((l) => l && (metrics[l.id] === undefined || metrics[l.id]?.status === 'down'))
  if (culprit < 0) {
    let best = 0
    known.forEach((l, i) => {
      const loss = l ? metrics[l.id]?.loss_pct ?? 0 : 0
      if (loss > best) { best = loss; culprit = i }
    })
  }
  let dropU = 0.5
  if (missing && culprit < 0) dropU = 1
  else if (culprit >= 0 && starts[culprit]) dropU = (tcum[starts[culprit].from] + 0.45 * starts[culprit].w) / total
  return { pts, tcum, dropU }
}

/** Point at share u (0..1) of the trip, in travel time. */
export function posAtU(g: Geo, u: number): Pt {
  const T = Math.min(1, Math.max(0, u)) * g.tcum[g.tcum.length - 1]
  let i = 1
  while (i < g.tcum.length - 1 && g.tcum[i] < T) i += 1
  const span = g.tcum[i] - g.tcum[i - 1] || 1
  const t = Math.min(1, Math.max(0, (T - g.tcum[i - 1]) / span))
  return { x: g.pts[i - 1].x + (g.pts[i].x - g.pts[i - 1].x) * t, y: g.pts[i - 1].y + (g.pts[i].y - g.pts[i - 1].y) * t }
}

interface Packet {
  flow: Flow; geo: Geo; born: number; travel: number; doomed: boolean; hit: number | null; done: boolean
}
interface Pulse { x: number; y: number; at: number; color: string; kind: 'drop' | 'arrive'; seed: number }

export interface PacketView {
  x: number; y: number; opacity: number; color: string; scale: number
  tail: { x: number; y: number; o: number; r: number }[]
}
export interface FxView { x: number; y: number; r: number; opacity: number; fill: string | null; stroke: string | null; w: number }

const BASE: Record<Flow, string> = { healing: '#1d4ed8', static: '#c2410c' }
const DROP = '#dc2626'

/** Simulation of the packet stream, independent of the DOM so it can be tested. */
export class PacketEngine {
  packets: Packet[] = []
  private pulses: Pulse[] = []
  private clock = 0
  private acc: Record<Flow, number> = { healing: 0, static: 0 }
  private lossAcc: Record<Flow, number> = { healing: 0, static: 0 }
  private geo: Record<Flow, Geo | null> = { healing: null, static: null }
  private ratio: Record<Flow, number> = { healing: 1, static: 1 }
  private lastArrival: Record<Flow, number> = { healing: -1e9, static: -1e9 }
  private seed = 0

  /** The flow's current lane and the share of its packets that get through this tick. */
  setFlow(flow: Flow, geo: Geo | null, deliveryRatio: number): void {
    this.geo[flow] = geo
    this.ratio[flow] = Math.min(1, Math.max(0, deliveryRatio))
  }

  clear(): void {
    this.packets = []
    this.pulses = []
  }

  /** Doomed packets are chosen by error diffusion, so exactly the right share dies (no random flicker). */
  private doomed(flow: Flow): boolean {
    this.lossAcc[flow] += 1 - this.ratio[flow]
    if (this.lossAcc[flow] >= 1 - 1e-9) { this.lossAcc[flow] -= 1; return true }
    return false
  }

  private spawn(flow: Flow, born: number, travel: number): void {
    const geo = this.geo[flow]
    if (!geo || this.packets.length > 120) return
    this.packets.push({ flow, geo, born, travel, doomed: this.doomed(flow), hit: null, done: false })
  }

  /** One tick's worth of packets, spread over the trip (used when a paused simulation is stepped). */
  burstTick(travelMs: number): void {
    for (const flow of ['static', 'healing'] as const) {
      for (let i = 0; i < PER_TICK; i += 1) this.spawn(flow, this.clock + (i * travelMs * 0.09), travelMs)
    }
  }

  /** Move time forward. While streaming, emit packets at a steady rate of PER_TICK per tick. */
  advance(dtMs: number, tickMs: number, streaming: boolean, travelMs: number): void {
    this.clock += dtMs
    if (streaming) {
      const gap = tickMs / PER_TICK
      for (const flow of ['static', 'healing'] as const) {
        this.acc[flow] += dtMs / gap
        let n = 0
        while (this.acc[flow] >= 1 && n < 3) {
          this.acc[flow] -= 1
          n += 1
          this.spawn(flow, this.clock - this.acc[flow] * gap, travelMs)
        }
        this.acc[flow] = Math.min(this.acc[flow], 1)
      }
    }
    for (const p of this.packets) {
      const u = (this.clock - p.born) / p.travel
      if (u < 0 || p.hit !== null || p.done) continue
      if (p.doomed && u >= p.geo.dropU) {
        p.hit = this.clock
        const at = posAtU(p.geo, p.geo.dropU)
        this.pulses.push({ ...at, at: this.clock, color: DROP, kind: 'drop', seed: (this.seed += 1) })
      } else if (u >= 1) {
        p.done = true
        if (this.clock - this.lastArrival[p.flow] > 160) {
          this.lastArrival[p.flow] = this.clock
          const at = posAtU(p.geo, 1)
          this.pulses.push({ ...at, at: this.clock, color: BASE[p.flow], kind: 'arrive', seed: 0 })
        }
      }
    }
    this.packets = this.packets.filter((p) => !p.done && (p.hit === null))
    this.pulses = this.pulses.filter((f) => this.clock - f.at < BURST_MS)
  }

  /** What to draw right now. */
  views(): { packets: PacketView[]; fx: FxView[] } {
    const packets: PacketView[] = []
    for (const p of this.packets) {
      const u = (this.clock - p.born) / p.travel
      if (u < 0) continue
      const k = p.doomed ? smoothstep(p.geo.dropU - 0.14, p.geo.dropU, u) : 0
      const head = posAtU(p.geo, u)
      const tail = []
      for (let j = 1; j <= TAIL; j += 1) {
        const uj = u - j * TAIL_STEP
        if (uj <= 0) break
        tail.push({ ...posAtU(p.geo, uj), o: 0.5 / j, r: 7 - j * 1.3 })
      }
      packets.push({ ...head, color: mixColor(BASE[p.flow], DROP, k), scale: 1 + 0.3 * k,
        opacity: Math.min(smoothstep(0, 0.07, u), 1 - smoothstep(0.93, 1, u)), tail })
    }
    const fx: FxView[] = []
    for (const f of this.pulses) {
      const a = (this.clock - f.at) / (f.kind === 'drop' ? BURST_MS : ARRIVAL_MS)
      if (a >= 1) continue
      if (f.kind === 'arrive') {
        fx.push({ x: f.x, y: f.y, r: 7 + 13 * easeOut(a), opacity: 0.8 * (1 - a), fill: null, stroke: f.color, w: 2.5 })
        continue
      }
      fx.push({ x: f.x, y: f.y, r: 7 + 20 * easeOut(a), opacity: 0.9 * (1 - a), fill: null, stroke: f.color, w: 3 })
      for (let i = 0; i < 6; i += 1) {
        const ang = ((i + (f.seed % 3) * 0.33) / 6) * Math.PI * 2
        const d = 26 * easeOut(a)
        fx.push({ x: f.x + Math.cos(ang) * d, y: f.y + Math.sin(ang) * d, r: 3.4 * (1 - a), opacity: 1 - a,
          fill: f.color, stroke: null, w: 0 })
      }
    }
    return { packets, fx }
  }
}
