import type { TopoNode } from '../api/types'

export interface Pt { x: number; y: number }

export const VIEW = { width: 1000, height: 430 }
export const MARGIN = { left: 80, right: 80, top: 50, bottom: 62 }
export const LANE_PX = 5

/** The part of topology space that fills the drawing area. It stays fixed while editing (no jumping). */
export interface Win { x0: number; y0: number; x1: number; y1: number }

/** A window around the routers; separate scale per axis so the drawing fills the width. */
export function fitWindow(nodes: TopoNode[]): Win {
  if (nodes.length === 0) return { x0: 0, y0: 0, x1: 1000, y1: 600 }
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y)
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const padX = Math.max(0, (200 - (x1 - x0)) / 2), padY = Math.max(0, (120 - (y1 - y0)) / 2)
  return { x0: x0 - padX, x1: x1 + padX, y0: y0 - padY, y1: y1 + padY }
}

const content = (view = VIEW) => ({
  w: view.width - MARGIN.left - MARGIN.right, h: view.height - MARGIN.top - MARGIN.bottom,
})

/** Topology coordinates to drawing coordinates. */
export function toView(p: Pt, win: Win, view = VIEW): Pt {
  const c = content(view)
  return { x: MARGIN.left + ((p.x - win.x0) / (win.x1 - win.x0)) * c.w,
    y: MARGIN.top + ((p.y - win.y0) / (win.y1 - win.y0)) * c.h }
}

/** Drawing coordinates back to topology coordinates (used for clicks and drags). */
export function toTopo(p: Pt, win: Win, view = VIEW): Pt {
  const c = content(view)
  return { x: win.x0 + ((p.x - MARGIN.left) / c.w) * (win.x1 - win.x0),
    y: win.y0 + ((p.y - MARGIN.top) / c.h) * (win.y1 - win.y0) }
}

/** Positions of all routers in the drawing. */
export function fitNodes(nodes: TopoNode[], view = VIEW, win: Win = fitWindow(nodes)): Record<string, Pt> {
  const out: Record<string, Pt> = {}
  for (const n of nodes) out[n.id] = toView(n, win, view)
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
