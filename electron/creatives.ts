import { app } from 'electron'
import { loadDrawing, saveDrawing, type Stroke } from '../core/creatives-file'

export type { Stroke }

/**
 * Restart-safe drawing persistence, app side.
 *
 * Strokes live in component state so tab switches never lose them, but state
 * dies with the process. The file itself is owned by core/creatives-file.ts,
 * which the MCP server shares - this module only says where the app's copy
 * lives. Validation lives there too, so a corrupt file reads back as null
 * rather than as shapes that crash the canvas.
 */

function dir(): string {
  return app.getPath('userData')
}

/** The saved drawing, or null when there is none or it is not one anymore. */
export function loadCreatives(): Stroke[] | null {
  return loadDrawing(dir())
}

/** Stores the drawing. Failures are silent: losing a backup must not break drawing. */
export function saveCreatives(strokes: readonly Stroke[]): void {
  saveDrawing(dir(), strokes)
}
