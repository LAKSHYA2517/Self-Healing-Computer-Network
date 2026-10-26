import { useState } from 'react'
import { useSimStore } from '../store/useSimStore'

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div role="dialog" aria-label={title} aria-modal className="w-[28rem] max-w-[92vw] rounded-xl bg-panel p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <h2 className="text-lg font-bold">{title}</h2>
        {children}
      </div>
    </div>
  )
}

const btn = 'focus-ring rounded-md border-2 border-line px-3 py-1 font-semibold'
const primary = 'focus-ring rounded-md bg-heal px-3 py-1 font-bold text-white'

function SaveDialog() {
  const save = useSimStore((s) => s.saveTopology)
  const close = useSimStore((s) => s.openDialog)
  const err = useSimStore((s) => s.inlineError)
  const [name, setName] = useState('demo1')
  const mine = err?.scope === 'dialog' ? err : null
  return (
    <Modal title="Save topology as" onClose={() => close(null)}>
      <label className="mt-2 flex items-center gap-2">Name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Topology name"
          onKeyDown={(e) => { if (e.key === 'Enter') void save(name) }}
          className={`flex-1 rounded border px-2 py-1 ${mine ? 'border-bad' : 'border-line'} bg-panel`} />
      </label>
      {mine && <p role="alert" className="mt-1 text-bad">{mine.message}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button className={btn} onClick={() => close(null)}>Cancel</button>
        <button className={primary} onClick={() => void save(name)}>Save</button>
      </div>
    </Modal>
  )
}

function LoadDialog() {
  const list = useSimStore((s) => s.topologies)
  const load = useSimStore((s) => s.loadTopology)
  const close = useSimStore((s) => s.openDialog)
  const current = useSimStore((s) => s.topology?.name)
  return (
    <Modal title="Load topology" onClose={() => close(null)}>
      <ul className="mt-2 max-h-72 overflow-auto">
        {list.map((t) => (
          <li key={t.name}>
            <button onClick={() => void load(t.name)}
              className="focus-ring flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-line/40">
              <span className="font-semibold">{t.name}{t.name === current ? ' (current)' : ''}</span>
              <span className="text-mute">{t.kind === 'default' ? 'default' : t.kind === 'preset' ? 'preset' : 'saved'}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-end"><button className={btn} onClick={() => close(null)}>Cancel</button></div>
    </Modal>
  )
}

/** All modal dialogs: save, load, and the confirmations (delete router, replace unsaved edits). */
export function Dialogs() {
  const dialog = useSimStore((s) => s.dialog)
  const confirm = useSimStore((s) => s.confirm)
  const dismiss = useSimStore((s) => s.dismissConfirm)
  const confirmDelete = useSimStore((s) => s.confirmDelete)
  const cont = useSimStore((s) => s.continueConfirm)
  const saveFirst = useSimStore((s) => s.saveFirst)
  return (
    <>
      {dialog === 'save' && <SaveDialog />}
      {dialog === 'load' && <LoadDialog />}
      {confirm?.kind === 'delete-node' && (
        <Modal title={`Delete router ${confirm.id}?`} onClose={dismiss}>
          <p className="mt-2">{confirm.text}</p>
          <p className="mt-1 text-mute">This is a planned change, not a fault. You can undo it.</p>
          <div className="mt-3 flex justify-end gap-2">
            <button className={btn} onClick={dismiss}>Cancel</button>
            <button className="focus-ring rounded-md bg-bad px-3 py-1 font-bold text-white" autoFocus
              onClick={() => void confirmDelete()}>Delete router</button>
          </div>
        </Modal>
      )}
      {confirm?.kind === 'scenario' && (
        <Modal title="Unsaved topology edits" onClose={dismiss}>
          <p className="mt-2">Running this scenario loads the '{confirm.needs}' topology and replaces your unsaved edits.</p>
          <div className="mt-3 flex justify-end gap-2">
            <button className={btn} onClick={dismiss}>Cancel</button>
            <button className={btn} onClick={saveFirst}>Save current first</button>
            <button className={primary} autoFocus onClick={() => void cont()}>Continue</button>
          </div>
        </Modal>
      )}
      {confirm?.kind === 'load' && (
        <Modal title="Replace unsaved edits?" onClose={dismiss}>
          <p className="mt-2">Loading '{confirm.name}' replaces your unsaved edits. You can undo it right afterwards.</p>
          <div className="mt-3 flex justify-end gap-2">
            <button className={btn} onClick={dismiss}>Cancel</button>
            <button className={btn} onClick={saveFirst}>Save current first</button>
            <button className={primary} autoFocus onClick={() => void cont()}>Continue</button>
          </div>
        </Modal>
      )}
    </>
  )
}
