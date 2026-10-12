import type { TopoNode } from '../api/types'

export interface Pt { x: number; y: number }

export const VIEW = { width: 1000, height: 430 }
const MARGIN = { left: 80, right: 80, top: 50, bottom: 62 }
export const LANE_PX = 5

/** Scale node positions into the viewBox (separately per axis, so the drawing fills the width). */
export function fitNodes(nodes: TopoNode[], view = VIEW): Record<string, Pt> {
  const xs = nodes.map((n) => n.x)
  const ys = nodes.map((n) => n.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const sx = (view.width - MARGIN.left - MARGIN.right) / Math.max(1, maxX - minX)
  const sy = (view.height - MARGIN.top - MARGIN.bottom) / Math.max(1, maxY - minY)
  const out: Record<string, Pt> = {}
  for (const n of nodes) out[n.id] = { x: MARGIN.left + (n.x - minX) * sx, y: MARGIN.top + (n.y - minY) * sy }
  return out
}

/**
 * Perpendicular offset for one lane of a link, measured against the link's own a->b
 * direction so every flow keeps the same side regardless of travel direction.
 * side = +1 for one flow, -1 for the other.
 */
export function laneOffset(a: Pt, b: Pt, side: 1 | -1, px = LANE_PX): Pt {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { x: (-dy / len) * px * side, y: (dx / len) * px * side }
}

export const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
