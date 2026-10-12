import { useDisplayed } from '../hooks'
import { useSimStore } from '../store/useSimStore'

const SPEEDS = [0.5, 1, 2]

function Btn({ children, onClick, disabled, primary, title }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; title?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`focus-ring rounded-md border px-3 py-1 text-sm font-semibold transition-colors
        disabled:cursor-not-allowed disabled:opacity-40 ${primary
        ? 'border-heal bg-heal text-white hover:opacity-90'
        : 'border-line bg-panel hover:bg-line/40'}`}>
      {children}
    </button>
  )
}

export function Header() {
  const s = useSimStore()
  const snap = useDisplayed()
  const replay = s.backend.replay
  const paused = snap?.paused ?? false
  const speed = snap ? Math.round((1 / snap.tick_seconds) * 100) / 100 : 1
  return (
    <header className="flex flex-wrap items-center gap-2">
      <h1 className="mr-2 text-lg font-extrabold">Self-Healing Network</h1>
      <label className="flex items-center gap-1 text-sm">
        <span className="sr-only">Scenario</span>
        <select className="focus-ring w-[19rem] rounded-md border border-line bg-panel px-2 py-1 text-sm"
          value={s.scenarioName} onChange={(e) => s.setScenario(e.target.value)} aria-label="Scenario">
          {s.scenarios.map((sc) => <option key={sc.name} value={sc.name}>{sc.title}</option>)}
        </select>
      </label>
      <Btn primary onClick={() => void s.run()} disabled={!s.scenarioName} title="Run scenario (R)">▶ Run</Btn>
      <Btn onClick={() => void s.togglePause()} title="Pause or resume (P)">{paused ? '▶ Resume' : '❚❚ Pause'}</Btn>
      <Btn onClick={() => void s.stepOnce()} title="Advance one tick (N)">⏭ Step</Btn>
      <label className="flex items-center gap-1 text-sm">
        <span className="font-semibold">Speed</span>
        <select className="focus-ring rounded-md border border-line bg-panel px-1 py-1 text-sm" value={speed}
          onChange={(e) => void s.setSpeed(Number(e.target.value))} aria-label="Speed">
          {SPEEDS.map((v) => <option key={v} value={v}>{v}x</option>)}
        </select>
      </label>
      <Btn onClick={() => void s.reset()}>↺ Reset</Btn>
      <Btn onClick={() => void (s.guided.active ? s.guidedStop() : s.guidedStart())}
        title="Guided demo (G)">{s.guided.active ? '✕ End guided demo' : '★ Guided demo'}</Btn>
      <div className="ml-auto flex items-center gap-2">
        {replay && (
          <span className="rounded-md bg-warn px-2 py-1 text-sm font-bold text-white"
            title={s.recordingName ?? undefined}>Replay mode (no backend)</span>
        )}
        <span className="rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm font-bold" aria-label="Current tick">
          t={snap ? Math.max(0, snap.tick - 1) : 0}
        </span>
        <Btn onClick={s.toggleTheme} title="Toggle dark theme">{s.theme === 'light' ? '☾ Dark' : '☀ Light'}</Btn>
        <Btn onClick={s.toggleHelp} title="Keyboard shortcuts (?)">?</Btn>
      </div>
    </header>
  )
}
