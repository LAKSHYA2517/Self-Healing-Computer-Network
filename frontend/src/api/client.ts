import type { Backend, Recording, ScenarioInfo, Snapshot, Summary, Topology } from './types'

/** A failed API call. `field` names the offending input for validation errors. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly field: string | null = null,
    readonly body: Record<string, unknown> = {}) {
    super(message)
  }
}

export async function call<T>(path: string, body?: unknown, method?: 'POST' | 'PATCH' | 'DELETE'): Promise<T> {
  const verb = method ?? (body === undefined ? undefined : 'POST')
  const res = await fetch(path, verb === undefined ? undefined : {
    method: verb, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new ApiError(String(json.error ?? res.statusText), res.status, (json.field as string | null) ?? null, json)
  }
  return json as T
}

/** The live Flask backend. */
export const liveBackend: Backend = {
  replay: false,
  topology: () => call<Topology>('/api/topology'),
  scenarios: () => call<ScenarioInfo[]>('/api/scenarios'),
  state: () => call<Snapshot>('/api/state'),
  summary: () => call<Summary>('/api/summary'),
  pause: () => call<Snapshot>('/api/pause', {}),
  resume: () => call<Snapshot>('/api/resume', {}),
  step: () => call<Snapshot>('/api/step', {}),
  speed: (tick_seconds) => call<Snapshot>('/api/speed', { tick_seconds }),
  startScenario: async (name, confirm) => {
    await call<Snapshot>('/api/scenario/start', { name, ...(confirm ? { confirm: true } : {}) })
    return call<Snapshot>('/api/resume', {})
  },
  reset: () => call<Snapshot>('/api/reset', {}),
  inject: (action, type, id) => call<Snapshot>(`/api/${action}`, { type, id }),
  degrade: (id, loss_pct) => call<Snapshot>('/api/degrade', { id, loss_pct }),
  congest: (id, util_pct) => call<Snapshot>('/api/congest', { id, util_pct }),
  clear: (id) => call<Snapshot>('/api/clear', { id }),
}

/** Plays a recording through the same interface, with no server. */
export function replayBackend(rec: Recording): Backend {
  let head = 0
  let paused = false
  let tickSeconds = 1
  let timer: ReturnType<typeof setInterval> | null = null
  const snaps = rec.snapshots
  const view = (): Snapshot => ({ ...snaps[head], paused, tick_seconds: tickSeconds })
  const schedule = (): void => {
    if (timer) clearInterval(timer)
    timer = setInterval(() => { if (!paused && head < snaps.length - 1) head += 1 }, tickSeconds * 1000)
  }
  schedule()
  const reject = (what: string) => async (): Promise<Snapshot> => {
    throw new Error(`${what} needs the live backend (replay mode)`)
  }
  return {
    replay: true,
    topology: async () => rec.topology,
    scenarios: async () => (rec.scenario ? [rec.scenario] : []),
    state: async () => view(),
    summary: async () => {
      if (!rec.summary) throw new Error('this recording has no summary')
      return rec.summary
    },
    pause: async () => { paused = true; return view() },
    resume: async () => { paused = false; return view() },
    step: async () => {
      if (!paused) throw new Error('step is only allowed while paused')
      head = Math.min(head + 1, snaps.length - 1)
      return view()
    },
    speed: async (s) => { tickSeconds = s; schedule(); return view() },
    startScenario: async () => { head = 0; paused = false; return view() },
    reset: async () => { head = 0; paused = true; return view() },
    inject: reject('Manual injection'),
    degrade: reject('Manual injection'),
    congest: reject('Manual injection'),
    clear: reject('Manual injection'),
  }
}

export async function loadRecording(url: string): Promise<Recording> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`cannot load recording ${url}`)
  const rec = (await res.json()) as Recording
  if (!Array.isArray(rec.snapshots) || !rec.topology) throw new Error('not a recording file')
  return rec
}
