import type { Health } from '../api/types'

/** Fixed meaning everywhere: self-healing = blue solid, static = orange dashed. */
export const COLORS = {
  healing: '#1d4ed8',
  static: '#c2410c',
  healthy: '#6b7280',
  degraded: '#b45309',
  down: '#b91c1c',
  ok: '#15803d',
} as const

export const HEALTH_LABEL: Record<Health, string> = { healthy: 'Healthy', degraded: 'Degraded', down: 'DOWN' }
export const HEALTH_ICON: Record<Health, string> = { healthy: '✓', degraded: '▲', down: '✕' }
export const HEALTH_DASH: Record<Health, string | undefined> = {
  healthy: undefined, degraded: '2 7', down: '10 7',
}
