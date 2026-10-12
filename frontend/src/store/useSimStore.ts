import { create } from 'zustand'
import { liveBackend, loadRecording, replayBackend } from '../api/client'
import type { Backend, Recording, ScenarioInfo, Snapshot, Summary, Topology } from '../api/types'
import { MILESTONES } from '../domain/milestones'

export const BUFFER_SIZE = 300
export const GUIDED_SCENARIO = 'link_failure'
const GUIDED_STEP_MS = 220

export type TabId = 'charts' | 'events' | 'health' | 'controls' | 'results'
export type Spot = 'banner' | 'canvas' | 'cards' | 'pipeline' | 'timeline' | 'results' | null
export interface Selection { type: 'link' | 'node'; id: string }

interface GuidedState { active: boolean; step: number; busy: boolean }

interface SimStore {
  backend: Backend
  topology: Topology | null
  scenarios: ScenarioInfo[]
  scenarioName: string
  frames: Snapshot[]
  /** Index into `frames` being viewed; null follows the live edge. */
  cursor: number | null
  conn: 'ok' | 'lost'
  error: string | null
  summary: Summary | null
  tab: TabId
  selected: Selection | null
  spotlight: Spot
  guided: GuidedState
  helpOpen: boolean
  theme: 'light' | 'dark'
  recordingName: string | null

  init: () => Promise<void>
  poll: () => Promise<void>
  call: (fn: (b: Backend) => Promise<Snapshot>) => Promise<void>
  setScenario: (name: string) => void
  run: () => Promise<void>
  togglePause: () => Promise<void>
  stepOnce: () => Promise<void>
  setSpeed: (multiplier: number) => Promise<void>
  reset: () => Promise<void>
  scrub: (frameIndex: number | null) => void
  setTab: (t: TabId) => void
  select: (s: Selection | null) => void
  toggleHelp: () => void
  toggleTheme: () => void
  clearError: () => void
  guidedStart: () => Promise<void>
  guidedNext: () => Promise<void>
  guidedStop: () => void
  loadRecordingFile: (file: File) => Promise<void>
  saveRecording: () => void
}

let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollGeneration = 0

