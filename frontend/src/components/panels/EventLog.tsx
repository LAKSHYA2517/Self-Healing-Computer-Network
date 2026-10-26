import type { EventKind } from '../../api/types'
import { useDisplayed } from '../../hooks'

const STYLE: Record<EventKind, { icon: string; word: string; cls: string }> = {
  fault: { icon: '⚡', word: 'Fault', cls: 'text-bad' },
  detect: { icon: '🔍', word: 'Detected', cls: 'text-warn' },
  reroute: { icon: '↪', word: 'Reroute', cls: 'text-heal' },
  failback: { icon: '↩', word: 'Failback', cls: 'text-ok' },
  restore: { icon: '✔', word: 'Restored', cls: 'text-ok' },
  info: { icon: 'ℹ', word: 'Info', cls: 'text-mute' },
  critical: { icon: '⛔', word: 'CRITICAL', cls: 'text-bad font-bold' },
  topology: { icon: '✎', word: 'Edit', cls: 'text-heal' },
}

export function EventLog() {
  const snap = useDisplayed()
  if (!snap) return null
  const events = [...snap.events].reverse()
  if (events.length === 0) return <p className="text-mute">No events yet. Run a scenario to see what happens.</p>
  return (
    <ul className="h-full overflow-auto" aria-label="Event log">
      {events.map((e, i) => {
        const s = STYLE[e.kind] ?? STYLE.info
        return (
          <li key={`${e.tick}-${i}`} className={`flex gap-2 py-0.5 ${s.cls}`}>
            <span className="w-14 shrink-0 font-mono">t={e.tick}</span>
            <span aria-hidden className="w-5 shrink-0 text-center">{s.icon}</span>
            <span className="w-20 shrink-0 font-semibold">{s.word}</span>
            <span className="text-ink">{e.message}</span>
          </li>
        )
      })}
    </ul>
  )
}
