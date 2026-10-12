import { GLOSSARY } from '../domain/glossary'
import { useSimStore } from '../store/useSimStore'

const KEYS: [string, string][] = [
  ['Space', 'Next milestone (guided demo)'], ['N', 'Step one tick'], ['R', 'Run the selected scenario'],
  ['P', 'Pause or resume'], ['G', 'Start or end the guided demo'], ['?', 'Show or hide this help'],
]

export function HelpOverlay() {
  const open = useSimStore((s) => s.helpOpen)
  const toggle = useSimStore((s) => s.toggleHelp)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog"
      aria-label="Help" onClick={toggle}>
      <div className="max-h-[90vh] w-[40rem] overflow-auto rounded-xl bg-panel p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Keyboard shortcuts</h2>
          <button onClick={toggle} className="focus-ring rounded px-2 text-lg">×</button>
        </div>
        <table className="mt-2 w-full text-left">
          <tbody>
            {KEYS.map(([k, d]) => (
              <tr key={k}><td className="w-24 py-0.5"><kbd className="rounded border border-line px-2 font-mono">{k}</kbd></td><td>{d}</td></tr>
            ))}
          </tbody>
        </table>
        <h2 className="mt-4 text-lg font-bold">Words used on this screen</h2>
        <dl className="mt-1">
          {Object.entries(GLOSSARY).map(([k, v]) => (
            <div key={k} className="py-0.5"><dt className="inline font-bold capitalize">{k}: </dt><dd className="inline">{v}</dd></div>
          ))}
        </dl>
      </div>
    </div>
  )
}
