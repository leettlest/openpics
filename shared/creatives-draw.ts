/**
 * Drawing maths for the Creatives surface.
 *
 * Kept out of the component so it can be tested under plain Node: the renderer
 * only supplies pointer coordinates and reads back a string, so everything
 * between those two points is verifiable without a DOM or a canvas.
 */

export type Tool =
  | 'brush'
  | 'pencil'
  | 'marker'
  | 'highlighter'
  | 'airbrush'
  | 'neon'
  | 'eraser'
  | 'pen'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'arrow'
  | 'text'
  | 'fill'
  | 'eyedropper'
  | 'select'

/** Freehand tools lay ink along the pointer; the rest are click or drag gestures. */
export const FREEHAND_TOOLS: readonly Tool[] = ['brush', 'pencil', 'marker', 'highlighter', 'airbrush', 'neon', 'eraser', 'pen']

/** Click-drag shape tools, drawn as one path from anchor to cursor. */
export const SHAPE_TOOLS: readonly Tool[] = ['line', 'rect', 'ellipse', 'arrow']

/** What a stroke is, so rendering, moving and exporting agree. */
export type StrokeKind = 'path' | 'shape' | 'text' | 'dots'

/** Line style for strokes and shape outlines. */
export type Dash = 'solid' | 'dash' | 'dot'

/** Mirror axis for symmetry drawing, across the artboard centre. */
export type Symmetry = 'off' | 'x' | 'y' | 'both'

/** A fixed artboard, so an exported file is identical to what the screen showed. */
export const VIEW_W = 800
export const VIEW_H = 600
export const PAPER = '#ffffff'

/** Below this distance in artboard units, a pointer sample is treated as jitter. */
export const MIN_SAMPLE_DISTANCE = 1.5

export type Point = { x: number; y: number }

export type Stroke = {
  id: number
  /** Missing on old saves, which are all freehand paths. */
  kind?: StrokeKind
  d: string
  color: string
  width: number
  /** Percent, 10-100, matching what the slider shows. */
  opacity: number
  tool: Tool
  /** Line style for strokes and shape outlines. Absent means solid. */
  dash?: Dash
  /** Soft edge in px, 0 for none. Gives the soft brush and the neon glow. */
  blur?: number
  /** Fill colour for closed shapes. Absent means unfilled. */
  fill?: string | null
  /** Text content, for text strokes. */
  text?: string
  /** Font size in artboard units, for text strokes. */
  fontSize?: number
  /** Font family, for text strokes. */
  fontFamily?: string
  /** Move offset in artboard units, applied as a translate. Moving never edits
   * path data, so a moved stroke keeps its exact shape. */
  dx?: number
  dy?: number
  /** Hidden layers stay in the file but leave the screen and the exports. */
  visible?: boolean
}

/** Strokes without a kind are the freehand paths old versions saved. */
export function strokeKind(stroke: Stroke): StrokeKind {
  return stroke.kind ?? 'path'
}

/** False only when explicitly hidden, so old saves without the flag all show. */
export function strokeVisible(stroke: Stroke): boolean {
  return stroke.visible !== false
}

