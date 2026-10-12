import { FINISH_SPOT, MILESTONES } from '../domain/milestones'
import { useDisplayed } from '../hooks'
import { useSimStore } from '../store/useSimStore'

/** Coach card shown in the bottom strip while the guided demo runs. */
export function GuidedDemo() {
  const g = useSimStore((s) => s.guided)
  const topo = useSimStore((s) => s.topology)
  const next = useSimStore((s) => s.guidedNext)
  const stop = useSimStore((s) => s.guidedStop)
  const snap = useDisplayed()
  if (!g.active || !snap) return null
  const total = MILESTONES.length
  const done = g.step
  const m = done > 0 && done <= total ? MILESTONES[done - 1] : null
  const finished = done > total
  const title = finished ? 'Results' : m ? m.title : 'Guided demo'
  const text = finished
    ? 'The run is complete. Compare the two flows in the Results tab.'
    : m ? m.text(snap, topo)
      : 'Two identical flows send traffic from R1 to R10. Orange is static routing, blue is self-healing. ' +
        'Press Space to run until the first milestone.'
  const hint = done >= total ? (finished ? '' : 'Space: finish the run') : 'Space: next milestone'
  return (
    <aside aria-label="Guided demo" className="flex w-[22rem] shrink-0 flex-col rounded-lg border-2 border-sky-400 bg-panel p-2">
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-sky-500 px-2 text-sm font-bold text-white">
          {finished ? 'Done' : `${Math.min(done, total)} of ${total}`}
        </span>
        <button onClick={stop} className="focus-ring rounded px-1 text-sm font-semibold text-mute hover:bg-line/40">
          Close
        </button>
      </div>
      <h2 className="mt-1 text-base font-bold">{title}</h2>
      <p className="flex-1 overflow-auto text-sm leading-snug">{text}</p>
      {!finished && (
        <button onClick={() => void next()} disabled={g.busy}
          className="focus-ring mt-1 rounded-md bg-heal px-3 py-1 text-sm font-bold text-white disabled:opacity-50">
          {g.busy ? 'Running…' : `▶ ${hint}`}
        </button>
      )}
      {finished && <span className="text-sm text-mute" data-spot={FINISH_SPOT}>{hint}</span>}
    </aside>
  )
}