/** The snapshot the whole screen renders: scrubbed frame or the live edge. */
export const displayed = (s: Pick<SimStore, 'frames' | 'cursor'>): Snapshot | null =>
  s.frames.length === 0 ? null : s.frames[s.cursor ?? s.frames.length - 1]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useSimStore = create<SimStore>((set, get) => {
  /** Merge a snapshot into the ring buffer and handle resets. */
  const ingest = (snap: Snapshot): void => {
    const { frames, cursor, summary } = get()
    const last = frames[frames.length - 1]
    let next: Snapshot[]
    let nextCursor = cursor
    let nextSummary = summary
    if (!last || snap.tick < last.tick) {
      next = [snap]
      nextCursor = null
      nextSummary = null
    } else if (snap.tick === last.tick) {
      next = [...frames.slice(0, -1), snap]
    } else {
      next = [...frames, snap]
    }
    if (next.length > BUFFER_SIZE) {
      const cut = next.length - BUFFER_SIZE
      next = next.slice(cut)
      if (nextCursor !== null) nextCursor = Math.max(0, nextCursor - cut)
    }
    set({ frames: next, cursor: nextCursor, summary: nextSummary, conn: 'ok' })
    const wasFinished = last?.scenario.finished ?? false
    if (snap.scenario.finished && !wasFinished) void get().backend.summary()
      .then((summaryNow) => set({ summary: summaryNow, tab: 'results' })).catch(() => undefined)
  }

  const schedule = (generation: number): void => {
    if (pollTimer) clearTimeout(pollTimer)
    const latest = get().frames[get().frames.length - 1]
    const ms = Math.min(3000, Math.max(250, (latest?.tick_seconds ?? 1) * 1000))
    pollTimer = setTimeout(() => { if (generation === pollGeneration) void get().poll() }, ms)
  }

  const startPolling = (): void => {
    pollGeneration += 1
    void get().poll()
  }

  return {
    backend: liveBackend,
    topology: null,
    scenarios: [],
    scenarioName: GUIDED_SCENARIO,
    frames: [],
    cursor: null,
    conn: 'ok',
    error: null,
    summary: null,
    tab: 'charts',
    selected: null,
    spotlight: null,
    guided: { active: false, step: 0, busy: false },
    helpOpen: false,
    theme: 'light',
    recordingName: null,

    init: async () => {
      const replayUrl = new URLSearchParams(window.location.search).get('replay')
      try {
        if (replayUrl) {
          const rec = await loadRecording(replayUrl)
          set({ backend: replayBackend(rec), recordingName: replayUrl.split('/').pop() ?? replayUrl })
        }
        const backend = get().backend
        const [topology, scenarios] = await Promise.all([backend.topology(), backend.scenarios()])
        set({ topology, scenarios,
          scenarioName: scenarios.find((s) => s.name === GUIDED_SCENARIO)?.name ?? scenarios[0]?.name ?? '' })
      } catch (e) {
        set({ conn: 'lost', error: message(e) })
        setTimeout(() => void get().init(), 2000)
        return
      }
      startPolling()
    },

    poll: async () => {
      const generation = pollGeneration
      try {
        const snap = await get().backend.state()
        if (generation === pollGeneration) ingest(snap)
      } catch {
        set({ conn: 'lost' })
      }
      schedule(generation)
    },

    call: async (fn) => {
      try {
        ingest(await fn(get().backend))
        set({ error: null })
      } catch (e) {
        set({ error: message(e) })
      }
    },

    setScenario: (name) => set({ scenarioName: name }),

    run: async () => {
      set({ summary: null, cursor: null })
      await get().call((b) => b.startScenario(get().scenarioName))
    },

    togglePause: async () => {
      const paused = displayed(get())?.paused ?? false
      await get().call((b) => (paused ? b.resume() : b.pause()))
    },

    stepOnce: async () => {
      if (!(displayed(get())?.paused ?? false)) await get().call((b) => b.pause())
      await get().call((b) => b.step())
    },

    setSpeed: async (multiplier) => get().call((b) => b.speed(1 / multiplier)),

    reset: async () => {
      get().guidedStop()
      set({ summary: null, cursor: null })
      await get().call((b) => b.reset())
    },

    scrub: (frameIndex) => set({ cursor: frameIndex }),
    setTab: (tab) => set({ tab }),
    select: (selected) => set({ selected }),
    toggleHelp: () => set((s) => ({ helpOpen: !s.helpOpen })),
    toggleTheme: () => {
      const theme = get().theme === 'light' ? 'dark' : 'light'
      document.documentElement.dataset.theme = theme
      set({ theme })
    },
    clearError: () => set({ error: null }),

    guidedStart: async () => {
      const { call } = get()
      set({ guided: { active: true, step: 0, busy: true }, spotlight: null, summary: null, cursor: null,
        scenarioName: GUIDED_SCENARIO, tab: 'charts' })
      await call((b) => b.pause())
      await call((b) => b.startScenario(GUIDED_SCENARIO))
      await call((b) => b.pause())
      set((s) => ({ guided: { ...s.guided, busy: false } }))
    },

    guidedNext: async () => {
      const g = get().guided
      if (!g.active || g.busy) return
      set({ guided: { ...g, busy: true } })
      const goal = g.step < MILESTONES.length ? MILESTONES[g.step].reached : (s: Snapshot) => s.scenario.finished
      for (let i = 0; i < 400; i += 1) {
        const cur = displayed({ frames: get().frames, cursor: null })
        if (cur && goal(cur)) break
        await get().call((b) => b.step())
        await sleep(GUIDED_STEP_MS)
      }
      const step = Math.min(g.step + 1, MILESTONES.length + 1)
      const spot: Spot = g.step < MILESTONES.length ? MILESTONES[g.step].spot : 'results'
      set({ guided: { active: true, step, busy: false }, spotlight: spot, cursor: null })
    },

    guidedStop: () => set({ guided: { active: false, step: 0, busy: false }, spotlight: null }),

    loadRecordingFile: async (file) => {
      try {
        const rec = JSON.parse(await file.text()) as Recording
        if (!Array.isArray(rec.snapshots) || !rec.topology) throw new Error('not a recording file')
        pollGeneration += 1
        set({ backend: replayBackend(rec), frames: [], cursor: null, summary: null,
          topology: rec.topology, scenarios: rec.scenario ? [rec.scenario] : [],
          scenarioName: rec.scenario?.name ?? '', recordingName: file.name, error: null })
        startPolling()
      } catch (e) {
        set({ error: message(e) })
      }
    },

    saveRecording: () => {
      const { frames, topology, scenarios, scenarioName, summary } = get()
      if (!topology || frames.length === 0) return
      const rec: Recording = {
        version: 1, topology, snapshots: frames,
        scenario: scenarios.find((s) => s.name === scenarioName) ?? null,
        ...(summary ? { summary } : {}),
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify(rec)], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `recording_${scenarioName || 'run'}.json`
      a.click()
      URL.revokeObjectURL(url)
    },
  }
})