/** Move offset, defaulting to none. */
export function strokeOffset(stroke: Stroke): { dx: number; dy: number } {
  return { dx: stroke.dx ?? 0, dy: stroke.dy ?? 0 }
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

/**
 * The eraser paints the paper colour, which is honest on an opaque artboard -
 * as long as it tracks the paper. The paper is passed in rather than read from
 * a constant so a recoloured background does not strand old eraser marks in
 * white.
 */
export function strokeInk(stroke: Stroke, paper: string = PAPER): string {
  return stroke.tool === 'eraser' ? paper : stroke.color
}

export function strokeOpacity(stroke: Stroke): number {
  return Math.min(1, Math.max(0, stroke.opacity / 100))
}

/** Dash pattern for outlines, or null for a solid line. Dots need round caps. */
export function strokeDasharray(stroke: Stroke): string | null {
  if (stroke.dash === 'dash') return `${round(stroke.width * 3)} ${round(stroke.width * 1.5)}`
  if (stroke.dash === 'dot') return `0.1 ${round(stroke.width * 2)}`
  return null
}

/** Soft edge in px, 0 for none. */
export function strokeBlur(stroke: Stroke): number {
  return stroke.blur && stroke.blur > 0 ? stroke.blur : 0
}

/** A straight segment. */
export function linePath(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}`
}

/** A rectangle from any two opposite corners. */
export function rectPath(x1: number, y1: number, x2: number, y2: number): string {
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const w = Math.abs(x2 - x1)
  const h = Math.abs(y2 - y1)
  return `M ${round(x)} ${round(y)} L ${round(x + w)} ${round(y)} L ${round(x + w)} ${round(y + h)} L ${round(x)} ${round(y + h)} Z`
}

/** An ellipse from any two opposite corners of its bounding box. */
export function ellipsePath(x1: number, y1: number, x2: number, y2: number): string {
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  const rx = Math.abs(x2 - x1) / 2
  const ry = Math.abs(y2 - y1) / 2
  if (rx <= 0 || ry <= 0) return linePath(x1, y1, x2, y2)
  return (
    `M ${round(cx - rx)} ${round(cy)}` +
    ` A ${round(rx)} ${round(ry)} 0 1 0 ${round(cx + rx)} ${round(cy)}` +
    ` A ${round(rx)} ${round(ry)} 0 1 0 ${round(cx - rx)} ${round(cy)} Z`
  )
}

/** A shaft with a head, in one path so it moves and styles as one stroke. */
export function arrowPath(x1: number, y1: number, x2: number, y2: number, headLength = 14): string {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const spread = Math.PI / 7
  const left = angle + Math.PI - spread
  const right = angle + Math.PI + spread
  const hx1 = x2 + headLength * Math.cos(left)
  const hy1 = y2 + headLength * Math.sin(left)
  const hx2 = x2 + headLength * Math.cos(right)
  const hy2 = y2 + headLength * Math.sin(right)
  return (
    `M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}` +
    ` M ${round(hx1)} ${round(hy1)} L ${round(x2)} ${round(y2)} L ${round(hx2)} ${round(hy2)}`
  )
}

/**
 * Mirror samples across the artboard centre for symmetry drawing. Applied to
 * the points, not the path data, so mirrored strokes are real strokes with
 * real ids rather than a visual trick the exports would miss.
 */
export function mirrorPoints(points: Point[], axis: Symmetry, width = VIEW_W, height = VIEW_H): Point[] {
  if (axis === 'off') return points
  return points.map((point) => ({
    x: axis === 'x' || axis === 'both' ? width - point.x : point.x,
    y: axis === 'y' || axis === 'both' ? height - point.y : point.y
  }))
}

/**
 * Scatter dots along a gesture for the airbrush. Deterministic for a seed, so
 * the same stroke paints the same spray on screen, in exports, and in tests -
 * Math.random would make all three disagree.
 */
export function scatterDots(points: Point[], radius: number, density: number, seed: number): Point[] {
  if (points.length === 0 || radius <= 0 || density <= 0) return []
  let state = (seed >>> 0) || 1
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
  const dots: Point[] = []
  // Walk the gesture in small steps so fast flicks spray evenly, not sparsely.
  let carry = 0
  const step = Math.max(1, radius / 2)
  const first = points[0]!
  let prev = first
  const emit = (x: number, y: number): void => {
    const count = Math.max(1, Math.round(density))
    for (let i = 0; i < count; i += 1) {
      const angle = random() * Math.PI * 2
      const distance = Math.sqrt(random()) * radius
      dots.push({ x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance })
    }
  }
  emit(first.x, first.y)
  for (let i = 1; i < points.length; i += 1) {
    const current = points[i]!
    let remaining = Math.hypot(current.x - prev.x, current.y - prev.y)
    let fx = prev.x
    let fy = prev.y
    const dx = remaining === 0 ? 0 : (current.x - prev.x) / remaining
    const dy = remaining === 0 ? 0 : (current.y - prev.y) / remaining
    carry += remaining
    while (carry >= step) {
      fx += dx * step
      fy += dy * step
      remaining -= step
      carry -= step
      emit(fx, fy)
    }
    prev = current
  }
  return dots
}

/** Dots as filled circles, so the spray has no stroke width of its own. */
export function dotsPath(dots: Point[], dotRadius: number): string {
  const radius = Math.max(0.5, dotRadius)
  return dots
    .map(
      (dot) =>
        `M ${round(dot.x - radius)} ${round(dot.y)}` +
        ` a ${round(radius)} ${round(radius)} 0 1 0 ${round(radius * 2)} 0` +
        ` a ${round(radius)} ${round(radius)} 0 1 0 ${round(-radius * 2)} 0`
    )
    .join(' ')
}

/** The exact markup both exports are built from, so SVG and PNG cannot drift apart. */
export function serializeSvg(strokes: Stroke[], paper: string = PAPER): string {
  const blurs = [...new Set(strokes.filter((s) => strokeVisible(s)).map(strokeBlur).filter((b) => b > 0))].sort((a, b) => a - b)
  const defs =
    blurs.length === 0
      ? ''
      : `  <defs>\n${blurs.map((b) => `    <filter id="soft${b}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${b}" /></filter>`).join('\n')}\n  </defs>\n`
  const body = strokes
    .filter(strokeVisible)
    .map((stroke) => {
      const { dx, dy } = strokeOffset(stroke)
      const move = dx !== 0 || dy !== 0 ? ` transform="translate(${round(dx)} ${round(dy)})"` : ''
      const blur = strokeBlur(stroke)
      const soft = blur > 0 ? ` filter="url(#soft${blur})"` : ''
      const dash = strokeDasharray(stroke)
      const dashed = dash ? ` stroke-dasharray="${dash}"` : ''
      if (strokeKind(stroke) === 'text') {
        // A text stroke's anchor lives in its move offset: placing and moving
        // are the same operation, so there is no separate position to drift.
        const { dx: tx, dy: ty } = strokeOffset(stroke)
        const size = stroke.fontSize && stroke.fontSize > 0 ? stroke.fontSize : 24
        const family = (stroke.fontFamily || 'sans-serif').replace(/["<>]/g, '')
        const content = (stroke.text ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
        return `  <text x="${round(tx)}" y="${round(ty)}" fill="${stroke.color}" fill-opacity="${strokeOpacity(stroke).toFixed(2)}" font-size="${size}" font-family="${family}">${content}</text>`
      }
      const filled = stroke.fill ? ` fill="${stroke.fill}" fill-opacity="${strokeOpacity(stroke).toFixed(2)}" stroke="none"` : ` fill="none" stroke="${strokeInk(stroke, paper)}" stroke-width="${stroke.width}" stroke-opacity="${strokeOpacity(stroke).toFixed(2)}"`
      return `  <path d="${stroke.d}"${filled}${dashed}${soft}${move} stroke-linecap="round" stroke-linejoin="round" />`
    })
    .join('\n')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="${VIEW_W}" height="${VIEW_H}">`,
    defs + `  <rect width="${VIEW_W}" height="${VIEW_H}" fill="${paper}" />`,
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