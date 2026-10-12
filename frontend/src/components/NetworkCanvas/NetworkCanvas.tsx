import { useMemo } from 'react'
import type { Snapshot, Topology } from '../../api/types'
import { COLORS } from '../../domain/colors'
import { fitNodes, VIEW } from '../../domain/layout'
import { nameOf } from '../../domain/narration'
import { ring, useDisplayed, useReducedMotion } from '../../hooks'
import { useSimStore } from '../../store/useSimStore'
import { Lanes } from './Lane'
import { LinkView } from './LinkView'
import { NodeView } from './NodeView'
import { Packets } from './Packets'

/** Is there an injected fault on this element that the system has not confirmed yet? */
function unconfirmed(snap: Snapshot, id: string, isNode: boolean): boolean {
  return snap.fault_log.some((f) => f.target === id && f.restored_tick === null && (
    isNode ? f.op === 'fail_node' && !snap.dead_nodes.includes(id)
      : f.op !== 'fail_node' && (snap.link_health[id]?.health ?? 'healthy') === 'healthy'))
}

function Popover({ snap, topo }: { snap: Snapshot; topo: Topology }) {
  const sel = useSimStore((s) => s.selected)
  const select = useSimStore((s) => s.select)
  const pos = useMemo(() => fitNodes(topo.nodes), [topo])
  if (!sel) return null
  let body: React.ReactNode
  let at = { x: 0, y: 0 }
  let title = ''
  if (sel.type === 'link') {
    const l = topo.links.find((x) => x.id === sel.id)
    if (!l) return null
    const m = snap.link_metrics[l.id]
    const h = snap.link_health[l.id]
    at = { x: (pos[l.a].x + pos[l.b].x) / 2, y: (pos[l.a].y + pos[l.b].y) / 2 }
    title = nameOf(l.id, topo)
    body = (
      <>
        <p>Status: <b>{h?.health === 'down' ? 'DOWN' : h?.health === 'degraded' ? `Degraded (${h.reason})` : 'Healthy'}</b>
          {h && h.since > 0 ? ` since t=${h.since}` : ''}</p>
        <p>Latency: {m?.latency_ms == null ? 'no response' : `${m.latency_ms.toFixed(1)} ms (normal ${l.latency} ms)`}</p>
        <p>Loss: {m ? `${m.loss_pct.toFixed(1)}% of packets` : '–'}</p>
        <p>Load: {m ? `${Math.round(m.util_pct)}% busy` : '–'}</p>
      </>
    )
  } else {
    const dead = snap.dead_nodes.includes(sel.id)
    at = pos[sel.id]
    title = `Router ${sel.id}`
    const used = [snap.static_path, snap.healing_path].filter((p) => p?.nodes.includes(sel.id)).length
    body = (
      <>
        <p>Status: <b>{dead ? 'DOWN (all its links stopped responding)' : 'Up'}</b></p>
        <p>{used > 0 ? 'Carries traffic of at least one flow.' : 'No flow passes through it right now.'}</p>
      </>
    )
  }
  const x = Math.min(VIEW.width - 270, Math.max(10, at.x + 22))
  const y = Math.min(VIEW.height - 150, Math.max(10, at.y - 100))
  return (
    <foreignObject x={x} y={y} width={260} height={140}>
      <div className="rounded-lg border-2 border-sky-400 bg-white p-2 text-sm text-gray-900 shadow-lg">
        <div className="flex items-center justify-between">
          <b>{title}</b>
          <button aria-label="Close details" className="rounded px-1 text-lg leading-none hover:bg-gray-100"
            onClick={() => select(null)}>×</button>
        </div>
        {body}
      </div>
    </foreignObject>
  )
}

