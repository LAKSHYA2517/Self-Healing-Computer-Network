import { useEffect, useMemo, useRef } from 'react'
import type { Snapshot, TopoLink } from '../../api/types'
import type { Pt } from '../../domain/layout'
import { buildGeo, PacketEngine } from '../../domain/packetFlow'
import { laneSegment } from './Lane'

const PACKET_SLOTS = 80
const FX_SLOTS = 140
const TAIL = 3

/** Trip time in ms: about one and a half ticks, so a packet is always in flight on the lane. */
const travelMs = (tickMs: number): number => Math.min(3200, Math.max(700, tickMs * 1.5))
const NS = 'http://www.w3.org/2000/svg'

interface Props {
  snap: Snapshot
  links: TopoLink[]
  pos: Record<string, Pt>
  live: boolean
}

function setCircle(c: Element, x: number, y: number, r: number, fill: string, opacity: number): void {
  c.setAttribute('cx', x.toFixed(1))
  c.setAttribute('cy', y.toFixed(1))
  c.setAttribute('r', r.toFixed(1))
  c.setAttribute('fill', fill)
  c.setAttribute('opacity', opacity.toFixed(2))
}

/**
 * A continuous stream of packets on each flow's lane. Doomed packets redden and burst at the broken or
 * lossy link; survivors flash on arrival. Positions are written straight to the SVG (no React render
 * per frame), so the animation stays smooth while the rest of the screen updates.
 */
export function Packets({ snap, links, pos, live }: Props) {
  const engine = useMemo(() => new PacketEngine(), [])
  const root = useRef<SVGGElement>(null)
  const latest = useRef({ snap, live })
  latest.current = { snap, live }
  const runUntil = useRef(0)
  const lastTick = useRef<number | null>(null)

  // Lanes and delivery ratios follow every new snapshot; a step while paused plays one tick of packets.
  useEffect(() => {
    for (const flow of ['static', 'healing'] as const) {
      const path = flow === 'static' ? snap.static_path : snap.healing_path
      const geo = buildGeo(path, links, (l) => laneSegment(l, pos, flow), snap.link_metrics)
      const row = snap.series?.[flow]?.[snap.series[flow].length - 1]
      engine.setFlow(flow, geo, row ? row.delivery_pct / 100 : 1)
    }
    if (!live) engine.clear()
    else if (snap.paused && lastTick.current !== null && snap.tick !== lastTick.current) {
      engine.burstTick(travelMs(1000))
      runUntil.current = performance.now() + travelMs(1000) + 1400
    }
    lastTick.current = snap.tick
  }, [snap, links, pos, live, engine])

  useEffect(() => {
    const g = root.current
    if (!g) return undefined
    // pooled elements: created once, then only their attributes change
    const packetEls: { g: SVGGElement; dots: SVGCircleElement[] }[] = []
    const fxEls: SVGCircleElement[] = []
    const mk = (parent: Element, n: number): SVGCircleElement[] => Array.from({ length: n }, () => {
      const c = document.createElementNS(NS, 'circle')
      c.setAttribute('opacity', '0')
      parent.appendChild(c)
      return c as SVGCircleElement
    })
    const fxLayer = document.createElementNS(NS, 'g')
    g.appendChild(fxLayer)
    fxEls.push(...mk(fxLayer, FX_SLOTS))
    for (let i = 0; i < PACKET_SLOTS; i += 1) {
      const pg = document.createElementNS(NS, 'g') as SVGGElement
      g.appendChild(pg)
      packetEls.push({ g: pg, dots: mk(pg, TAIL + 3) })   // glow, tail x3, head, shine
    }

    let raf = 0
    let prev = performance.now()
    const frame = (now: number): void => {
      const dt = Math.min(50, now - prev)
      prev = now
      const { snap: s, live: lv } = latest.current
      const streaming = lv && !s.paused
      const tickMs = streaming ? Math.max(250, s.tick_seconds * 1000) : 1000
      if (streaming || now < runUntil.current) engine.advance(dt, tickMs, streaming, travelMs(tickMs))
      const { packets, fx } = engine.views()
      packetEls.forEach((slot, i) => {
        const p = packets[i]
        if (!p) { if (slot.g.getAttribute('visibility') !== 'hidden') slot.g.setAttribute('visibility', 'hidden'); return }
        slot.g.setAttribute('visibility', 'visible')
        const [glow, t1, t2, t3, head, shine] = slot.dots
        setCircle(glow, p.x, p.y, 15 * p.scale, p.color, 0.24 * p.opacity)
        ;[t1, t2, t3].forEach((c, j) => {
          const t = p.tail[j]
          if (t) setCircle(c, t.x, t.y, t.r, p.color, t.o * p.opacity)
          else c.setAttribute('opacity', '0')
        })
        setCircle(head, p.x, p.y, 7.5 * p.scale, p.color, p.opacity)
        head.setAttribute('stroke', 'white')
        head.setAttribute('stroke-width', '1.6')
        setCircle(shine, p.x - 2.1, p.y - 2.1, 2.3, 'white', 0.65 * p.opacity)
      })
      fxEls.forEach((c, i) => {
        const f = fx[i]
        if (!f) { c.setAttribute('opacity', '0'); return }
        c.setAttribute('cx', f.x.toFixed(1))
        c.setAttribute('cy', f.y.toFixed(1))
        c.setAttribute('r', Math.max(0, f.r).toFixed(1))
        c.setAttribute('opacity', f.opacity.toFixed(2))
        c.setAttribute('fill', f.fill ?? 'none')
        c.setAttribute('stroke', f.stroke ?? 'none')
        c.setAttribute('stroke-width', String(f.w))
      })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      g.replaceChildren()
    }
  }, [engine])

  return <g ref={root} pointerEvents="none" aria-hidden />
}
