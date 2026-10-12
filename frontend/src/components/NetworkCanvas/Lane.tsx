import { AnimatePresence, motion } from 'framer-motion'
import type { Flow, TopoLink } from '../../api/types'
import { COLORS } from '../../domain/colors'
import { laneOffset, type Pt } from '../../domain/layout'

interface Props {
  flow: Flow
  links: TopoLink[]
  linkIds: string[]
  pos: Record<string, Pt>
}

export const SIDE: Record<Flow, 1 | -1> = { static: 1, healing: -1 }

/** Coordinates of one flow's lane on one link: parallel to the link, offset to the flow's side. */
export function laneSegment(l: TopoLink, pos: Record<string, Pt>, flow: Flow): [Pt, Pt] {
  const o = laneOffset(pos[l.a], pos[l.b], SIDE[flow])
  return [{ x: pos[l.a].x + o.x, y: pos[l.a].y + o.y }, { x: pos[l.b].x + o.x, y: pos[l.b].y + o.y }]
}

/** Lanes of one flow. Healing lanes fade out and draw in on a route change. */
export function Lanes({ flow, links, linkIds, pos }: Props) {
  const used = links.filter((l) => linkIds.includes(l.id) && pos[l.a] && pos[l.b])
  const color = flow === 'static' ? COLORS.static : COLORS.healing
  return (
    <g pointerEvents="none" aria-hidden>
      <AnimatePresence>
        {used.map((l) => {
          const [p, q] = laneSegment(l, pos, flow)
          return (
            <motion.path key={`${flow}-${l.id}`} d={`M ${p.x} ${p.y} L ${q.x} ${q.y}`} fill="none"
              stroke={color} strokeWidth={flow === 'static' ? 4 : 4.5} strokeLinecap="butt"
              strokeDasharray={flow === 'static' ? '11 7' : undefined}
              initial={{ opacity: 0, pathLength: flow === 'healing' ? 0 : 1 }}
              animate={{ opacity: 1, pathLength: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }} />
          )
        })}
      </AnimatePresence>
    </g>
  )
}
