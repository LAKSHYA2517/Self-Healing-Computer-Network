import { create } from 'zustand'
import { ApiError, liveBackend, loadRecording, replayBackend } from '../api/client'
import { topologyApi } from '../api/topologyApi'
import type {
  Backend, EditResponse, Impact, Recording, ScenarioInfo, Snapshot, Summary, TopoLink, TopoNode, TopologyInfo,
  TopologyListItem,
} from '../api/types'
import { canLinkTo, defaultLatency, deleteRouterInfo } from '../domain/editing'
import { fitWindow, type Win } from '../domain/layout'
import { MILESTONES } from '../domain/milestones'

export const BUFFER_SIZE = 300
export const GUIDED_SCENARIO = 'link_failure'
const GUIDED_STEP_MS = 220
const TOAST_MS = 6000
const ANIM_MS = 700

export type TabId = 'charts' | 'events' | 'health' | 'inspector' | 'controls' | 'results'
export type Spot = 'banner' | 'canvas' | 'cards' | 'pipeline' | 'timeline' | 'results' | null
export type EditMode = 'select' | 'node' | 'link' | 'delete'
export interface Selection { type: 'link' | 'node'; id: string }
export interface Toast { id: number; message: string; tone: 'info' | 'bad' }
export interface LinkDraft { a: string; b: string; latency: number; bw: number }
/** Where an inline validation error is shown. */
export type ErrorScope = 'canvas' | 'inspector' | 'link-draft' | 'dialog'
export interface InlineError { scope: ErrorScope; field: string | null; message: string }
export type Confirm =
  | { kind: 'delete-node'; id: string; text: string }
  | { kind: 'scenario'; name: string; needs: string; guided: boolean }
  | { kind: 'load'; name: string }
export type DialogKind = 'save' | 'load' | 'menu' | null
/** A deleted element, kept on screen for a moment so it can fade out. */
export interface Ghost { key: string; node?: TopoNode; link?: TopoLink; a?: TopoNode; b?: TopoNode }

interface GuidedState { active: boolean; step: number; busy: boolean }

interface SimStore {
  backend: Backend
  topology: TopologyInfo | null
  topologyVersion: number
  topologies: TopologyListItem[]
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
  // editor
  win: Win
  editMode: EditMode
  linkFrom: string | null
  linkDraft: LinkDraft | null
  toast: Toast | null
  inlineError: InlineError | null
  confirm: Confirm | null
  /** A confirmation waiting for the user to save their work first. */
  afterSave: Confirm | null
  dialog: DialogKind
  fresh: string[]
  flash: string[]
  ghosts: Ghost[]

  init: () => Promise<void>
  poll: () => Promise<void>
  call: (fn: (b: Backend) => Promise<Snapshot>) => Promise<void>
  setScenario: (name: string) => void
  run: (confirm?: boolean) => Promise<void>
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
  guidedStart: (confirm?: boolean) => Promise<void>
  guidedNext: () => Promise<void>
  guidedStop: () => void
  loadRecordingFile: (file: File) => Promise<void>
  saveRecording: () => void
  // editing
  refreshTopology: () => Promise<void>
  fit: () => void
  setMode: (m: EditMode) => void
  edit: (fn: () => Promise<EditResponse>, scope?: ErrorScope) => Promise<EditResponse | null>
  addRouter: (x: number, y: number) => Promise<void>
  moveRouter: (id: string, x: number, y: number) => Promise<void>
  deleteLink: (id: string) => Promise<void>
  requestDeleteRouter: (id: string) => void
  confirmDelete: () => Promise<void>
  beginLink: (a: string) => void
  finishLink: (b: string) => void
  cancelLink: () => void
  submitLinkDraft: (latency: number, bw: number) => Promise<boolean>
  updateLink: (id: string, patch: { latency?: number; bw?: number }) => Promise<boolean>
  setEndpoints: (source: string, destination: string) => Promise<void>
  repinStatic: () => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  resetTopology: () => Promise<void>
  saveTopology: (name: string) => Promise<boolean>
  loadTopology: (name: string, force?: boolean) => Promise<void>
  importTopology: (file: File) => Promise<void>
  openDialog: (d: DialogKind) => void
  dismissConfirm: () => void
  continueConfirm: () => Promise<void>
  saveFirst: () => void
  dismissToast: () => void
}

