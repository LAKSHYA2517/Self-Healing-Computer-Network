import { describe, expect, it } from 'vitest'
import { derivePhase } from '../domain/phase'
import { flowStatus } from '../domain/flowStatus'
import { HOLDDOWN, LINK_DEGRADATION, LINK_FAILURE, NODE_FAILURE, NO_PATH, OFF_PATH } from './fixtures'

const id = (frames: typeof LINK_FAILURE, tick: number) => derivePhase(frames[tick]).id

describe('link_failure phases', () => {
  it.each([
    [0, 'healthy'], [9, 'healthy'], [10, 'fault_undetected'], [11, 'rerouted'], [12, 'rerouted'],
    [39, 'rerouted'], [40, 'recovering'], [41, 'recovering'], [42, 'recovering'], [43, 'recovering'],
    [44, 'failback_done'], [59, 'healthy'],
  ])('tick %i is %s', (tick, expected) => {
    expect(id(LINK_FAILURE, tick)).toBe(expected)
  })

  it('counts failed checks before detection and clean checks while recovering', () => {
    const p10 = derivePhase(LINK_FAILURE[10])
    expect([p10.target, p10.count, p10.needed]).toEqual(['L8', 1, 2])
    expect([40, 41, 42, 43].map((t) => derivePhase(LINK_FAILURE[t]).count)).toEqual([1, 2, 3, 4])
    expect(derivePhase(LINK_FAILURE[41]).needed).toBe(5)
  })

  it('reports detection tick and the new route', () => {
    const p = derivePhase(LINK_FAILURE[12])
    expect(p.detectedTick).toBe(11)
    expect(p.route?.to).toBe('R1-R2-R4-R7-R9-R10')
    expect(p.route?.cost).toBe(34)
  })
})

describe('other scenarios', () => {
  it('off_path_failure never reroutes', () => {
    expect(id(OFF_PATH, 10)).toBe('fault_undetected')
    for (const t of [11, 12, 30, 39]) expect(id(OFF_PATH, t)).toBe('off_path_fault')
    expect(OFF_PATH.every((s) => s.route_changes.length === 0)).toBe(true)
    expect(derivePhase(OFF_PATH[20]).target).toBe('L14')
  })

  it('node_failure is about router R5 and reroutes', () => {
    expect(derivePhase(NODE_FAILURE[10])).toMatchObject({ id: 'fault_undetected', target: 'R5' })
    expect(derivePhase(NODE_FAILURE[11])).toMatchObject({ id: 'rerouted', target: 'R5' })
  })

  it('link_degradation needs three bad checks', () => {
    expect(derivePhase(LINK_DEGRADATION[10])).toMatchObject({ id: 'fault_undetected', count: 1, needed: 3 })
    expect(derivePhase(LINK_DEGRADATION[11])).toMatchObject({ id: 'fault_undetected', count: 2, needed: 3 })
    expect(id(LINK_DEGRADATION, 12)).toBe('rerouted')
  })

  it('no path is reported while the source is isolated, then recovers', () => {
    expect(id(NO_PATH, 3)).toBe('healthy')
    expect(id(NO_PATH, 7)).toBe('no_path')
    expect(NO_PATH[7].healing_path).toBeNull()
  })

  it('hold-down shows the remaining wait before failback', () => {
    const waiting = HOLDDOWN.map((s, t) => [t, derivePhase(s)] as const).filter(([, p]) => p.id === 'holddown')
    expect(waiting.length).toBeGreaterThan(0)
    const [, first] = waiting[0]
    expect(first.remaining).toBeGreaterThan(0)
    expect(first.remaining).toBeLessThanOrEqual(10)
    const remaining = waiting.map(([, p]) => p.remaining)
    expect([...remaining].sort((a, b) => b - a)).toEqual(remaining)
  })
})

describe('flow status', () => {
  it('static is BROKEN while L8 is down and delivering otherwise', () => {
    expect(flowStatus('static', LINK_FAILURE[5])).toBe('delivering')
    expect(flowStatus('static', LINK_FAILURE[20])).toBe('broken')
    expect(flowStatus('static', LINK_FAILURE[45])).toBe('delivering')
  })

  it('healing breaks for the undetected tick, recovers, then delivers', () => {
    expect(flowStatus('healing', LINK_FAILURE[10])).toBe('broken')
    expect(flowStatus('healing', LINK_FAILURE[11])).toBe('recovering')
    expect(flowStatus('healing', LINK_FAILURE[12])).toBe('recovering')
    expect(flowStatus('healing', LINK_FAILURE[13])).toBe('delivering')
  })

  it('degradation shows as degraded, not broken', () => {
    expect(flowStatus('static', LINK_DEGRADATION[20])).toBe('degraded')
  })
})
