import { useState } from 'react'
import { HEALTH_ICON, HEALTH_LABEL } from '../../domain/colors'
import { useDisplayed } from '../../hooks'
import { useSimStore } from '../../store/useSimStore'

export function LinkHealthTable() {
  const snap = useDisplayed()
  const topo = useSimStore((s) => s.topology)
  const [open, setOpen] = useState(false)
  if (!snap || !topo) return null
  const bad = topo.links.filter((l) => snap.link_health[l.id]?.health !== 'healthy').length
  return (
    <div className="h-full overflow-auto">
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className="focus-ring mb-1 rounded-md border border-line px-2 py-0.5 text-sm font-semibold">
        {open ? 'Hide' : 'Show'} all {topo.links.length} links
      </button>
      <span className="ml-2">{bad === 0 ? 'All links healthy' : `${bad} link${bad === 1 ? '' : 's'} not healthy`}</span>
      {open && (
        <table className="mt-1 w-full text-left">
          <thead>
            <tr className="text-mute"><th>Link</th><th>Ends</th><th>Status</th><th>Latency</th><th>Loss</th><th>Load</th><th>Since</th></tr>
          </thead>
          <tbody>
            {topo.links.map((l) => {
              const h = snap.link_health[l.id]
              const m = snap.link_metrics[l.id]
              const health = h?.health ?? 'healthy'
              return (
                <tr key={l.id} className={health === 'down' ? 'bg-red-100 dark:bg-red-950' : health === 'degraded' ? 'bg-amber-100 dark:bg-amber-950' : ''}>
                  <td className="font-semibold">{l.id}</td>
                  <td>{l.a}-{l.b}</td>
                  <td>{HEALTH_ICON[health]} {HEALTH_LABEL[health]}{h?.reason ? ` (${h.reason})` : ''}</td>
                  <td>{m?.latency_ms == null ? '–' : `${m.latency_ms.toFixed(1)} ms`}</td>
                  <td>{m ? `${m.loss_pct.toFixed(1)}%` : '–'}</td>
                  <td>{m ? `${Math.round(m.util_pct)}%` : '–'}</td>
                  <td>{h && h.since > 0 ? `t=${h.since}` : '–'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
