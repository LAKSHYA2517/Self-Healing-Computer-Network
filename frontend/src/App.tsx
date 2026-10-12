import { useEffect } from 'react'
import { FlowCard } from './components/FlowCard'
import { HelpOverlay } from './components/Glossary'
import { GuidedDemo } from './components/GuidedDemo'
import { Header } from './components/Header'
import { NarrationBanner } from './components/NarrationBanner'
import { NetworkCanvas } from './components/NetworkCanvas/NetworkCanvas'
import { Pipeline } from './components/Pipeline'
import { ChartsPanel } from './components/panels/ChartsPanel'
import { EventLog } from './components/panels/EventLog'
import { LinkHealthTable } from './components/panels/LinkHealthTable'
import { ManualControls } from './components/panels/ManualControls'
import { ResultsPanel } from './components/panels/ResultsPanel'
import { Timeline } from './components/Timeline'
import { ring } from './hooks'
import { useSimStore, type TabId } from './store/useSimStore'

const TABS: [TabId, string][] = [
  ['charts', 'Charts'], ['events', 'Events'], ['health', 'Link health'],
  ['controls', 'Manual controls'], ['results', 'Results'],
]

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && (el as HTMLInputElement).type !== 'range'
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const s = useSimStore.getState()
      const k = e.key.toLowerCase()
      if (e.key === ' ') {
        if (s.guided.active) { e.preventDefault(); void s.guidedNext() }
      } else if (k === 'n') void s.stepOnce()
      else if (k === 'r') void s.run()
      else if (k === 'p') void s.togglePause()
      else if (k === 'g') void (s.guided.active ? s.guidedStop() : s.guidedStart())
      else if (e.key === '?' || (k === '/' && e.shiftKey)) s.toggleHelp()
      else if (e.key === 'Escape') { if (s.helpOpen) s.toggleHelp(); else s.select(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function TabPanel() {
  const tab = useSimStore((s) => s.tab)
  const setTab = useSimStore((s) => s.setTab)
  const spot = useSimStore((s) => s.spotlight)
  return (
    <section aria-label="Details"
      className={`flex min-w-0 flex-1 flex-col rounded-lg border border-line bg-panel ${ring(spot === 'results')}`}>
      <div role="tablist" className="flex gap-1 border-b border-line px-2 pt-1">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`focus-ring -mb-px rounded-t-md border border-b-0 px-3 py-1 text-sm font-semibold ${
              tab === id ? 'border-line bg-panel text-heal' : 'border-transparent text-mute hover:text-ink'}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 p-2" role="tabpanel">
        {tab === 'charts' && <ChartsPanel />}
        {tab === 'events' && <EventLog />}
        {tab === 'health' && <LinkHealthTable />}
        {tab === 'controls' && <ManualControls />}
        {tab === 'results' && <ResultsPanel />}
      </div>
    </section>
  )
}

export default function App() {
  const init = useSimStore((s) => s.init)
  const conn = useSimStore((s) => s.conn)
  const error = useSimStore((s) => s.error)
  const clearError = useSimStore((s) => s.clearError)
  useEffect(() => { void init() }, [init])
  useShortcuts()
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      {conn === 'lost' && (
        <div role="alert" className="rounded-md bg-bad px-3 py-1 text-sm font-semibold text-white">
          ✕ Connection lost, retrying… showing the last data received.
        </div>
      )}
      {error && (
        <div role="alert" className="flex items-center justify-between rounded-md bg-warn px-3 py-1 text-sm font-semibold text-white">
          <span>▲ {error}</span>
          <button onClick={clearError} className="focus-ring px-2">×</button>
        </div>
      )}
      <Header />
      <NarrationBanner />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_28rem] gap-2">
        <NetworkCanvas />
        <aside className="flex min-h-0 flex-col gap-2 overflow-hidden">
          <FlowCard flow="static" />
          <FlowCard flow="healing" />
          <Pipeline />
        </aside>
      </div>
      <Timeline />
      <div className="flex h-[11.5rem] gap-2">
        <TabPanel />
        <GuidedDemo />
      </div>
      <HelpOverlay />
    </div>
  )
}
