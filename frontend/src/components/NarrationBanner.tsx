import { AnimatePresence, motion } from 'framer-motion'
import { usePhase } from '../hooks'
import { ring } from '../hooks'
import { useSimStore } from '../store/useSimStore'
import type { Tone } from '../domain/narration'

const TONE: Record<Tone, string> = {
  ok: 'bg-ok text-white',
  warn: 'bg-warn text-white',
  bad: 'bg-bad text-white',
  info: 'bg-heal text-white',
}
const TONE_ICON: Record<Tone, string> = { ok: '✓', warn: '▲', bad: '✕', info: '●' }

export function NarrationBanner() {
  const ctx = usePhase()
  const cursor = useSimStore((s) => s.cursor)
  const spot = useSimStore((s) => s.spotlight)
  const setTab = useSimStore((s) => s.setTab)
  if (!ctx) return <div className="h-14 rounded-lg border border-line bg-panel" />
  const { narration, phase, snap } = ctx
  const key = `${phase.id}-${phase.route?.tick ?? ''}-${phase.target ?? ''}`
  return (
    <div className={`flex min-h-[3.5rem] items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2 ${ring(spot === 'banner')}`}
      role="status" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={key} initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          exit={{ opacity: 0 }} transition={{ duration: 0.25 }}
          className={`shrink-0 rounded-full px-3 py-1 text-sm font-bold ${TONE[narration.tone]}`}>
          {TONE_ICON[narration.tone]} {narration.chip}
        </motion.span>
      </AnimatePresence>
      <motion.p key={`${key}-text`} initial={{ backgroundColor: 'rgba(250, 204, 21, 0.5)' }}
        animate={{ backgroundColor: 'rgba(250, 204, 21, 0)' }} transition={{ duration: 1.2 }}
        className="flex-1 rounded px-1 text-base font-medium leading-snug">
        {narration.sentence}
      </motion.p>
      {snap.scenario.finished && cursor === null && (
        <button onClick={() => setTab('results')}
          className="focus-ring shrink-0 rounded-md bg-ok px-2 py-1 text-sm font-bold text-white">
          ✓ Scenario finished: see Results
        </button>
      )}
      {cursor !== null && (
        <span className="shrink-0 rounded bg-warn px-2 py-1 text-sm font-semibold text-white">
          Replay of t={Math.max(0, snap.tick - 1)}
        </span>
      )}
    </div>
  )
}
