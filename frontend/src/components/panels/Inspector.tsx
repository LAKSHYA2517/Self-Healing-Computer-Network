import { useEffect, useState } from 'react'
import { incidentLinks, neighborsOf } from '../../domain/editing'
import { useDisplayed } from '../../hooks'
import { useSimStore } from '../../store/useSimStore'


function Field({ label, value, onApply, error, disabled, min, max }: {
  label: string; value: number; onApply: (v: number) => Promise<boolean>; error?: string | null
  disabled: boolean; min: number; max: number
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const apply = (): void => {
    const v = Number(text)
    if (text.trim() === '' || v === value) { setText(String(value)); return }
    void onApply(v).then((ok) => { if (!ok) setText(String(value)) })
  }
  return (
    <label className="flex items-center gap-2">
      <span className="font-semibold">{label}</span>
      <input type="number" value={text} min={min} max={max} disabled={disabled} aria-label={label}
        onChange={(e) => setText(e.target.value)} onBlur={apply}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
        className={`w-20 rounded border px-1 py-0.5 ${error ? 'border-bad' : 'border-line'} bg-panel`} />
      {error && <span role="alert" className="text-bad">{error}</span>}
    </label>
  )
}

function Btn({ children, onClick, tone, disabled, title }: {
  children: React.ReactNode; onClick: () => void; tone?: 'bad'; disabled?: boolean; title?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`focus-ring rounded-md border-2 px-2 py-0.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === 'bad' ? 'border-bad text-bad' : 'border-line'}`}>
      {children}
    </button>
  )
}

/** Details and editing of the selected router or link. Everything here is also possible without dragging. */
export function Inspector() {
  const snap = useDisplayed()
  const s = useSimStore()
  const t = s.topology
  const sel = s.selected
  const err = s.inlineError?.scope === 'inspector' ? s.inlineError : null
  const editable = !s.backend.replay
  if (!snap || !t) return null
  if (!sel) return <p className="text-mute">Click a router or link on the network to inspect and edit it.</p>

  if (sel.type === 'node') {
    const n = t.nodes.find((x) => x.id === sel.id)
    if (!n) return null
    const dead = snap.dead_nodes.includes(n.id)
    const role = n.id === t.source ? 'Source' : n.id === t.destination ? 'Destination' : null
    const neighbors = neighborsOf(t, n.id)
    return (
      <div className="flex flex-wrap items-start gap-x-6 gap-y-1">
        <div>
          <p className="text-base font-bold">Router {n.id}{role ? ` · ${role}` : ''}</p>
          <p>Status: <b>{dead ? 'DOWN (all its links stopped responding)' : 'Up'}</b></p>
          <p>Links: {incidentLinks(t, n.id).length} · Neighbors: {neighbors.length ? neighbors.join(', ') : 'none'}</p>
          <p>{[snap.static_path, snap.healing_path].some((p) => p?.nodes.includes(n.id))
            ? 'Carries traffic of at least one flow.' : 'No flow passes through it right now.'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Btn disabled={!editable || n.id === t.source}
            onClick={() => void s.setEndpoints(n.id, t.destination === n.id ? t.source : t.destination)}>
            Set as source
          </Btn>
          <Btn disabled={!editable || n.id === t.destination}
            onClick={() => void s.setEndpoints(t.source === n.id ? t.destination : t.source, n.id)}>
            Set as destination
          </Btn>
          <Btn tone="bad" disabled={!editable} onClick={() => s.requestDeleteRouter(n.id)}
            title="Planned removal: the controller knows at once, so traffic is rerouted with no loss.">
            Delete router
          </Btn>
        </div>
        {err && <p role="alert" className="w-full text-bad">{err.message}</p>}
      </div>
    )
  }

  const l = t.links.find((x) => x.id === sel.id)
  if (!l) return null
  const m = snap.link_metrics[l.id]
  const h = snap.link_health[l.id]
  const failed = snap.failed_links.includes(l.id)
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-1">
      <div>
        <p className="text-base font-bold">Link {l.id} · {l.a} – {l.b}</p>
        <p>Health: <b>{h?.health === 'down' ? 'DOWN' : h?.health === 'degraded' ? `Degraded (${h.reason})` : 'Healthy'}</b>
          {h && h.since > 0 ? ` since t=${h.since}` : ''}</p>
        <p>Latency {!m ? 'no data yet' : m.latency_ms === null ? 'no response' : `${m.latency_ms.toFixed(1)} ms`} ·
          loss {m ? `${m.loss_pct.toFixed(1)}%` : 'no data yet'} · load {m ? `${Math.round(m.util_pct)}%` : 'no data yet'}</p>
      </div>
      <div className="flex flex-col gap-1">
        <Field label="Latency (ms)" value={l.latency} disabled={!editable} min={t.limits?.latency[0] ?? 1}
          max={t.limits?.latency[1] ?? 500} error={err?.field === 'latency' ? err.message : null}
          onApply={(v) => s.updateLink(l.id, { latency: v })} />
        <Field label="Bandwidth (Mbps)" value={l.bw} disabled={!editable} min={t.limits?.bw[0] ?? 1}
          max={t.limits?.bw[1] ?? 10000} error={err?.field === 'bw' ? err.message : null}
          onApply={(v) => s.updateLink(l.id, { bw: v })} />
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex gap-2">
          <Btn disabled={!editable} onClick={() => void s.call((b) => b.inject(failed ? 'restore' : 'fail', 'link', l.id))}
            title="A fault: the system has to discover it from metrics, which costs a couple of ticks of loss.">
            {failed ? 'Restore link' : 'Fail link'}
          </Btn>
          <Btn tone="bad" disabled={!editable} onClick={() => void s.deleteLink(l.id)}
            title="A planned change: the controller knows at once, so self-healing reroutes with no loss.">
            Delete link
          </Btn>
        </div>
        <p className="text-mute">Fail = a fault to detect · Delete = a planned change</p>
      </div>
      {err && !err.field && <p role="alert" className="w-full text-bad">{err.message}</p>}
    </div>
  )
}
