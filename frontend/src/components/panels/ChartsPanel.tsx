import { useMemo } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { Snapshot } from '../../api/types'
import { COLORS } from '../../domain/colors'
import { currentTick } from '../../domain/phase'
import { useDisplayed } from '../../hooks'

interface Point { tick: number; healing: number | null; static: number | null }

export function chartData(snap: Snapshot, key: 'delivery_pct' | 'delay_ms'): Point[] {
  const byTick = new Map<number, Point>()
  for (const flow of ['healing', 'static'] as const) {
    for (const r of snap.series?.[flow] ?? []) {
      const p = byTick.get(r.tick) ?? { tick: r.tick, healing: null, static: null }
      p[flow] = r[key]
      byTick.set(r.tick, p)
    }
  }
  return [...byTick.values()].sort((a, b) => a.tick - b.tick)
}

function Chart({ snap, dataKey, title, domain }: {
  snap: Snapshot; dataKey: 'delivery_pct' | 'delay_ms'; title: string; domain: [number, number | 'auto']
}) {
  const data = useMemo(() => chartData(snap, dataKey), [snap, dataKey])
  const cur = currentTick(snap)
  const detect = snap.events.filter((e) => e.kind === 'detect').map((e) => e.tick)
  const detectTicks = [...new Set(detect)].slice(-3)
  const reroutes = snap.route_changes.filter((c) => c.kind === 'reroute').map((c) => c.tick).slice(-3)
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <p className="text-sm font-bold">{title}</p>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 12, bottom: 16, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#d1d5db" />
            <XAxis dataKey="tick" type="number" domain={['dataMin', (max: number) => max + 2]} tick={{ fontSize: 14 }}
              label={{ value: 'Time (ticks)', position: 'insideBottom', offset: -8, fontSize: 14 }} />
            <YAxis domain={domain} width={44} tick={{ fontSize: 14 }} />
            {snap.fault_log.map((f, i) => (
              <ReferenceArea key={`a${i}`} x1={f.tick} x2={f.restored_tick ?? cur} fill="#ef4444" fillOpacity={0.12} />
            ))}
            {detectTicks.map((t) => (
              <ReferenceLine key={`d${t}`} x={t} stroke="#b45309" strokeDasharray="4 3"
                label={{ value: 'detected', fontSize: 14, fill: '#b45309', position: 'insideTopRight' }} />
            ))}
            {reroutes.map((t) => (
              <ReferenceLine key={`r${t}`} x={t} stroke={COLORS.healing}
                label={{ value: 'rerouted', fontSize: 14, fill: COLORS.healing, position: 'insideTopLeft' }} />
            ))}
            <Line type="stepAfter" dataKey="healing" name="Self-healing" stroke={COLORS.healing} strokeWidth={5}
              dot={false} isAnimationActive={false} connectNulls={false} />
            <Line type="stepAfter" dataKey="static" name="Static" stroke={COLORS.static} strokeWidth={3}
              strokeDasharray="9 6" dot={false} isAnimationActive={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

export function ChartsPanel() {
  const snap = useDisplayed()
  if (!snap) return null
  return (
    <div className="flex h-full gap-3">
      <Chart snap={snap} dataKey="delivery_pct" title="Packets delivered (%) over time" domain={[0, 100]} />
      <Chart snap={snap} dataKey="delay_ms" title="End-to-end delay (ms) over time" domain={[0, 'auto']} />
      <ul className="flex shrink-0 flex-col justify-center gap-2 text-sm" aria-label="Chart legend">
        <li className="flex items-center gap-2">
          <svg width="36" height="8" aria-hidden><line x1="0" y1="4" x2="36" y2="4" stroke={COLORS.healing} strokeWidth="5" /></svg>
          Self-healing
        </li>
        <li className="flex items-center gap-2">
          <svg width="36" height="8" aria-hidden><line x1="0" y1="4" x2="36" y2="4" stroke={COLORS.static} strokeWidth="3" strokeDasharray="9 6" /></svg>
          Static
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-4 w-6 bg-red-500/20" />Fault window
        </li>
      </ul>
    </div>
  )
}
