import { useEffect, useMemo, useState } from 'react'
import type { Snapshot } from './api/types'
import { derivePhase, type Phase } from './domain/phase'
import { narrate, type Narration } from './domain/narration'
import { displayed, useSimStore } from './store/useSimStore'

/** The snapshot being shown: a scrubbed frame, or the live edge. */
export function useDisplayed(): Snapshot | null {
  return useSimStore((s) => displayed(s))
}

export function usePhase(): { snap: Snapshot; phase: Phase; narration: Narration } | null {
  const snap = useDisplayed()
  const topo = useSimStore((s) => s.topology)
  return useMemo(() => {
    if (!snap) return null
    const phase = derivePhase(snap)
    return { snap, phase, narration: narrate(phase, snap, topo) }
  }, [snap, topo])
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return undefined
    const on = (): void => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

export const ring = (on: boolean): string =>
  on ? 'ring-4 ring-sky-400 ring-offset-2 ring-offset-bg' : ''
