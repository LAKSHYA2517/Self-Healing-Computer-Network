import { describe, expect, it } from 'vitest'
import { narrate } from '../domain/narration'
import { derivePhase } from '../domain/phase'
import { HOLDDOWN, LINK_FAILURE, NO_PATH, OFF_PATH } from './fixtures'
import type { Snapshot, Topology } from '../api/types'

const say = (frames: Snapshot[], tick: number, topo?: Topology) => {
  const s = frames[tick]
  return narrate(derivePhase(s), s, topo)
}

const TOPO: Topology = {
  source: 'R1', destination: 'R10', nodes: [],
  links: [{ id: 'L8', a: 'R5', b: 'R7', latency: 5, bw: 100 }, { id: 'L14', a: 'R8', b: 'R10', latency: 13, bw: 50 }],
}

describe('narration sentences', () => {
  it('healthy names the shared path', () => {
    const n = say(LINK_FAILURE, 0)
    expect(n.chip).toBe('Normal')
    expect(n.sentence).toBe('All links are healthy. Both flows use R1 > R2 > R5 > R7 > R9 > R10.')
  })

  it('fault_undetected says how many checks were seen', () => {
    const n = say(LINK_FAILURE, 10, TOPO)
    expect(n.chip).toBe('Fault injected')
    expect(n.sentence).toBe('L8 (R5-R7) just failed. The system does not know yet: it has seen 1 of 2 failed checks.')
  })

  it('rerouted names the link, tick, new path and cost', () => {
    const n = say(LINK_FAILURE, 11, TOPO)
    expect(n.chip).toBe('Rerouted')
    expect(n.sentence).toContain('L8 (R5-R7) was confirmed down at t=11')
    expect(n.sentence).toContain('R1 > R2 > R4 > R7 > R9 > R10 (cost 34)')
    expect(n.sentence).toContain('Static routing is still sending into the broken link.')
  })

  it('recovering shows the clean-check counter', () => {
    const n = say(LINK_FAILURE, 42, TOPO)
    expect(n.chip).toBe('Link restored')
    expect(n.sentence).toBe('L8 (R5-R7) is back. The system waits for 5 clean checks before trusting it (3 of 5).')
  })

  it('failback_done mentions the preferred path', () => {
    const n = say(LINK_FAILURE, 44)
    expect(n.chip).toBe('Failed back')
    expect(n.sentence).toContain('R1 > R2 > R5 > R7 > R9 > R10')
  })

  it('off_path_fault has no reroute sentence', () => {
    const n = say(OFF_PATH, 20, TOPO)
    expect(n.chip).toBe('Fault, no impact')
    expect(n.sentence).toBe('L14 (R8-R10) is down, but neither flow uses it, so no reroute is needed.')
    expect(n.sentence).not.toMatch(/moved traffic/i)
  })

  it('no_path explains that recovery is automatic', () => {
    const n = say(NO_PATH, 7)
    expect(n.chip).toBe('No path')
    expect(n.sentence).toMatch(/No working path exists right now/)
  })

  it('holddown gives the number of ticks left', () => {
    const idx = HOLDDOWN.findIndex((s) => derivePhase(s).id === 'holddown')
    const n = say(HOLDDOWN, idx, TOPO)
    expect(n.chip).toBe('Waiting')
    expect(n.sentence).toMatch(/is trusted again\. Waiting \d+ more ticks? so the route does not flip back and forth\./)
  })
})
