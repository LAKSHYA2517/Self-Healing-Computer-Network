import { call } from './client'
import type { EditResponse, Impact, TopologyInfo, TopologyListItem } from './types'

const enc = encodeURIComponent

/** Every call returns {topology, snapshot, impact}, so the UI can update without waiting for a poll. */
export const topologyApi = {
  get: () => call<TopologyInfo>('/api/topology'),
  list: () => call<TopologyListItem[]>('/api/topologies'),
  addNode: (x: number, y: number) => call<EditResponse>('/api/topology/node', { x, y }),
  moveNode: (id: string, x: number, y: number) => call<EditResponse>(`/api/topology/node/${enc(id)}`, { x, y }, 'PATCH'),
  deleteNode: (id: string) => call<EditResponse>(`/api/topology/node/${enc(id)}`, undefined, 'DELETE'),
  addLink: (a: string, b: string, latency: number, bw: number) =>
    call<EditResponse>('/api/topology/link', { a, b, latency, bw }),
  updateLink: (id: string, patch: { latency?: number; bw?: number }) =>
    call<EditResponse>(`/api/topology/link/${enc(id)}`, patch, 'PATCH'),
  deleteLink: (id: string) => call<EditResponse>(`/api/topology/link/${enc(id)}`, undefined, 'DELETE'),
  setEndpoints: (source: string, destination: string) =>
    call<EditResponse>('/api/topology/endpoints', { source, destination }),
  repinStatic: () => call<EditResponse>('/api/topology/repin-static', {}),
  undo: () => call<EditResponse>('/api/topology/undo', {}),
  redo: () => call<EditResponse>('/api/topology/redo', {}),
  reset: () => call<EditResponse>('/api/topology/reset', {}),
  save: (name: string) => call<EditResponse>('/api/topologies/save', { name }),
  load: (name: string) => call<EditResponse>('/api/topologies/load', { name }),
  importJson: (data: unknown) => call<EditResponse>('/api/topology/import', data),
  preview: (op: string, body: Record<string, unknown>) =>
    call<{ impact: Impact }>('/api/topology/preview', { op, ...body }),
  exportUrl: '/api/topology/export',
}