export function NetworkCanvas() {
  const snap = useDisplayed()
  const topo = useSimStore((s) => s.topology)
  const cursor = useSimStore((s) => s.cursor)
  const spot = useSimStore((s) => s.spotlight)
  const sel = useSimStore((s) => s.selected)
  const select = useSimStore((s) => s.select)
  const reduced = useReducedMotion()
  const pos = useMemo(() => (topo ? fitNodes(topo.nodes) : {}), [topo])
  if (!snap || !topo) {
    return <div className="flex flex-1 items-center justify-center rounded-lg border border-line bg-panel">
      Connecting to the simulation…</div>
  }
  const last = (f: 'static' | 'healing') => snap.series?.[f]?.[snap.series[f].length - 1]
  const dropped = (id: string): number | null => {
    if (!reduced) return null
    let n = 0
    for (const f of ['static', 'healing'] as const) {
      const row = last(f)
      const path = f === 'static' ? snap.static_path : snap.healing_path
      if (!row || !path || row.lost_packets === 0) continue
      const culprit = path.links.findIndex((l) => snap.link_metrics[l]?.status === 'down')
      const idx = culprit >= 0 ? culprit : path.links.findIndex((l) => (snap.link_metrics[l]?.loss_pct ?? 0) > 0)
      if (idx >= 0 && path.links[idx] === id) n += row.lost_packets
    }
    return n
  }
  return (
    <section aria-label="Network" className={`flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-panel ${ring(spot === 'canvas')}`}>
      <svg viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} preserveAspectRatio="xMidYMid meet"
        className="min-h-0 w-full flex-1" role="img"
        aria-label="Network topology with the static and self-healing paths">
        <rect width={VIEW.width} height={VIEW.height} fill="white" rx={8}
          onClick={() => select(null)} />
        {topo.links.map((l) => pos[l.a] && pos[l.b] && (
          <LinkView key={l.id} link={l} a={pos[l.a]} b={pos[l.b]}
            health={snap.link_health[l.id]?.health ?? 'healthy'} reason={snap.link_health[l.id]?.reason ?? null}
            metric={snap.link_metrics[l.id]}
            impairment={snap.impairments[l.id]} unconfirmedFault={unconfirmed(snap, l.id, false)}
            selected={sel?.type === 'link' && sel.id === l.id} dropped={dropped(l.id)}
            onSelect={() => select({ type: 'link', id: l.id })} />
        ))}
        <Lanes flow="static" links={topo.links} linkIds={snap.static_path.links} pos={pos} />
        <Lanes flow="healing" links={topo.links} linkIds={snap.healing_path?.links ?? []} pos={pos} />
        {!reduced && <Packets snap={snap} links={topo.links} pos={pos} live={cursor === null} />}
        {topo.nodes.map((n) => pos[n.id] && (
          <NodeView key={n.id} id={n.id} at={pos[n.id]}
            role={n.id === topo.source ? 'source' : n.id === topo.destination ? 'destination' : null}
            dead={snap.dead_nodes.includes(n.id)} unconfirmedFault={unconfirmed(snap, n.id, true)}
            selected={sel?.type === 'node' && sel.id === n.id}
            onSelect={() => select({ type: 'node', id: n.id })} />
        ))}
        <Popover snap={snap} topo={topo} />
      </svg>
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line px-3 py-1 text-sm"
        aria-label="Legend">
        <li className="flex items-center gap-2">
          <svg width="34" height="8" aria-hidden><line x1="0" y1="4" x2="34" y2="4" stroke={COLORS.healing} strokeWidth="4" /></svg>
          <b>Self-healing</b> flow
        </li>
        <li className="flex items-center gap-2">
          <svg width="34" height="8" aria-hidden><line x1="0" y1="4" x2="34" y2="4" stroke={COLORS.static} strokeWidth="4" strokeDasharray="8 5" /></svg>
          <b>Static</b> flow
        </li>
        <li className="flex items-center gap-2">
          <svg width="34" height="8" aria-hidden><line x1="0" y1="4" x2="34" y2="4" stroke={COLORS.healthy} strokeWidth="3" /></svg>healthy
        </li>
        <li className="flex items-center gap-2">
          <svg width="34" height="8" aria-hidden><line x1="0" y1="4" x2="34" y2="4" stroke={COLORS.degraded} strokeWidth="3" strokeDasharray="2 6" strokeLinecap="round" /></svg>degraded
        </li>
        <li className="flex items-center gap-2">
          <svg width="34" height="8" aria-hidden><line x1="0" y1="4" x2="34" y2="4" stroke={COLORS.down} strokeWidth="3" strokeDasharray="9 6" /></svg>down ✕
        </li>
        <li className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-3 w-3 rounded-full bg-red-600" />dropped packet
        </li>
      </ul>
    </section>
  )
}
