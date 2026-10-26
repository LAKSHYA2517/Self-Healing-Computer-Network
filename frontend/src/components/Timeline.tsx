import type { EventKind, Snapshot } from '../api/types'
import { currentTick } from '../domain/phase'
import { ring, useDisplayed } from '../hooks'
import { useSimStore } from '../store/useSimStore'

interface Mark { tick: number; row: 'above' | 'below'; label: string; color: string }

const KIND: Partial<Record<EventKind, { row: Mark['row']; label: string; color: string }>> = {
  fault: { row: 'above', label: 'fault', color: '#b91c1c' },
  restore: { row: 'above', label: 'restored', color: '#15803d' },
  detect: { row: 'below', label: 'detected', color: '#b45309' },
  reroute: { row: 'below', label: 'rerouted', color: '#1d4ed8' },
  failback: { row: 'below', label: 'failback', color: '#15803d' },
}

/** Group events by tick and row so labels at the same spot are joined, not overprinted. */
export function marksFrom(snap: Snapshot, span = 60): Mark[] {
  const groups = new Map<string, Mark>()
  for (const e of snap.events) {
    // "healthy again" / "recovered" come from the detector, not from the operator fixing the fault
    const trusted = e.kind === 'restore' && /again|RECOVERED/.test(e.message)
    const k = trusted ? { row: 'below' as const, label: 'trusted again', color: '#15803d' } : KIND[e.kind]
    if (!k) continue
    const key = `${e.tick}-${k.row}`
    const g = groups.get(key)
    if (!g) groups.set(key, { tick: e.tick, row: k.row, label: k.label, color: k.color })
    else if (!g.label.split(' + ').includes(k.label)) g.label += ` + ${k.label}`
  }
  // labels closer than ~6% of the timeline would overprint: merge them into the first one of the row
  const near = Math.max(2, span * 0.06)
  const merged: Mark[] = []
  for (const m of [...groups.values()].sort((a, b) => a.tick - b.tick)) {
    const prev = [...merged].reverse().find((x) => x.row === m.row)
    if (prev && m.tick - prev.tick <= near) {
      for (const part of m.label.split(' + ')) if (!prev.label.split(' + ').includes(part)) prev.label += ` + ${part}`
    } else merged.push({ ...m })
  }
  return merged
}

export function Timeline() {
  const snap = useDisplayed()
  const scenarios = useSimStore((s) => s.scenarios)
  const frames = useSimStore((s) => s.frames)
  const cursor = useSimStore((s) => s.cursor)
  const scrub = useSimStore((s) => s.scrub)
  const spot = useSimStore((s) => s.spotlight)
  if (!snap) return null
  const planned = scenarios.find((s) => s.name === snap.scenario.name)?.events ?? []
  const cur = currentTick(snap)
  const span = Math.max(snap.scenario.duration || 0, cur + 1, 30)
  const marks = marksFrom(snap, span)
  const pct = (t: number): string => `${Math.min(100, (t / span) * 100)}%`
  const index = cursor ?? frames.length - 1
  return (
    <section aria-label="Timeline"
      className={`rounded-lg border border-line bg-panel px-3 py-1 ${ring(spot === 'timeline')}`}>
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-sm font-bold">Timeline</span>
        <div className="relative h-[3.75rem] flex-1">
          <div className="absolute inset-x-0 top-[1.55rem] h-2 rounded bg-line" />
          <div className="absolute left-0 top-[1.55rem] h-2 rounded bg-heal/60" style={{ width: pct(cur) }} />
          {planned.map((p, i) => (
            <span key={i} className="absolute top-[1.3rem] -translate-x-1/2 text-sm text-mute"
              style={{ left: pct(p.t) }} title={`Planned: ${p.op.replace('_', ' ')} ${p.id} at t=${p.t}`}
              aria-hidden>▽</span>
          ))}
          {marks.map((m) => (
            <div key={`${m.tick}-${m.row}`} className="absolute -translate-x-1/2 whitespace-nowrap text-sm font-semibold"
              style={{ left: pct(m.tick), color: m.color, top: m.row === 'above' ? 0 : '2.45rem' }}>
              {m.row === 'above' ? `${m.label} ▾` : `▴ ${m.label}`}
            </div>
          ))}
          <div className="absolute top-[1.2rem] h-5 w-1 -translate-x-1/2 rounded bg-ink" style={{ left: pct(cur) }}
            aria-hidden />
        </div>
        <label className="flex w-64 shrink-0 items-center gap-2 text-sm">
          <span className="shrink-0 font-semibold">Replay</span>
          <input type="range" min={0} max={Math.max(0, frames.length - 1)} value={Math.max(0, index)}
            onChange={(e) => scrub(Number(e.target.value) >= frames.length - 1 ? null : Number(e.target.value))}
            className="focus-ring w-full" aria-label="Scrub through recorded ticks" />
        </label>
        <button onClick={() => scrub(null)} disabled={cursor === null}
          className="focus-ring shrink-0 rounded-md border border-line px-2 py-1 text-sm font-semibold
            disabled:opacity-40">
          {cursor === null ? '● Live' : 'Back to live'}
        </button>
      </div>
      <p className="sr-only">▽ marks scheduled events; coloured labels are what actually happened.</p>
    </section>
  )
}
