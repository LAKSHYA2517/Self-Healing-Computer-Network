import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditResponse, Snapshot, TopologyInfo } from '../api/types'
import { Dialogs } from '../components/Dialogs'
import { FlowCard } from '../components/FlowCard'
import { NetworkCanvas } from '../components/NetworkCanvas/NetworkCanvas'
import { Inspector } from '../components/panels/Inspector'
import { defaultLatency, deleteRouterInfo } from '../domain/editing'
import { fitWindow } from '../domain/layout'
import { useSimStore } from '../store/useSimStore'
import editDeleteL8 from './fixtures/edit_delete_l8.json'
import latencyCases from './fixtures/default_latency.json'
import snapshotHealthy from './fixtures/snapshot_healthy.json'
import topologyDefault from './fixtures/topology_default.json'

const TOPO = topologyDefault as unknown as TopologyInfo
const SNAP = snapshotHealthy as unknown as Snapshot
const DELETE_L8 = editDeleteL8 as unknown as EditResponse

const calls: { url: string; method: string; body: unknown }[] = []

/** Replace fetch with a recorder that answers every request with `reply`. */
function mockFetch(reply: unknown, status = 200): void {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return { ok: status < 400, status, json: async () => reply, statusText: 'x' } as Response
  }))
}

const seed = (over: Partial<ReturnType<typeof useSimStore.getState>> = {}): void => {
  act(() => useSimStore.setState({
    topology: TOPO, frames: [SNAP], cursor: null, win: fitWindow(TOPO.nodes), selected: null, editMode: 'select',
    linkFrom: null, linkDraft: null, toast: null, confirm: null, inlineError: null, ghosts: [], fresh: [], flash: [],
    ...over,
  }))
}

beforeEach(() => seed())
afterEach(() => { vi.unstubAllGlobals(); seed({ topology: null, frames: [] }) })

describe('defaultLatency', () => {
  it('matches the backend formula on the shared fixture', () => {
    expect(latencyCases.length).toBeGreaterThan(8)
    for (const c of latencyCases) {
      expect(defaultLatency(c.a as [number, number], c.b as [number, number])).toBe(c.expected)
    }
  })
})

describe('adding a link', () => {
  it('drag from one router to another opens a popover with the prefilled latency and posts the right body', async () => {
    mockFetch({ ...DELETE_L8, impact: { ...DELETE_L8.impact, message: 'Added link L16 (R1-R10).' } })
    seed({ editMode: 'link' })
    render(<NetworkCanvas />)
    const r1 = screen.getByRole('button', { name: /^Router R1$/ })
    const r10 = screen.getByRole('button', { name: /^Router R10$/ })
    fireEvent.pointerDown(r1)
    expect(useSimStore.getState().linkFrom).toBe('R1')
    fireEvent.pointerUp(r10)
    const input = await screen.findByLabelText('Latency in milliseconds')
    const a = TOPO.nodes.find((n) => n.id === 'R1')!, b = TOPO.nodes.find((n) => n.id === 'R10')!
    expect((input as HTMLInputElement).value).toBe(String(defaultLatency([a.x, a.y], [b.x, b.y])))
    expect((screen.getByLabelText('Bandwidth in Mbps') as HTMLInputElement).value).toBe('100')
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }))
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]).toMatchObject({ url: '/api/topology/link', method: 'POST',
      body: { a: 'R1', b: 'R10', latency: 20, bw: 100 } })
  })

  it('previews the effect of the link before it is confirmed (dry run, nothing applied)', async () => {
    mockFetch({ impact: { ...DELETE_L8.impact, healing: 'rerouted', preview: true,
      preferred_after: { nodes: ['R1', 'R10'], cost: 20 } } })
    seed({ editMode: 'link' })
    render(<NetworkCanvas />)
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Router R1$/ }))
    fireEvent.pointerUp(screen.getByRole('button', { name: /^Router R10$/ }))
    expect(await screen.findByTestId('link-preview')).toHaveTextContent('best path would become R1>R10 (cost 20)')
    expect(calls.every((c) => c.url === '/api/topology/preview')).toBe(true)
    expect(useSimStore.getState().topology?.links.length).toBe(15)
  })

  it('does not accept an existing neighbour as a target', () => {
    seed({ editMode: 'link' })
    render(<NetworkCanvas />)
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Router R5$/ }))
    fireEvent.pointerUp(screen.getByRole('button', { name: /^Router R7$/ }))     // L8 already connects them
    expect(useSimStore.getState().linkDraft).toBeNull()
    expect(useSimStore.getState().toast?.message).toMatch(/L8 already connects R5 and R7/)
  })

  it('shows the server validation error inline and keeps the popover open', async () => {
    mockFetch({ error: 'latency must be between 1 and 500', field: 'latency' }, 400)
    seed({ editMode: 'link' })
    render(<NetworkCanvas />)
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Router R1$/ }))
    fireEvent.pointerUp(screen.getByRole('button', { name: /^Router R10$/ }))
    fireEvent.change(await screen.findByLabelText('Latency in milliseconds'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('latency must be between 1 and 500')
    expect(screen.getByLabelText('Latency in milliseconds')).toBeInTheDocument()
  })
})

