import { describe, expect, it } from 'vitest'
import { csvFrom } from '../components/panels/ResultsPanel'
import type { FlowRow, Snapshot } from '../api/types'

const row = (flow: 'static' | 'healing', tick: number, d: number | null): FlowRow => ({
  tick, flow, path: ['R1', 'R2'], delivery_pct: d ? 100 : 0, delay_ms: d, throughput_mbps: d ? 70 : 0,
  lost_packets: d ? 0 : 100, available: !!d,
})

describe('csvFrom', () => {
  it('matches the /api/export column layout and keeps gaps empty', () => {
    const snap = { series: { healing: [row('healing', 0, 33)], static: [row('static', 0, null)] } } as unknown as Snapshot
    const lines = csvFrom(snap).trim().split('\n')
    expect(lines[0]).toBe('tick,flow,path,delivery_pct,delay_ms,throughput_mbps,lost_packets,available')
    expect(lines).toContain('0,healing,R1-R2,100,33,70,0,1')
    expect(lines).toContain('0,static,R1-R2,0,,0,100,0')
  })
})
