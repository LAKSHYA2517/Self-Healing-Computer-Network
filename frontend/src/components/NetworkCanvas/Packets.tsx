import { useEffect, useReducer, useRef } from 'react'
import type { Flow, Snapshot, TopoLink } from '../../api/types'
import { COLORS } from '../../domain/colors'
import type { Pt } from '../../domain/layout'
import { laneSegment } from './Lane'

const PER_TICK = 6

interface Packet {
  flow: Flow
  start: number          // virtual ms when the packet starts moving
  dur: number
  pts: Pt[]
  cum: number[]          // cumulative length at each point
  dropAt: number | null  // distance along the path where it dies
  hitAt: number | null   // virtual ms when it died
}

/** Index (along the path) of the link where packets die: the first down link, else the lossiest. */
export function culpritIndex(linkIds: string[], snap: Snapshot): number {
  const down = linkIds.findIndex((id) => snap.link_metrics[id]?.status === 'down')
  if (down >= 0) return down
  let best = -1, bestLoss = 0
  linkIds.forEach((id, i) => {
    const loss = snap.link_metrics[id]?.loss_pct ?? 0
    if (loss > bestLoss) { best = i; bestLoss = loss }
  })
  return best
}

function build(flow: Flow, snap: Snapshot, links: TopoLink[], pos: Record<string, Pt>): { pts: Pt[]; cum: number[]; culprit: number } | null {
  const path = flow === 'static' ? snap.static_path : snap.healing_path
  if (!path) return null
  const pts: Pt[] = []
  path.links.forEach((id, i) => {
    const l = links.find((x) => x.id === id)
    if (!l || !pos[l.a] || !pos[l.b]) return
    const [pa, pb] = laneSegment(l, pos, flow)
    const forward = path.nodes[i] === l.a
    const [from, to] = forward ? [pa, pb] : [pb, pa]
    pts.push(from, to)
  })
  if (pts.length < 2) return null
  const cum = [0]
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  return { pts, cum, culprit: culpritIndex(path.links, snap) }
}

function pointAt(p: Packet, d: number): Pt {
  let i = 1
  while (i < p.cum.length - 1 && p.cum[i] < d) i += 1
  const span = p.cum[i] - p.cum[i - 1] || 1
  const t = Math.min(1, Math.max(0, (d - p.cum[i - 1]) / span))
  return { x: p.pts[i - 1].x + (p.pts[i].x - p.pts[i - 1].x) * t, y: p.pts[i - 1].y + (p.pts[i].y - p.pts[i - 1].y) * t }
}

interface Props {
  snap: Snapshot
  links: TopoLink[]
  pos: Record<string, Pt>
  live: boolean
}

/**
 * Dots that travel each flow's lane once per tick. Surviving dots go end to end,
 * dying dots turn red and puff out at the broken or lossy link.
 */
export function Packets({ snap, links, pos, live }: Props) {
  const packets = useRef<Packet[]>([])
  const clock = useRef(0)
  const paused = useRef(snap.paused)
  const lastTick = useRef<number | null>(null)
  const [, force] = useReducer((n: number) => n + 1, 0)
  paused.current = snap.paused

  useEffect(() => {
    if (!live || lastTick.current === snap.tick || snap.tick === 0) {
      lastTick.current = snap.tick
      return
    }
    lastTick.current = snap.tick
    const dur = Math.min(snap.tick_seconds * 1000, 1000) * 0.6
    const spread = Math.min(snap.tick_seconds * 1000, 1000) * 0.3
    const fresh: Packet[] = []
    for (const flow of ['static', 'healing'] as const) {
      const b = build(flow, snap, links, pos)
      const row = snap.series?.[flow]?.[snap.series[flow].length - 1]
      if (!b || !row) continue
      const dying = PER_TICK - Math.round((PER_TICK * row.delivery_pct) / 100)
      const total = b.cum[b.cum.length - 1]
      for (let i = 0; i < PER_TICK; i += 1) {
        let dropAt: number | null = null
        if (i < dying) {
          // cumulative index of the culprit link: each link contributes one segment (2 points)
          const seg = Math.max(0, b.culprit)
          const from = b.cum[Math.min(seg * 2, b.cum.length - 1)]
          const to = b.cum[Math.min(seg * 2 + 1, b.cum.length - 1)]
          dropAt = b.culprit >= 0 ? from + (to - from) * 0.45 : total * 0.5
        }
        fresh.push({ flow, start: clock.current + (i * spread) / PER_TICK, dur, pts: b.pts, cum: b.cum,
          dropAt, hitAt: null })
      }
    }
    packets.current = [...packets.current.filter((p) => !isDone(p, clock.current)), ...fresh]
  }, [snap, live, links, pos])

  useEffect(() => {
    let raf = 0
    let prev = performance.now()
    const loop = (now: number): void => {
      const dt = Math.min(64, now - prev)
      prev = now
      if (!paused.current) clock.current += dt
      packets.current = packets.current.filter((p) => !isDone(p, clock.current))
      force()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const now = clock.current
  return (
    <g pointerEvents="none" aria-hidden>
      {packets.current.map((p, i) => {
        if (now < p.start) return null
        const total = p.cum[p.cum.length - 1]
        const d = Math.min(total, ((now - p.start) / p.dur) * total)
        const dies = p.dropAt !== null && d >= p.dropAt
        const at = pointAt(p, dies ? (p.dropAt as number) : d)
        const color = p.flow === 'static' ? COLORS.static : COLORS.healing
        if (dies) {
          const hit = p.hitAt ?? now
          p.hitAt = hit
          const age = Math.min(1, (now - hit) / 450)
          return (
            <g key={i} opacity={1 - age}>
              <circle cx={at.x} cy={at.y} r={5 + age * 16} fill="none" stroke={COLORS.down} strokeWidth={3} />
              <circle cx={at.x} cy={at.y} r={6} fill={COLORS.down} />
            </g>
          )
        }
        return <circle key={i} cx={at.x} cy={at.y} r={6} fill={color} stroke="white" strokeWidth={1.5} />
      })}
    </g>
  )
}

function isDone(p: Packet, now: number): boolean {
  if (p.hitAt !== null) return now - p.hitAt > 450
  return now - p.start > p.dur + 50 && p.dropAt === null
}
