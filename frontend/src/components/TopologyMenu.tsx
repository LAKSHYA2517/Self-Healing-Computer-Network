import { useRef, useState } from 'react'
import { topologyApi } from '../api/topologyApi'
import { useSimStore } from '../store/useSimStore'

/** Header menu: current topology name (with an "edited" marker) and save, load, export, import, reset. */
export function TopologyMenu() {
  const t = useSimStore((s) => s.topology)
  const replay = useSimStore((s) => s.backend.replay)
  const open = useSimStore((s) => s.openDialog)
  const load = useSimStore((s) => s.loadTopology)
  const importFile = useSimStore((s) => s.importTopology)
  const [show, setShow] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  if (!t || replay) return null
  const item = 'focus-ring block w-full rounded px-2 py-1 text-left hover:bg-line/40'
  return (
    <div className="relative" onKeyDown={(e) => { if (e.key === 'Escape') setShow(false) }}>
      <button onClick={() => setShow(!show)} aria-expanded={show} aria-haspopup="menu" aria-label={`Topology ${t.name}${t.dirty ? ", edited" : ""}`} title="Topology menu"
        className="focus-ring max-w-[16rem] truncate rounded-md border border-line bg-panel px-2 py-1 text-sm font-semibold hover:bg-line/40">
        <span className="hidden 2xl:inline">Topology: </span>{t.name}{t.dirty ? <span className="ml-1 text-warn">● edited</span> : ''} ▾
      </button>
      {show && (
        <div role="menu" className="absolute left-0 top-full z-40 mt-1 w-56 rounded-lg border border-line bg-panel p-1 shadow-lg"
          onClick={() => setShow(false)}>
          <button role="menuitem" className={item} onClick={() => open('save')}>Save as…</button>
          <button role="menuitem" className={item} onClick={() => open('load')}>Load…</button>
          <a role="menuitem" className={item} href={topologyApi.exportUrl} download>Export JSON</a>
          <button role="menuitem" className={item} onClick={() => file.current?.click()}>Import JSON…</button>
          <button role="menuitem" className={item} onClick={() => void load('default')}>Reset to default</button>
        </div>
      )}
      <input ref={file} type="file" accept="application/json,.json" className="sr-only" aria-label="Import topology file"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = '' }} />
    </div>
  )
}
