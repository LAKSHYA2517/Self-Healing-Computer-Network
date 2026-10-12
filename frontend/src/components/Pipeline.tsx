import { useEffect, useState } from 'react'
import type { EventKind, Snapshot } from '../api/types'
import { nameOf } from '../domain/narration'
import { derivePhase } from '../domain/phase'
import { ring, useDisplayed } from '../hooks'
import { useSimStore } from '../store/useSimStore'
import { Tip } from './Tip'

type Step = 'monitor' | 'detector' | 'path' | 'updater'

const STEP_OF: Record<EventKind, Step[]> = {
  fault: ['monitor'], detect: ['detector'], reroute: ['path', 'updater'], failback: ['path', 'updater'],
  restore: ['detector'], info: [], critical: ['path'],
}

const TITLES: [Step, string][] = [
  ['monitor', 'Monitor'], ['detector', 'Detector'], ['path', 'Path engine'], ['updater', 'Route updater'],
]

function describe(step: Step, s: Snapshot): string {
  switch (step) {
    case 'monitor': return 'Checks every link every tick.'
    case 'detector': return `${s.config.k_down} failed checks in a row means link down; ${s.config.k_recover} clean checks to trust it again.`
    case 'path': return 'Runs Dijkstra on the links that still work.'
    case 'updater': return 'Installs the new route for self-healing traffic.'
  }
}

function realityLine(s: Snapshot): string {
  const open = [...s.fault_log].reverse().find((f) => f.restored_tick === null)
  if (open) {
    const what = open.op === 'degrade_link' ? 'dropping packets' : open.op === 'congest_link' ? 'overloaded' : 'down'
    return `${nameOf(open.target)} has been ${what} since t=${open.tick}`
  }
  const fixed = [...s.fault_log].reverse().find((f) => f.restored_tick !== null)
  return fixed ? `${nameOf(fixed.target)} was fixed at t=${fixed.restored_tick}` : 'Nothing is broken'
}

function knowsLine(s: Snapshot): string {
  const p = derivePhase(s)
  switch (p.id) {
    case 'fault_undetected':
      return p.count === 0 ? 'No failed checks yet' : `Failed checks ${p.count} of ${p.needed}, not confirmed`
    case 'rerouted': return `Confirmed down at t=${p.detectedTick}, rerouted at t=${p.route?.tick}`
    case 'off_path_fault': return `Confirmed at t=${p.detectedTick}, no flow affected`
    case 'no_alternative': return `Confirmed at t=${p.detectedTick}, no better path`
    case 'recovering': return `Clean checks ${p.count} of ${p.needed}, not trusted yet`
    case 'holddown': return `Trusted again, hold-down ${p.remaining} more ticks`
    case 'no_path': return 'No working path to the destination'
    default: return 'Everything looks healthy'
  }
}

export function Pipeline() {
  const snap = useDisplayed()
  const spot = useSimStore((s) => s.spotlight)
  const [lit, setLit] = useState<Step[]>([])
  const last = snap?.events[snap.events.length - 1]
  const key = last ? `${last.tick}-${last.kind}-${last.message}` : ''

  useEffect(() => {
    if (!last) return undefined
    setLit(STEP_OF[last.kind] ?? [])
    const t = setTimeout(() => setLit([]), 1500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!snap) return null
  const shown = lit[0] ?? STEP_OF[last?.kind ?? 'info'][0] ?? 'monitor'
  const title = TITLES.find(([id]) => id === shown)?.[1] ?? ''
  return (
    <section aria-label="How the system decided"
      className={`rounded-lg border border-line bg-panel px-2 py-1 ${ring(spot === 'pipeline')}`}>
      <h2 className="text-base font-bold">How the system decided</h2>
      <ol className="mt-0.5 flex items-center gap-1">
        {TITLES.map(([id, label], i) => (
          <li key={id} className="flex items-center gap-1">
            <span className={`whitespace-nowrap rounded-md border-2 px-1.5 text-sm font-semibold transition-colors ${lit.includes(id)
              ? 'border-heal bg-heal text-white' : 'border-line'}`} title={describe(id, snap)}>
              {label}
            </span>
            {i < TITLES.length - 1 && <span aria-hidden className="text-mute">›</span>}
          </li>
        ))}
      </ol>
      <p className="text-sm leading-tight text-mute">
        <b className="text-ink">{title}:</b>{' '}
        {shown === 'path' ? <><Tip term="dijkstra">Dijkstra</Tip> on the links that still work.</> : describe(shown, snap)}
      </p>
      <div className="mt-0.5 rounded-md border border-dashed border-line px-1 text-sm leading-snug">
        <p><b className="text-bad">Reality:</b> {realityLine(snap)}</p>
        <p><b className="text-heal">System knows:</b> {knowsLine(snap)}</p>
      </div>
      <p className="text-sm leading-tight text-mute">Teaching view: the engine never sees "Reality".</p>
    </section>
  )
}