describe('deleting a router', () => {
  it('the confirmation lists the cascaded links and the static-route warning', () => {
    render(<Dialogs />)
    act(() => useSimStore.getState().requestDeleteRouter('R5'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Removes R5 and 4 links: L4, L5, L8, L9\. The static route uses R5 and will break\./))
      .toBeInTheDocument()
  })

  it('refuses the source and destination with the server wording', () => {
    expect(deleteRouterInfo(TOPO, SNAP, 'R1').blocked).toBe('R1 is the source. Choose another source first')
    act(() => useSimStore.getState().requestDeleteRouter('R10'))
    expect(useSimStore.getState().confirm).toBeNull()
    expect(useSimStore.getState().toast?.message).toBe('R10 is the destination. Choose another destination first')
  })

  it('confirming calls DELETE', async () => {
    mockFetch(DELETE_L8)
    render(<Dialogs />)
    act(() => useSimStore.getState().requestDeleteRouter('R3'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete router' }))
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]).toMatchObject({ url: '/api/topology/node/R3', method: 'DELETE' })
  })
})

describe('inspector', () => {
  it('editing the latency sends PATCH on Enter', async () => {
    mockFetch(DELETE_L8)
    seed({ selected: { type: 'link', id: 'L8' } })
    render(<Inspector />)
    const input = screen.getByLabelText('Latency (ms)')
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0]).toMatchObject({ url: '/api/topology/link/L8', method: 'PATCH', body: { latency: 20 } })
  })

  it('shows Fail link and Delete link as separate actions and Delete calls DELETE', async () => {
    mockFetch(DELETE_L8)
    seed({ selected: { type: 'link', id: 'L8' } })
    render(<Inspector />)
    expect(screen.getByRole('button', { name: 'Fail link' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete link' }))
    await waitFor(() => expect(calls[0]).toMatchObject({ url: '/api/topology/link/L8', method: 'DELETE' }))
  })

  it('router actions set the endpoints', async () => {
    mockFetch(DELETE_L8)
    seed({ selected: { type: 'node', id: 'R9' } })
    render(<Inspector />)
    fireEvent.click(screen.getByRole('button', { name: 'Set as destination' }))
    await waitFor(() => expect(calls[0]).toMatchObject({
      url: '/api/topology/endpoints', body: { source: 'R1', destination: 'R9' } }))
    expect(screen.getByRole('button', { name: 'Delete router' })).toBeInTheDocument()
  })

  it('keeps the field and shows the error when the server rejects the value', async () => {
    mockFetch({ error: 'latency must be between 1 and 500', field: 'latency' }, 400)
    seed({ selected: { type: 'link', id: 'L8' } })
    render(<Inspector />)
    const input = screen.getByLabelText('Latency (ms)')
    fireEvent.change(input, { target: { value: '9999' } })
    fireEvent.blur(input)
    expect(await screen.findByRole('alert')).toHaveTextContent('latency must be between 1 and 500')
  })
})

describe('impact toast', () => {
  it('shows the server message on the canvas after an edit', async () => {
    mockFetch(DELETE_L8)
    render(<NetworkCanvas />)
    await act(async () => { await useSimStore.getState().deleteLink('L8') })
    expect(screen.getByText(DELETE_L8.impact.message)).toBeInTheDocument()
    expect(useSimStore.getState().topology?.links.some((l) => l.id === 'L8')).toBe(false)
  })

  it('shows the best path badge from the preferred path', () => {
    render(<NetworkCanvas />)
    expect(screen.getByLabelText('Best path')).toHaveTextContent('Best path: R1>R2>R5>R7>R9>R10, cost 33')
  })
})

describe('Reconfigure static route', () => {
  it('is disabled while the static route is valid and enabled (pulsing) when it is broken', () => {
    const { rerender } = render(<FlowCard flow="static" />)
    const btn = screen.getByRole('button', { name: 'Reconfigure static route' })
    expect(btn).toBeDisabled()
    seed({ frames: [DELETE_L8.snapshot] })
    rerender(<FlowCard flow="static" />)
    const live = screen.getByRole('button', { name: 'Reconfigure static route' })
    expect(live).toBeEnabled()
    expect(live.className).toContain('pulse')
  })

  it('calls the re-pin endpoint', async () => {
    mockFetch(DELETE_L8)
    seed({ frames: [DELETE_L8.snapshot] })
    render(<FlowCard flow="static" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reconfigure static route' }))
    await waitFor(() => expect(calls[0]).toMatchObject({ url: '/api/topology/repin-static', method: 'POST' }))
  })
})
