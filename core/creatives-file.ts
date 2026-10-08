/**
 * The drawing on disk, shared by the app and the MCP server.
 *
 * The running app persists strokes to `creatives.json` in the user-data
 * directory, and an agent driving OpenPics over MCP edits the same file - that
 * file is how the two meet. Everything here works on a directory passed in, so
 * the app hands its user-data dir, the MCP server hands `dataDir()` (which
 * honours `OPENPICS_DATA_DIR`), and tests hand a temp dir.
 *
 * Agent strokes carry negative ids. The canvas only ever mints positive ones,
 * so the two sides cannot collide on an id no matter how they interleave.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Stroke, Tool } from '../shared/creatives-draw'

export type { Stroke }

export const CREATIVES_FILE = 'creatives.json'
/** More strokes than a person will ever draw; the rest is not loaded. */
export const MAX_SAVED_STROKES = 2000
/** Past this the file is not written: a corrupt giant must not evict a good save. */
const MAX_SAVED_BYTES = 2 * 1024 * 1024

const TOOLS: readonly string[] = [
  'brush', 'pencil', 'marker', 'highlighter', 'airbrush', 'neon', 'eraser', 'pen',
  'line', 'rect', 'ellipse', 'arrow', 'text', 'fill', 'eyedropper', 'select'
]

/** A stroke shaped like one the canvas could have made, not just any object. */
export function isDrawingStroke(value: unknown): value is Stroke {
  if (!value || typeof value !== 'object') return false
  const stroke = value as Record<string, unknown>
  if (
    typeof stroke.id !== 'number' ||
    !Number.isFinite(stroke.id) ||
    typeof stroke.d !== 'string' ||
    typeof stroke.color !== 'string' ||
    typeof stroke.width !== 'number' ||
    !Number.isFinite(stroke.width) ||
    typeof stroke.opacity !== 'number' ||
    !Number.isFinite(stroke.opacity) ||
    typeof stroke.tool !== 'string' ||
    !(TOOLS as readonly string[]).includes(stroke.tool as Tool)
  ) {
    return false
  }
  // Text carries no path data; everything else must have drawn something.
  if (stroke.d === '' && stroke.kind !== 'text') return false
  if (stroke.kind !== undefined && !['path', 'shape', 'text', 'dots'].includes(String(stroke.kind))) return false
  if (stroke.dash !== undefined && !['solid', 'dash', 'dot'].includes(String(stroke.dash))) return false
  if (stroke.fill !== undefined && stroke.fill !== null && typeof stroke.fill !== 'string') return false
  if (stroke.text !== undefined && typeof stroke.text !== 'string') return false
  if (stroke.visible !== undefined && typeof stroke.visible !== 'boolean') return false
  for (const key of ['blur', 'fontSize', 'dx', 'dy'] as const) {
    if (stroke[key] !== undefined && (typeof stroke[key] !== 'number' || !Number.isFinite(stroke[key] as number))) {
      return false
    }
  }
  return true
}

function file(dir: string): string {
  return join(dir, CREATIVES_FILE)
}

/** The saved drawing, or null when there is none or it is not one anymore. */
export function loadDrawing(dir: string): Stroke[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file(dir), 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const strokes = parsed.filter(isDrawingStroke).slice(0, MAX_SAVED_STROKES)
  return strokes.length > 0 ? strokes : null
}

/**
 * Stores the drawing. Failures are silent and oversize saves are dropped: a
 * broken disk or a corrupt giant must not take drawing down with it.
 */
export function saveDrawing(dir: string, strokes: readonly Stroke[]): boolean {
  const text = JSON.stringify(strokes.slice(0, MAX_SAVED_STROKES))
  if (text.length > MAX_SAVED_BYTES) return false
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file(dir), text, 'utf8')
    return true
  } catch {
    return false
  }
}

/** Appends strokes and returns the whole drawing. Negative ids stay negative. */
export function addStrokes(dir: string, strokes: readonly Stroke[]): Stroke[] {
  const current = loadDrawing(dir) ?? []
  const next = [...current, ...strokes].slice(-MAX_SAVED_STROKES)
  saveDrawing(dir, next)
  return next
}

/** Removes the last stroke and returns it, or null when there is nothing. */
export function undoStroke(dir: string): Stroke | null {
  const current = loadDrawing(dir)
  if (!current || current.length === 0) return null
  const undone = current[current.length - 1]!
  saveDrawing(dir, current.slice(0, -1))
  return undone
}

/**
 * An agent-side stroke id that no live stroke is using.
 *
 * Lives here rather than in the MCP server because it is a property of the
 * drawing, not of the transport, and because a rule this easy to get subtly wrong
 * is only worth trusting if a test can reach it.
 *
 * Ids descend below zero, which is what keeps them out of the canvas's positive
 * namespace. Two mistakes are easy to make here and both silently destroy work:
 * seeding the minimum at zero and subtracting once returns -1 whenever every live
 * id happens to be non-negative, so two consecutive calls collide and the second
 * stroke overwrites the first; and taking the minimum over positive ids only
 * ignores the negatives already handed out, so after an `undoStroke` removes the
 * lowest one the next call walks back onto an id still in use.
 *
 * So: the true minimum over every live id, stepped one below it, with zero as the
 * starting floor only so an empty drawing yields -1 rather than -Infinity.
 */
export function nextAgentStrokeId(strokes: readonly Stroke[]): number {
  let lowest = 0
  for (const stroke of strokes) lowest = Math.min(lowest, stroke.id)
  return lowest - 1
}

/** Removes one stroke by id. Returns true when something was removed. */
export function deleteStroke(dir: string, id: number): boolean {
  const current = loadDrawing(dir)
  if (!current) return false
  const next = current.filter((stroke) => stroke.id !== id)
  if (next.length === current.length) return false
  saveDrawing(dir, next)
  return true
}

/** Empties the drawing. */
export function clearDrawing(dir: string): void {
  saveDrawing(dir, [])
}
