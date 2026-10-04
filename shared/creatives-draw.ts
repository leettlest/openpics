/**
 * Drawing maths for the Creatives surface.
 *
 * Kept out of the component so it can be tested under plain Node: the renderer
 * only supplies pointer coordinates and reads back a string, so everything
 * between those two points is verifiable without a DOM or a canvas.
 */

export type Tool = 'brush' | 'eraser' | 'pen'

/** A fixed artboard, so an exported file is identical to what the screen showed. */
export const VIEW_W = 800
export const VIEW_H = 600
export const PAPER = '#ffffff'

/** Below this distance in artboard units, a pointer sample is treated as jitter. */
export const MIN_SAMPLE_DISTANCE = 1.5

export type Point = { x: number; y: number }

export type Stroke = {
  id: number
  d: string
  color: string
  width: number
  /** Percent, 10-100, matching what the slider shows. */
  opacity: number
  tool: Tool
}

const round = (value: number): string => value.toFixed(2)

/**
 * A hand-drawn line as quadratic segments through the midpoints of consecutive
 * samples. Cheaper than a spline and, for the short samples a pointer produces,
 * indistinguishable from one.
 */
export function buildPath(points: Point[]): string {
  const first = points[0]
  if (!first) return ''
  const head = `M ${round(first.x)} ${round(first.y)}`
  if (points.length === 1) {
    // A round cap on a zero-length segment paints a dot, so one tap still marks the page.
    return `${head} L ${round(first.x)} ${round(first.y)}`
  }

  let d = head
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]
    const next = points[index + 1]
    if (!current || !next) continue
    const midX = (current.x + next.x) / 2
    const midY = (current.y + next.y) / 2
    d += ` Q ${round(current.x)} ${round(current.y)} ${round(midX)} ${round(midY)}`
  }

  const last = points[points.length - 1]
  if (last) d += ` L ${round(last.x)} ${round(last.y)}`
  return d
}

/** True when a new sample is far enough from the last one to be worth recording. */
export function isMeaningfulMove(from: Point | undefined, to: Point): boolean {
  if (!from) return true
  return Math.hypot(to.x - from.x, to.y - from.y) >= MIN_SAMPLE_DISTANCE
}

/** The eraser paints the paper colour, which is honest on an opaque artboard. */
export function strokeInk(stroke: Stroke): string {
  return stroke.tool === 'eraser' ? PAPER : stroke.color
}

export function strokeOpacity(stroke: Stroke): number {
  return Math.min(1, Math.max(0, stroke.opacity / 100))
}

/** The exact markup both exports are built from, so SVG and PNG cannot drift apart. */
export function serializeSvg(strokes: Stroke[]): string {
  const body = strokes
    .map((stroke) =>
      [
        `  <path d="${stroke.d}"`,
        'fill="none"',
        `stroke="${strokeInk(stroke)}"`,
        `stroke-width="${stroke.width}"`,
        `stroke-opacity="${strokeOpacity(stroke).toFixed(2)}"`,
        'stroke-linecap="round"',
        'stroke-linejoin="round" />',
      ].join(' ')
    )
    .join('\n')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="${VIEW_W}" height="${VIEW_H}">`,
    `  <rect width="${VIEW_W}" height="${VIEW_H}" fill="${PAPER}" />`,
    body,
    '</svg>',
    '',
  ].join('\n')
}

/** Maps a pointer position in a rendered box back into artboard coordinates. */
export function toArtboard(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): Point | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  return {
    x: ((clientX - rect.left) / rect.width) * VIEW_W,
    y: ((clientY - rect.top) / rect.height) * VIEW_H,
  }
}