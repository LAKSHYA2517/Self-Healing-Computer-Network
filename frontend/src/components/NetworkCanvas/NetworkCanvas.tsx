import { useMemo, useRef, useState } from 'react'
import type { Snapshot } from '../../api/types'
import { COLORS } from '../../domain/colors'
import { canLinkTo } from '../../domain/editing'
import { midpoint, toTopo, toView, VIEW, type Pt } from '../../domain/layout'
import { ring, useDisplayed, useReducedMotion } from '../../hooks'
import { useSimStore } from '../../store/useSimStore'
import { EditorHint, EditorToolbar } from './EditorToolbar'
import { Lanes } from './Lane'
import { LinkDraftPopover } from './LinkDraftPopover'
import { LinkLabels, LinkRoad } from './LinkView'
import { NodeView } from './NodeView'
import { Packets } from './Packets'

/** Is there an injected fault on this element that the system has not confirmed yet? */
function unconfirmed(snap: Snapshot, id: string, isNode: boolean): boolean {
  return snap.fault_log.some((f) => f.target === id && f.restored_tick === null && (
    isNode ? f.op === 'fail_node' && !snap.dead_nodes.includes(id)
      : f.op !== 'fail_node' && (snap.link_health[id]?.health ?? 'healthy') === 'healthy'))
}

/** Pointer position in drawing units, or null when the svg has no size (tests). */
function viewPoint(svg: SVGSVGElement | null, e: { clientX: number; clientY: number }): Pt | null {
  const r = svg?.getBoundingClientRect()
  if (!r || !r.width || !r.height) return null
  const scale = Math.min(r.width / VIEW.width, r.height / VIEW.height)
  const ox = (r.width - VIEW.width * scale) / 2
  const oy = (r.height - VIEW.height * scale) / 2
  return { x: (e.clientX - r.left - ox) / scale, y: (e.clientY - r.top - oy) / scale }
}

const CURSOR = { select: 'default', node: 'crosshair', link: 'crosshair', delete: 'pointer' } as const
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const FALLBACK_LIMITS = { x: [0, 1000], y: [0, 600] } as const

