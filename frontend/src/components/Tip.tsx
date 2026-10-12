import type { ReactNode } from 'react'
import { GLOSSARY } from '../domain/glossary'

/** Dotted-underlined term with a plain-language tooltip (hover or keyboard focus). */
export function Tip({ term, children }: { term: string; children: ReactNode }) {
  const text = GLOSSARY[term.toLowerCase()]
  if (!text) return <>{children}</>
  return (
    <span className="group relative inline-block cursor-help border-b border-dotted border-mute focus-ring"
      tabIndex={0}>
      {children}
      <span role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-40 mb-1 hidden w-64 rounded-md border
          border-line bg-panel p-2 text-sm font-normal normal-case text-ink shadow-lg
          group-hover:block group-focus:block">
        {text}
      </span>
    </span>
  )
}
