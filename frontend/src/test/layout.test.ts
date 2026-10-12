import { describe, expect, it } from 'vitest'
import { fitNodes, laneOffset, VIEW } from '../domain/layout'

describe('lane offsets', () => {
  const a = { x: 100, y: 100 }
  const b = { x: 300, y: 200 }

  it('are perpendicular to the link', () => {
    const o = laneOffset(a, b, 1)
    expect(o.x * (b.x - a.x) + o.y * (b.y - a.y)).toBeCloseTo(0)
    expect(Math.hypot(o.x, o.y)).toBeCloseTo(5)
  })

  it('are symmetric and distinct for the two flows', () => {
    const s = laneOffset(a, b, 1)
    const h = laneOffset(a, b, -1)
    expect(h.x).toBeCloseTo(-s.x)
    expect(h.y).toBeCloseTo(-s.y)
    expect(Math.hypot(s.x - h.x, s.y - h.y)).toBeCloseTo(10)
  })

  it('keep the same sides on a shared link regardless of vertical or horizontal orientation', () => {
    for (const end of [{ x: 100, y: 300 }, { x: 400, y: 100 }, { x: 0, y: 0 }]) {
      const s = laneOffset(a, end, 1), h = laneOffset(a, end, -1)
      expect(Math.hypot(s.x - h.x, s.y - h.y)).toBeCloseTo(10)
    }
  })
})

describe('fitNodes', () => {
  it('keeps every node inside the view', () => {
    const pts = fitNodes([{ id: 'a', x: 50, y: 40 }, { id: 'b', x: 840, y: 440 }, { id: 'c', x: 350, y: 250 }])
    for (const p of Object.values(pts)) {
      expect(p.x).toBeGreaterThan(0)
      expect(p.x).toBeLessThan(VIEW.width)
      expect(p.y).toBeGreaterThan(0)
      expect(p.y).toBeLessThan(VIEW.height)
    }
  })
})
