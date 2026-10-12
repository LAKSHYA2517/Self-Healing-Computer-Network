import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FlowCard } from '../components/FlowCard'
import { useSimStore } from '../store/useSimStore'
import { LINK_FAILURE } from './fixtures'

const show = (tick: number): void => {
  act(() => useSimStore.setState({ frames: [LINK_FAILURE[tick]], cursor: null }))
}

afterEach(() => act(() => useSimStore.setState({ frames: [], cursor: null })))

describe('FlowCard', () => {
  it('says BROKEN in words (not only colour) for the static flow during the outage', () => {
    show(20)
    render(<FlowCard flow="static" />)
    expect(screen.getByText('BROKEN')).toBeInTheDocument()
    expect(screen.getByText(/Static routing/)).toBeInTheDocument()
    expect(screen.getByText('R1 > R2 > R5 > R7 > R9 > R10')).toBeInTheDocument()
  })

  it('says Delivering for a healthy flow and shows its numbers', () => {
    show(5)
    render(<FlowCard flow="healing" />)
    expect(screen.getByText('Delivering')).toBeInTheDocument()
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText(/Self-healing/)).toBeInTheDocument()
  })

  it('shows Recovering for the healing flow right after the reroute, on the new path', () => {
    show(12)
    render(<FlowCard flow="healing" />)
    expect(screen.getByText('Recovering')).toBeInTheDocument()
    expect(screen.getByText('R1 > R2 > R4 > R7 > R9 > R10')).toBeInTheDocument()
  })

  it('shows the lost packet total', () => {
    show(59)
    render(<FlowCard flow="static" />)
    expect(screen.getByText('3000')).toBeInTheDocument()
  })
})
