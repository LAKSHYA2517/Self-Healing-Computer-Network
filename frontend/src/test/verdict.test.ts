import { describe, expect, it } from 'vitest'
import { verdict } from '../components/panels/ResultsPanel'
import type { FlowSummary, Summary } from '../api/types'

const flow = (lost: number, avail: number): FlowSummary => ({
  sent: 6000, lost, loss_pct: 0, outage_ticks: 0, availability_pct: avail, route_changes: 0,
  avg_delay_ms: 33, avg_throughput_mbps: 70,
})
const summary = (s: FlowSummary, h: FlowSummary): Summary =>
  ({ ticks: 60, static: s, healing: { ...h, faults: [] } })

describe('results verdict', () => {
  it('quantifies the improvement', () => {
    expect(verdict(summary(flow(3000, 50), flow(200, 96.67))))
      .toBe('Self-healing lost 93% fewer packets (200 instead of 3000) and stayed 96.67% available instead of 50%.')
  })

  it('explains an off-path fault', () => {
    expect(verdict(summary(flow(0, 100), flow(0, 100)))).toMatch(/not on the path either flow uses/)
  })
})
