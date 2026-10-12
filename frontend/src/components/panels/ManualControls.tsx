import { useState } from 'react'
import { useSimStore } from '../../store/useSimStore'

function Btn({ children, onClick, disabled, tone }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; tone?: 'bad' | 'ok'
}) {
  const color = tone === 'bad' ? 'border-bad text-bad' : tone === 'ok' ? 'border-ok text-ok' : 'border-line'
  return (
    <button onClick={onClick} disabled={disabled}
      className={`focus-ring rounded-md border-2 px-3 py-1 font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${color}`}>
      {children}
    </button>
  )
}

export function ManualControls() {
  const s = useSimStore()
  const topo = s.topology
  const [loss, setLoss] = useState(25)
  const [load, setLoad] = useState(95)
  const replay = s.backend.replay
  if (!topo) return null
  const target = s.selected ?? { type: 'link' as const, id: topo.links.find((l) => l.id === 'L8')?.id ?? topo.links[0].id }
  const isLink = target.type === 'link'
  const choose = (value: string): void => {
    const [type, id] = value.split(':')
    s.select({ type: type as 'link' | 'node', id })
  }
  return (
    <div className="flex h-full flex-wrap content-start items-start gap-x-6 gap-y-2 overflow-auto">
      {replay && (
        <p className="w-full rounded bg-amber-100 p-1 text-amber-900">
          Replay mode plays a recording, so faults cannot be injected. Use Run, Pause and Step.
        </p>
      )}
      <label className="flex items-center gap-2">
        <span className="font-semibold">Target</span>
        <select className="focus-ring rounded-md border border-line bg-panel px-2 py-1" value={`${target.type}:${target.id}`}
          onChange={(e) => choose(e.target.value)} aria-label="Target element">
          <optgroup label="Links">
            {topo.links.map((l) => <option key={l.id} value={`link:${l.id}`}>{l.id} ({l.a}-{l.b})</option>)}
          </optgroup>
          <optgroup label="Routers">
            {topo.nodes.map((n) => <option key={n.id} value={`node:${n.id}`}>Router {n.id}</option>)}
          </optgroup>
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Btn tone="bad" disabled={replay} onClick={() => void s.call((b) => b.inject('fail', target.type, target.id))}>
          Break it
        </Btn>
        <Btn tone="ok" disabled={replay} onClick={() => void s.call((b) => b.inject('restore', target.type, target.id))}>
          Fix it
        </Btn>
        <Btn onClick={() => void s.reset()}>Reset</Btn>
      </div>
      <div className="flex items-center gap-2">
        <Btn disabled={replay || !isLink} onClick={() => void s.call((b) => b.degrade(target.id, loss))}>Degrade it</Btn>
        <label className="flex items-center gap-1">
          loss <input type="range" min={5} max={50} value={loss} onChange={(e) => setLoss(Number(e.target.value))}
            className="focus-ring" aria-label="Packet loss percent" /> <b className="w-10">{loss}%</b>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Btn disabled={replay || !isLink} onClick={() => void s.call((b) => b.congest(target.id, load))}>Congest it</Btn>
        <label className="flex items-center gap-1">
          load <input type="range" min={70} max={100} value={load} onChange={(e) => setLoad(Number(e.target.value))}
            className="focus-ring" aria-label="Link load percent" /> <b className="w-10">{load}%</b>
        </label>
      </div>
      <div className="flex items-center gap-2 border-l border-line pl-4">
        <Btn onClick={s.saveRecording}>Save recording</Btn>
        <label className="focus-ring cursor-pointer rounded-md border-2 border-line px-3 py-1 font-semibold">
          Load recording
          <input type="file" accept="application/json,.json" className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void s.loadRecordingFile(f) }} />
        </label>
      </div>
      {!isLink && <p className="w-full text-mute">Degrade and Congest apply to links only. Pick a link as the target.</p>}
    </div>
  )
}
