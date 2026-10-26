import { useSimStore, type EditMode } from '../../store/useSimStore'

const MODES: { id: EditMode; label: string; key: string; icon: string; hint: string }[] = [
  { id: 'select', label: 'Select / Move', key: 'V', icon: '↖', hint: 'Click a router or link to inspect it. Drag a router to move it.' },
  { id: 'node', label: 'Add router', key: 'A', icon: '◯', hint: 'Click empty space to place a router.' },
  { id: 'link', label: 'Add link', key: 'L', icon: '⟷', hint: 'Drag from one router to another to connect them (or click one, then the other).' },
  { id: 'delete', label: 'Delete', key: 'X', icon: '🗑', hint: 'Click a link or router to delete it. This is a planned change, not a fault.' },
]

function Tool({ on, active, disabled, title, children, onClick }: {
  on?: boolean; active?: boolean; disabled?: boolean; title: string; children: React.ReactNode; onClick: () => void
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} aria-label={title} aria-pressed={active ?? on}
      className={`focus-ring flex h-8 min-w-8 items-center justify-center rounded-md border px-1.5 text-sm font-semibold
        disabled:cursor-not-allowed disabled:opacity-40 ${active
        ? 'border-heal bg-heal text-white' : 'border-line bg-panel hover:bg-line/40'}`}>
      {children}
    </button>
  )
}

/** Floating editing tools on the canvas: modes, undo/redo, fit view. */
export function EditorToolbar() {
  const mode = useSimStore((s) => s.editMode)
  const setMode = useSimStore((s) => s.setMode)
  const t = useSimStore((s) => s.topology)
  const undo = useSimStore((s) => s.undo)
  const redo = useSimStore((s) => s.redo)
  const fit = useSimStore((s) => s.fit)
  return (
    <div role="toolbar" aria-label="Topology editor"
      className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded-lg border border-line bg-panel/95 p-1 shadow">
      {MODES.map((m) => (
        <Tool key={m.id} active={mode === m.id} title={`${m.label} (${m.key})`} onClick={() => setMode(m.id)}>
          <span aria-hidden>{m.icon}</span>
          {mode === m.id && <span className="ml-1 hidden xl:inline">{m.label}</span>}
        </Tool>
      ))}
      <span aria-hidden className="mx-1 h-5 w-px bg-line" />
      <Tool title="Undo (Ctrl+Z)" disabled={!t?.can_undo} onClick={() => void undo()}>↶</Tool>
      <Tool title="Redo (Ctrl+Y)" disabled={!t?.can_redo} onClick={() => void redo()}>↷</Tool>
      <Tool title="Fit view" onClick={fit}>⤢</Tool>
    </div>
  )
}

/** What the next click does. Shown only while a tool other than Select is active. */
export function EditorHint() {
  const mode = useSimStore((s) => s.editMode)
  const linkFrom = useSimStore((s) => s.linkFrom)
  if (mode === 'select' && !linkFrom) return null
  const hint = linkFrom ? `Now click the router to connect ${linkFrom} to (Esc cancels).`
    : MODES.find((m) => m.id === mode)?.hint
  return (
    <p role="note" className="border-t border-line bg-heal/10 px-3 py-0.5 text-sm">
      <b>Editing:</b> {hint}
    </p>
  )
}
