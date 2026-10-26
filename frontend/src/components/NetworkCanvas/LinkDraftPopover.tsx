import { useEffect, useRef, useState } from 'react'
import { topologyApi } from '../../api/topologyApi'
import type { Impact } from '../../api/types'
import type { Pt } from '../../domain/layout'
import { useSimStore } from '../../store/useSimStore'

/** Latency and bandwidth for a link that is about to be created. Enter confirms, Esc cancels. */
export function LinkDraftPopover({ at }: { at: Pt }) {
  const draft = useSimStore((s) => s.linkDraft)
  const err = useSimStore((s) => s.inlineError)
  const submit = useSimStore((s) => s.submitLinkDraft)
  const cancel = useSimStore((s) => s.cancelLink)
  const [latency, setLatency] = useState(String(draft?.latency ?? ''))
  const [bw, setBw] = useState(String(draft?.bw ?? 100))
  const [preview, setPreview] = useState<Impact | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.select() }, [])
  // dry run: what would this link change? (debounced; invalid input simply shows nothing)
  useEffect(() => {
    if (!draft) return undefined
    const t = setTimeout(() => {
      topologyApi.preview('add_link', { a: draft.a, b: draft.b, latency: Number(latency), bw: Number(bw) })
        .then((r) => setPreview(r.impact)).catch(() => setPreview(null))
    }, 250)
    return () => clearTimeout(t)
  }, [draft, latency, bw])
  if (!draft) return null
  const mine = err?.scope === 'link-draft' ? err : null
  const confirm = (): void => { void submit(Number(latency), Number(bw)) }
  const bad = (field: string): string => (mine?.field === field ? 'border-bad' : 'border-line')
  return (
    <foreignObject x={Math.min(740, Math.max(10, at.x - 120))} y={Math.max(8, at.y - 70)} width={250} height={215}>
      <div role="dialog" aria-label="New link" className="rounded-lg border-2 border-sky-400 bg-white p-2 text-sm text-gray-900 shadow-lg"
        onKeyDown={(e) => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') cancel() }}
        onPointerDown={(e) => e.stopPropagation()}>
        <b>New link {draft.a} – {draft.b}</b>
        <label className="mt-1 flex items-center justify-between gap-2">Latency (ms)
          <input ref={ref} type="number" min={1} max={500} value={latency} onChange={(e) => setLatency(e.target.value)}
            aria-label="Latency in milliseconds" className={`w-20 rounded border px-1 ${bad('latency')}`} autoFocus />
        </label>
        <label className="mt-1 flex items-center justify-between gap-2">Bandwidth (Mbps)
          <input type="number" min={1} max={10000} value={bw} onChange={(e) => setBw(e.target.value)}
            aria-label="Bandwidth in Mbps" className={`w-20 rounded border px-1 ${bad('bw')}`} />
        </label>
        {preview && !mine && (
          <p data-testid="link-preview" className="mt-1 text-gray-700">
            Preview: {preview.healing === 'rerouted' && preview.preferred_after
              ? `best path would become ${preview.preferred_after.nodes.join('>')} (cost ${preview.preferred_after.cost})`
              : 'routes would not change'}.
          </p>
        )}
        {mine && <p role="alert" className="mt-1 text-bad">{mine.message}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <button onClick={cancel} className="rounded border border-line px-2 py-0.5">Cancel</button>
          <button onClick={confirm} className="rounded bg-heal px-2 py-0.5 font-bold text-white">Add link</button>
        </div>
      </div>
    </foreignObject>
  )
}
