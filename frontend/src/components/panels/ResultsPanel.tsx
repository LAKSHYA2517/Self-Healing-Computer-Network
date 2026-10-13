import type { Snapshot, Summary } from '../../api/types'
import { COLORS } from '../../domain/colors'
import { useDisplayed } from '../../hooks'
import { useSimStore } from '../../store/useSimStore'
import { Tip } from '../Tip'

function Pair({ title, a, b, unit, max }: { title: React.ReactNode; a: number; b: number; unit: string; max: number }) {
  const w = (v: number): string => (v <= 0 ? '0%' : `${Math.max(2, (v / Math.max(1, max)) * 100)}%`)
  return (
    <div className="min-w-0 flex-1">
      <p className="text-sm font-bold">{title}</p>
      <p className="text-2xl font-extrabold leading-tight">
        <span style={{ color: COLORS.static }}>{a}{unit}</span>
        <span className="mx-2 text-base font-semibold text-mute">vs</span>
        <span style={{ color: COLORS.healing }}>{b}{unit}</span>
      </p>
      <div className="mt-1 space-y-1" aria-hidden>
        <div className="h-2 rounded" style={{ width: w(a), background: COLORS.static }} />
        <div className="h-2 rounded" style={{ width: w(b), background: COLORS.healing }} />
      </div>
      <p className="text-sm text-mute">orange static · blue self-healing</p>
    </div>
  )
}

/** One plain sentence that says what the numbers mean. */
export function verdict(s: Summary): string {
  const { static: st, healing: he } = s
  if (st.lost === 0 && he.lost === 0) {
    return 'No packets were lost: the fault was not on the path either flow uses, so no reroute was needed.'
  }
  const fewer = st.lost > 0 ? Math.round(((st.lost - he.lost) / st.lost) * 100) : 0
  const avail = `${he.availability_pct}% available instead of ${st.availability_pct}%`
  if (fewer > 0) {
    return `Self-healing lost ${fewer}% fewer packets (${he.lost} instead of ${st.lost}) and stayed ${avail}.`
  }
  return `Both flows lost similar traffic (${st.lost} vs ${he.lost}); self-healing was ${avail}.`
}

const CSV_HEADER = 'tick,flow,path,delivery_pct,delay_ms,throughput_mbps,lost_packets,available'

/** Per-tick rows in the same layout as /api/export, for replay mode where there is no server. */
export function csvFrom(snap: Snapshot): string {
  const rows = [...snap.series.healing, ...snap.series.static].sort((a, b) => a.tick - b.tick)
  const lines = rows.map((r) => [r.tick, r.flow, r.path?.join('-') ?? '', r.delivery_pct, r.delay_ms ?? '',
    r.throughput_mbps, r.lost_packets, r.available ? 1 : 0].join(','))
  return [CSV_HEADER, ...lines].join('\n') + '\n'
}

function downloadCsv(snap: Snapshot): void {
  const url = URL.createObjectURL(new Blob([csvFrom(snap)], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'ticks.csv'
  a.click()
  URL.revokeObjectURL(url)
}

export function ResultsPanel() {
  const summary = useSimStore((s) => s.summary)
  const snap = useDisplayed()
  const backend = useSimStore((s) => s.backend)
  const setTab = useSimStore((s) => s.setTab)
  if (!summary) {
    return (
      <div className="flex h-full flex-col items-start justify-center gap-2">
        <p>Results appear when a scenario ends. Run one with <b>▶ Run</b> or the guided demo.</p>
        {snap && snap.tick > 0 && (
          <button className="focus-ring rounded-md border border-line px-3 py-1 font-semibold"
            onClick={() => void backend.summary().then((s) => useSimStore.setState({ summary: s })).catch(() => setTab('results'))}>
            Show results so far
          </button>
        )}
      </div>
    )
  }
  const { static: st, healing: he } = summary
  const f = he.faults[0]
  const download = backend.replay && snap ? (
    <button onClick={() => downloadCsv(snap)}
      className="focus-ring shrink-0 rounded-md border-2 border-line px-3 py-1 font-semibold">⬇ Download CSV</button>
  ) : (
    <a href="/api/export" download="ticks.csv"
      className="focus-ring shrink-0 rounded-md border-2 border-line px-3 py-1 font-semibold">⬇ Download CSV</a>
  )
  return (
    <div className="flex h-full flex-col gap-1 overflow-auto">
      <div className="flex items-center justify-between gap-3">
        <p className="text-base font-bold" role="status">{verdict(summary)}</p>
        {download}
      </div>
      <div className="flex gap-6">
        <Pair title="Packets lost" a={st.lost} b={he.lost} unit="" max={Math.max(st.lost, he.lost, 1)} />
        <Pair title={<Tip term="availability">Availability</Tip>} a={st.availability_pct} b={he.availability_pct}
          unit="%" max={100} />
        <table className="min-w-[15rem] flex-1 text-left">
          <tbody>
            <tr><th className="font-semibold">Route changes</th><td>{st.route_changes} vs {he.route_changes}</td></tr>
            <tr><th className="font-semibold">Outage ticks</th><td>{st.outage_ticks} vs {he.outage_ticks}</td></tr>
            <tr><th className="font-semibold"><Tip term="detection">Detection</Tip> time</th>
              <td>{f?.detection_ticks != null ? `${f.detection_ticks} ticks` : '–'}</td></tr>
            <tr><th className="font-semibold">Recovery time</th>
              <td>{f?.recovery_ticks != null ? `${f.recovery_ticks} ticks` : 'no reroute needed'}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