export function NetworkCanvas() {
  const snap = useDisplayed()
  const store = useSimStore()
  const { topology: topo, cursor, spotlight: spot, selected: sel, win, editMode: mode, linkFrom, fresh, flash,
    ghosts, toast } = store
  const reduced = useReducedMotion()
  const editable = !store.backend.replay
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null)
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  const [pointer, setPointer] = useState<Pt | null>(null)

  const pos = useMemo(() => {
    const out: Record<string, Pt> = {}
    for (const n of topo?.nodes ?? []) out[n.id] = toView(drag?.id === n.id ? drag : n, win)
    return out
  }, [topo, win, drag])

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

  const lim = topo.limits ?? FALLBACK_LIMITS
  // ---- interactions (editing is off in replay mode)
  const nodeDown = (id: string, e?: { clientX: number; clientY: number }): void => {
    if (!editable) { store.select({ type: 'node', id }); return }
    if (mode === 'link') {
      if (linkFrom && linkFrom !== id) store.finishLink(id)
      else store.beginLink(id)
    } else if (mode === 'delete') store.requestDeleteRouter(id)
    else {
      store.select({ type: 'node', id })
      const n = topo.nodes.find((x) => x.id === id)
      if (mode === 'select' && n && e) dragRef.current = { id, x: e.clientX, y: e.clientY, moved: false }
    }
  }
  const nodeUp = (id: string): void => {
    if (editable && mode === 'link' && linkFrom && linkFrom !== id) store.finishLink(id)
  }
  const linkClick = (id: string): void => {
    if (editable && mode === 'delete') void store.deleteLink(id)
    else store.select({ type: 'link', id })
  }
  const onMove = (e: React.PointerEvent): void => {
    const p = viewPoint(svgRef.current, e)
    if (linkFrom) setPointer(p)
    const d = dragRef.current
    if (!d || !p) return
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return
    d.moved = true
    const t = toTopo(p, win)
    setDrag({ id: d.id, x: clamp(Math.round(t.x), ...lim.x), y: clamp(Math.round(t.y), ...lim.y) })
  }
  const endDrag = (): void => {
    const d = dragRef.current
    dragRef.current = null
    if (d?.moved && drag) void store.moveRouter(drag.id, drag.x, drag.y)
    setDrag(null)
  }
  const onUp = (e: React.PointerEvent): void => {
    endDrag()
    const onNode = (e.target as Element).closest?.('[data-node-id]')
    if (linkFrom && !onNode && pointer && Math.hypot(pointer.x - pos[linkFrom].x, pointer.y - pos[linkFrom].y) > 30) {
      store.cancelLink()
    }
  }
  const background = (e: React.PointerEvent): void => {
    if (!editable) { store.select(null); return }
    if (mode === 'node') {
      const p = viewPoint(svgRef.current, e)
      if (p) {
        const t = toTopo(p, win)
        void store.addRouter(clamp(Math.round(t.x), ...lim.x), clamp(Math.round(t.y), ...lim.y))
      }
    } else if (mode === 'link') store.cancelLink()
    else store.select(null)
  }

  const draft = store.linkDraft
  const best = snap.baseline_path
  const warn = topo.warnings ?? []
  return (
    <section aria-label="Network" className={`flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-panel ${ring(spot === 'canvas')}`}>
      <div className="relative min-h-0 flex-1">
        {editable && <EditorToolbar />}
        {warn.length > 0 && (
          <span className="pointer-events-none absolute right-2 top-2 z-10 rounded-md bg-warn px-2 py-0.5 text-sm font-semibold text-white shadow" role="status">
            ▲ {warn[0]}{warn.length > 1 ? ` (+${warn.length - 1} more)` : ''}
          </span>
        )}
        {toast && (
          <div role="status" aria-live="polite" data-testid="toast"
            className={`pointer-events-none absolute bottom-2 left-1/2 z-20 flex w-[min(34rem,92%)] -translate-x-1/2 items-start gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white opacity-95 shadow-lg ${
              toast.tone === 'bad' ? 'bg-bad' : 'bg-heal'}`}>
            <span className="flex-1">{toast.message}</span>
            <button aria-label="Dismiss" onClick={store.dismissToast} className="focus-ring pointer-events-auto px-1 text-lg leading-none">×</button>
          </div>
        )}
        <svg ref={svgRef} viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} preserveAspectRatio="xMidYMid meet"
          className="h-full w-full" role="img" style={{ cursor: editable ? CURSOR[mode] : 'default' }}
          aria-label="Network topology with the static and self-healing paths"
          onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={endDrag}>
          <rect data-testid="canvas-background" width={VIEW.width} height={VIEW.height} fill="white" rx={8}
            onPointerDown={background} />
          {ghosts.map((g) => g.link && g.a && g.b && (
            <line key={g.key} className="ghost" x1={toView(g.a, win).x} y1={toView(g.a, win).y}
              x2={toView(g.b, win).x} y2={toView(g.b, win).y} stroke={COLORS.down} strokeWidth={9} strokeLinecap="round" />
          ))}
          {topo.links.map((l) => pos[l.a] && pos[l.b] && (
            <LinkRoad key={l.id} link={l} a={pos[l.a]} b={pos[l.b]}
              health={snap.link_health[l.id]?.health ?? 'healthy'}
              selected={sel?.type === 'link' && sel.id === l.id} fresh={fresh.includes(l.id)}
              flash={flash.includes(l.id)} onSelect={() => linkClick(l.id)} />
          ))}
          <Lanes flow="static" links={topo.links} linkIds={snap.static_path.links} pos={pos} />
          <Lanes flow="healing" links={topo.links} linkIds={snap.healing_path?.links ?? []} pos={pos} />
          {topo.links.map((l) => pos[l.a] && pos[l.b] && (
            <LinkLabels key={l.id} link={l} a={pos[l.a]} b={pos[l.b]}
              health={snap.link_health[l.id]?.health ?? 'healthy'} reason={snap.link_health[l.id]?.reason ?? null}
              metric={snap.link_metrics[l.id]} impairment={snap.impairments[l.id]}
              unconfirmedFault={unconfirmed(snap, l.id, false)} dropped={dropped(l.id)} />
          ))}
          {!reduced && <Packets snap={snap} links={topo.links} pos={pos} live={cursor === null} />}
          {linkFrom && pointer && pos[linkFrom] && (
            <line x1={pos[linkFrom].x} y1={pos[linkFrom].y} x2={pointer.x} y2={pointer.y} stroke={COLORS.healing}
              strokeWidth={3} strokeDasharray="8 6" pointerEvents="none" />
          )}
          {ghosts.map((g) => g.node && (
            <circle key={g.key} className="ghost" cx={toView(g.node, win).x} cy={toView(g.node, win).y} r={28}
              fill="#fecaca" stroke={COLORS.down} strokeWidth={3} />
          ))}
          {topo.nodes.map((n) => pos[n.id] && (
            <NodeView key={n.id} id={n.id} at={pos[n.id]}
              role={n.id === topo.source ? 'source' : n.id === topo.destination ? 'destination' : null}
              dead={snap.dead_nodes.includes(n.id)} unconfirmedFault={unconfirmed(snap, n.id, true)}
              selected={sel?.type === 'node' && sel.id === n.id} fresh={fresh.includes(n.id)}
              flash={flash.includes(n.id)}
              dim={!!linkFrom && !canLinkTo(topo, linkFrom, n.id).ok && n.id !== linkFrom}
              target={!!linkFrom && n.id !== linkFrom && canLinkTo(topo, linkFrom, n.id).ok}
              onDown={() => nodeDown(n.id, undefined)} onUp={() => nodeUp(n.id)}
              onPointerDownRaw={(e) => nodeDown(n.id, e)} />
          ))}
          {draft && pos[draft.a] && pos[draft.b] && <LinkDraftPopover at={midpoint(pos[draft.a], pos[draft.b])} />}
        </svg>
      </div>
      <EditorHint />
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
        <li className="ml-auto font-semibold" aria-label="Best path">
          {best.nodes.length
            ? <>Best path: <span className="font-mono">{best.nodes.join('>')}</span>, cost {Math.round(best.cost * 10) / 10}</>
            : <span className="text-bad">No route from {topo.source} to {topo.destination}</span>}
        </li>
      </ul>
    </section>
  )
}