let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollGeneration = 0
let toastId = 0
let animTimer: ReturnType<typeof setTimeout> | null = null

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
    if (snap.topology_version !== undefined && snap.topology_version !== get().topologyVersion
      && !get().backend.replay) {
      set({ topologyVersion: snap.topology_version })
      void get().refreshTopology()
    }
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

  const showToast = (text: string, tone: Toast['tone'] = 'info'): void => {
    toastId += 1
    const id = toastId
    set({ toast: { id, message: text, tone } })
    setTimeout(() => { if (get().toast?.id === id) set({ toast: null }) }, TOAST_MS)
  }

  /** Remember what appeared, changed or vanished so the canvas can animate it. */
  const trackChanges = (before: TopologyInfo | null, after: TopologyInfo): void => {
    if (!before) return
    const nodeIds = new Set(before.nodes.map((n) => n.id))
    const linkOld = new Map(before.links.map((l) => [l.id, l]))
    const linkIds = new Set(after.links.map((l) => l.id))
    const nodeNew = new Set(after.nodes.map((n) => n.id))
    const fresh = [...after.nodes.filter((n) => !nodeIds.has(n.id)).map((n) => n.id),
      ...after.links.filter((l) => !linkOld.has(l.id)).map((l) => l.id)]
    const flash = after.links.filter((l) => {
      const o = linkOld.get(l.id)
      return o && (o.latency !== l.latency || o.bw !== l.bw)
    }).map((l) => l.id)
    const ghosts: Ghost[] = [
      ...before.nodes.filter((n) => !nodeNew.has(n.id)).map((n) => ({ key: `g-${n.id}`, node: n })),
      ...before.links.filter((l) => !linkIds.has(l.id)).map((l) => ({
        key: `g-${l.id}`, link: l, a: before.nodes.find((n) => n.id === l.a), b: before.nodes.find((n) => n.id === l.b),
      })),
    ]
    if (!fresh.length && !flash.length && !ghosts.length) return
    set({ fresh, flash, ghosts })
    if (animTimer) clearTimeout(animTimer)
    animTimer = setTimeout(() => set({ fresh: [], flash: [], ghosts: [] }), ANIM_MS)
  }

  const toastTone = (impact: Impact): Toast['tone'] =>
    impact.static === 'broken' || impact.healing === 'no_path' ? 'bad' : 'info'

  /** Apply a mutation response: topology, snapshot and toast, all without waiting for a poll. */
  const applyEdit = (res: EditResponse, quiet = false): void => {
    const before = get().topology
    trackChanges(before, res.topology)
    const sel = get().selected
    const gone = sel && (sel.type === 'node' ? !res.topology.nodes.some((n) => n.id === sel.id)
      : !res.topology.links.some((l) => l.id === sel.id))
    set({ topology: res.topology, topologyVersion: res.snapshot.topology_version ?? get().topologyVersion,
      inlineError: null, ...(gone ? { selected: null } : {}) })
    ingest(res.snapshot)
    if (!quiet && res.impact.kind !== 'node_moved') showToast(res.impact.message, toastTone(res.impact))
  }

  return {
    backend: liveBackend,
    topology: null,
    topologyVersion: -1,
    topologies: [],
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
    win: { x0: 0, y0: 0, x1: 1000, y1: 600 },
    editMode: 'select',
    linkFrom: null,
    linkDraft: null,
    toast: null,
    inlineError: null,
    confirm: null,
    afterSave: null,
    dialog: null,
    fresh: [],
    flash: [],
    ghosts: [],

    init: async () => {
      const replayUrl = new URLSearchParams(window.location.search).get('replay')
      try {
        if (replayUrl) {
          const rec = await loadRecording(replayUrl)
          set({ backend: replayBackend(rec), recordingName: replayUrl.split('/').pop() ?? replayUrl })
        }
        const backend = get().backend
        const [topology, scenarios] = await Promise.all([backend.topology(), backend.scenarios()])
        set({ topology: topology as TopologyInfo, scenarios, win: fitWindow(topology.nodes),
          scenarioName: scenarios.find((s) => s.name === GUIDED_SCENARIO)?.name ?? scenarios[0]?.name ?? '' })
        if (!backend.replay) void topologyApi.list().then((topologies) => set({ topologies })).catch(() => undefined)
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

    run: async (confirm = false) => {
      const name = get().scenarioName
      set({ summary: null, cursor: null })
      try {
        ingest(await get().backend.startScenario(name, confirm))
        set({ error: null, confirm: null })
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          set({ confirm: { kind: 'scenario', name, needs: String(e.body.needs ?? 'default'), guided: false } })
        } else set({ error: message(e) })
      }
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
    select: (selected) => set({ selected, inlineError: null, ...(selected ? { tab: 'inspector' as TabId } : {}) }),
    toggleHelp: () => set((s) => ({ helpOpen: !s.helpOpen })),
    toggleTheme: () => {
      const theme = get().theme === 'light' ? 'dark' : 'light'
      document.documentElement.dataset.theme = theme
      set({ theme })
    },
    clearError: () => set({ error: null }),

    guidedStart: async (confirm = false) => {
      const { call } = get()
      set({ guided: { active: true, step: 0, busy: true }, spotlight: null, summary: null, cursor: null,
        scenarioName: GUIDED_SCENARIO, tab: 'charts' })
      await call((b) => b.pause())
      try {
        ingest(await get().backend.startScenario(GUIDED_SCENARIO, confirm))
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          set({ guided: { active: false, step: 0, busy: false },
            confirm: { kind: 'scenario', name: GUIDED_SCENARIO, needs: String(e.body.needs ?? 'default'), guided: true } })
          return
        }
        set({ error: message(e), guided: { active: false, step: 0, busy: false } })
        return
      }
      await call((b) => b.pause())
      set((s) => ({ guided: { ...s.guided, busy: false }, confirm: null }))
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
          topology: rec.topology as TopologyInfo, win: fitWindow(rec.topology.nodes),
          scenarios: rec.scenario ? [rec.scenario] : [],
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

    // ------------------------------------------------------------------ topology editing

    refreshTopology: async () => {
      try {
        const [topology, scenarios] = await Promise.all([topologyApi.get(), get().backend.scenarios()])
        trackChanges(get().topology, topology)
        set({ topology, scenarios })
      } catch {
        /* the next poll retries */
      }
    },

    fit: () => {
      const t = get().topology
      if (t) set({ win: fitWindow(t.nodes) })
    },

    setMode: (editMode) => set({ editMode, linkFrom: null, linkDraft: null, inlineError: null }),

    edit: async (fn, scope = 'canvas') => {
      try {
        const res = await fn()
        applyEdit(res)
        return res
      } catch (e) {
        const field = e instanceof ApiError ? e.field : null
        if (scope === 'canvas') showToast(message(e), 'bad')
        else set({ inlineError: { scope, field, message: message(e) } })
        return null
      }
    },

    addRouter: async (x, y) => {
      const res = await get().edit(() => topologyApi.addNode(Math.round(x), Math.round(y)))
      if (res?.impact.id) get().select({ type: 'node', id: res.impact.id })
    },

    moveRouter: async (id, x, y) => {
      const t = get().topology
      if (t) set({ topology: { ...t, nodes: t.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) } })
      const res = await get().edit(() => topologyApi.moveNode(id, x, y))
      if (!res) await get().refreshTopology()     // rejected: snap back to the server's position
    },

    deleteLink: async (id) => { await get().edit(() => topologyApi.deleteLink(id)) },

    requestDeleteRouter: (id) => {
      const t = get().topology
      if (!t) return
      const info = deleteRouterInfo(t, displayed(get()), id)
      if (info.blocked) { showToast(info.blocked, 'bad'); return }
      set({ confirm: { kind: 'delete-node', id, text: info.text } })
    },

    confirmDelete: async () => {
      const c = get().confirm
      if (c?.kind !== 'delete-node') return
      set({ confirm: null })
      await get().edit(() => topologyApi.deleteNode(c.id))
    },

    beginLink: (a) => set({ linkFrom: a, linkDraft: null, inlineError: null }),

    finishLink: (b) => {
      const { linkFrom, topology } = get()
      if (!linkFrom || !topology) return
      const ok = canLinkTo(topology, linkFrom, b)
      if (!ok.ok) { showToast(ok.reason ?? 'Cannot link these routers', 'bad'); set({ linkFrom: null }); return }
      const na = topology.nodes.find((n) => n.id === linkFrom)
      const nb = topology.nodes.find((n) => n.id === b)
      if (!na || !nb) return
      set({ linkFrom: null, inlineError: null,
        linkDraft: { a: linkFrom, b, latency: defaultLatency([na.x, na.y], [nb.x, nb.y]), bw: 100 } })
    },

    cancelLink: () => set({ linkFrom: null, linkDraft: null, inlineError: null }),

    submitLinkDraft: async (latency, bw) => {
      const d = get().linkDraft
      if (!d) return false
      const res = await get().edit(() => topologyApi.addLink(d.a, d.b, latency, bw), 'link-draft')
      if (res) set({ linkDraft: null })
      return res !== null
    },

    updateLink: async (id, patch) => (await get().edit(() => topologyApi.updateLink(id, patch), 'inspector')) !== null,

    setEndpoints: async (source, destination) => {
      await get().edit(() => topologyApi.setEndpoints(source, destination), 'inspector')
    },

    repinStatic: async () => { await get().edit(() => topologyApi.repinStatic()) },
    undo: async () => { await get().edit(() => topologyApi.undo()) },
    redo: async () => { await get().edit(() => topologyApi.redo()) },

    resetTopology: async () => {
      set({ summary: null, cursor: null })
      if (await get().edit(() => topologyApi.reset())) get().fit()
    },

    saveTopology: async (name) => {
      const res = await get().edit(() => topologyApi.save(name), 'dialog')
      if (!res) return false
      const after = get().afterSave
      set({ dialog: null, afterSave: null })
      void topologyApi.list().then((topologies) => set({ topologies })).catch(() => undefined)
      if (after?.kind === 'scenario') await (after.guided ? get().guidedStart(true) : get().run(true))
      else if (after?.kind === 'load') await get().loadTopology(after.name, true)
      return true
    },

    loadTopology: async (name, force = false) => {
      if (!force && get().topology?.dirty) { set({ confirm: { kind: 'load', name }, dialog: null }); return }
      set({ summary: null, cursor: null, confirm: null, dialog: null })
      if (await get().edit(() => topologyApi.load(name))) get().fit()
    },

    importTopology: async (file) => {
      try {
        const data = JSON.parse(await file.text()) as unknown
        set({ summary: null, cursor: null })
        if (await get().edit(() => topologyApi.importJson(data))) get().fit()
      } catch (e) {
        showToast(`Import failed: ${message(e)}`, 'bad')
      }
    },

    openDialog: (dialog) => {
      set({ dialog, inlineError: null })
      if (dialog === 'load' || dialog === 'save') {
        void topologyApi.list().then((topologies) => set({ topologies })).catch(() => undefined)
      }
    },

    dismissConfirm: () => set({ confirm: null, afterSave: null }),

    continueConfirm: async () => {
      const c = get().confirm
      set({ confirm: null })
      if (c?.kind === 'scenario') await (c.guided ? get().guidedStart(true) : get().run(true))
      else if (c?.kind === 'load') await get().loadTopology(c.name, true)
    },

    saveFirst: () => set((s) => ({ afterSave: s.confirm, confirm: null, dialog: 'save' })),
    dismissToast: () => set({ toast: null }),
  }
})
