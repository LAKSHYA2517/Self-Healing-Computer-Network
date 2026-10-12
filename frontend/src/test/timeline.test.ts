import { describe, expect, it } from 'vitest'
import { marksFrom } from '../components/Timeline'
import { LINK_FAILURE } from './fixtures'

describe('timeline marks', () => {
  it('puts detect and reroute at the same tick in one label, and separates trust from restore', () => {
    const marks = marksFrom(LINK_FAILURE[50])
    const at = (tick: number, row: string) => marks.find((m) => m.tick === tick && m.row === row)?.label
    expect(at(10, 'above')).toBe('fault')
    expect(at(11, 'below')).toBe('detected + rerouted')
    expect(at(40, 'above')).toBe('restored')
    expect(at(44, 'below')).toContain('trusted again')
    expect(at(44, 'below')).toContain('failback')
  })
})
