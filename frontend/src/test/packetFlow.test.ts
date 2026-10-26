import { describe, expect, it } from 'vitest'
import type { LinkMetric, PathResult, TopoLink } from '../api/types'
import { buildGeo, mixColor, PacketEngine, PER_TICK, posAtU, smoothstep } from '../domain/packetFlow'

const LINKS: TopoLink[] = [
  { id: 'L1', a: 'R1', b: 'R2', latency: 2, bw: 100 },
  { id: 'L2', a: 'R2', b: 'R3', latency: 14, bw: 100 },
]
const PATH: PathResult = { nodes: ['R1', 'R2', 'R3'], links: ['L1', 'L2'], cost: 16 }
const seg = (l: TopoLink): [{ x: number; y: number }, { x: number; y: number }] =>
  l.id === 'L1' ? [{ x: 0, y: 0 }, { x: 100, y: 0 }] : [{ x: 100, y: 0 }, { x: 200, y: 0 }]
const up: LinkMetric = { status: 'up', latency_ms: 5, loss_pct: 0, util_pct: 30 }
const metrics = { L1: up, L2: up }

describe('buildGeo', () => {
  it('takes longer on slower links (but not proportionally crawling)', () => {
    const g = buildGeo(PATH, LINKS, seg, metrics)!
    const quick = posAtU(g, 0.2).x                       // 20% of the trip time
    expect(quick).toBeGreaterThan(40)                   // L1 (2 ms) is crossed in well under half the trip
    const mid = posAtU(g, 0.5)
    expect(mid.x).toBeGreaterThan(100)                  // the 2 ms link takes less than half the time
    expect(posAtU(g, 0).x).toBe(0)
    expect(posAtU(g, 1).x).toBe(200)
    expect(posAtU(g, 2).x).toBe(200)                    // clamped
  })

  it('doomed packets die just inside the first down link, or at the lossiest one', () => {
    const down = buildGeo(PATH, LINKS, seg, { L1: up, L2: { ...up, status: 'down' } })!
    expect(posAtU(down, down.dropU).x).toBeGreaterThan(100)
    expect(posAtU(down, down.dropU).x).toBeLessThan(160)
    const lossy = buildGeo(PATH, LINKS, seg, { L1: { ...up, loss_pct: 30 }, L2: up })!
    expect(posAtU(lossy, lossy.dropU).x).toBeLessThan(100)
  })

  it('a removed link ends the lane and doomed packets die at its end', () => {
    const g = buildGeo(PATH, [LINKS[0]], seg, { L1: up })!
    expect(g.dropU).toBe(1)
    expect(posAtU(g, 1).x).toBe(100)
    expect(buildGeo(null, LINKS, seg, metrics)).toBeNull()
    expect(buildGeo({ nodes: [], links: [], cost: 0 }, LINKS, seg, metrics)).toBeNull()
  })
})

describe('PacketEngine', () => {
  const run = (ratio: number, ticks = 10) => {
    const e = new PacketEngine()
    const g = buildGeo(PATH, LINKS, seg, { L1: up, L2: { ...up, status: ratio === 0 ? 'down' : 'up' } })!
    e.setFlow('healing', g, ratio)
    let spawned = 0, died = 0
    const seen = new Set<unknown>()
    for (let t = 0; t < ticks * 100; t += 1) {           // 10 ms frames, 1 s ticks
      e.advance(10, 1000, true, 1500)
      for (const p of e.packets) if (!seen.has(p)) { seen.add(p); spawned += 1; if (p.doomed) died += 1 }
    }
    return { e, spawned, died }
  }

  it('emits a steady PER_TICK packets per tick for each flow with a lane', () => {
    const { spawned } = run(1, 10)
    expect(Math.abs(spawned - 10 * PER_TICK)).toBeLessThanOrEqual(1)
  })

  it('dooms exactly the lost share (error diffusion, no random flicker)', () => {
    const { spawned, died } = run(0.75, 10)
    expect(Math.abs(died - spawned * 0.25)).toBeLessThanOrEqual(1)
    expect(run(1, 5).died).toBe(0)
    const none = run(0, 5)
    expect(none.died).toBe(none.spawned)
  })

  it('does not emit without a lane and stops emitting when not streaming', () => {
    const e = new PacketEngine()
    e.advance(2000, 1000, true, 1500)
    expect(e.packets).toHaveLength(0)
    const { e: e2 } = run(1, 1)
    const n = e2.packets.length
    e2.advance(500, 1000, false, 1500)
    expect(e2.packets.length).toBeLessThanOrEqual(n)
  })

  it('a doomed packet reddens, bursts into particles and rings, then disappears', () => {
    const e = new PacketEngine()
    e.setFlow('static', buildGeo(PATH, LINKS, seg, { L1: up, L2: { ...up, status: 'down' } }), 0)
    e.burstTick(1000)
    let reddest = 0, sawBurst = false
    for (let i = 0; i < 400; i += 1) {
      e.advance(10, 1000, false, 1000)
      const v = e.views()
      if (v.fx.some((f) => f.fill && f.fill !== 'none')) sawBurst = true
      for (const p of v.packets) reddest = Math.max(reddest, p.scale)
    }
    expect(sawBurst).toBe(true)
    expect(reddest).toBeGreaterThan(1.1)                 // swells as it dies
    expect(e.packets).toHaveLength(0)
    expect(e.views().fx).toHaveLength(0)
  })

  it('survivors flash on arrival, rate limited, and have a fading tail', () => {
    const e = new PacketEngine()
    e.setFlow('healing', buildGeo(PATH, LINKS, seg, metrics), 1)
    e.burstTick(1000)
    let rings = 0, tail = 0
    for (let i = 0; i < 300; i += 1) {
      e.advance(10, 1000, false, 1000)
      const v = e.views()
      tail = Math.max(tail, ...v.packets.map((p) => p.tail.length), 0)
      rings = Math.max(rings, v.fx.length)
    }
    expect(tail).toBe(3)
    expect(rings).toBeGreaterThan(0)
    expect(e.packets).toHaveLength(0)
  })

  it('new packets use the new lane while packets already in flight keep theirs', () => {
    const e = new PacketEngine()
    const a = buildGeo(PATH, LINKS, seg, metrics)
    e.setFlow('healing', a, 1)
    e.advance(300, 1000, true, 1500)
    const first = e.packets[0].geo
    e.setFlow('healing', buildGeo({ ...PATH, links: ['L1'], nodes: ['R1', 'R2'] }, LINKS, seg, metrics), 1)
    e.advance(400, 1000, true, 1500)
    expect(e.packets[0].geo).toBe(first)
    expect(e.packets[e.packets.length - 1].geo).not.toBe(first)
  })
})

describe('helpers', () => {
  it('smoothstep and mixColor', () => {
    expect(smoothstep(0, 1, -1)).toBe(0)
    expect(smoothstep(0, 1, 2)).toBe(1)
    expect(smoothstep(0, 1, 0.5)).toBe(0.5)
    expect(mixColor('#000000', '#ffffff', 0.5)).toBe('rgb(128,128,128)')
    expect(mixColor('#1d4ed8', '#dc2626', 0)).toBe('rgb(29,78,216)')
  })
})
