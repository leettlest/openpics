import { ArrowClockwise, ArrowCounterClockwise, DownloadSimple, TrashSimple } from '@phosphor-icons/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { bridge } from '@/lib/bridge'
import {
  arrowPath,
  buildPath,
  dotsPath,
  ellipsePath,
  isMeaningfulMove,
  linePath,
  mirrorPoints,
  rectPath,
  scatterDots,
  serializeSvg,
  strokeBlur,
  strokeDasharray,
  strokeInk,
  strokeKind,
  strokeOffset,
  strokeOpacity,
  strokeVisible,
  toArtboard,
  FREEHAND_TOOLS,
  SHAPE_TOOLS,
  VIEW_H,
  VIEW_W,
  PAPER,
  type Dash,
  type Point,
  type Stroke,
  type Symmetry,
  type Tool,
} from '@shared/creatives-draw'
import { Button, Segmented } from './ui'

const DRAW_TOOLS: { value: Tool; label: string }[] = [
  { value: 'brush', label: 'Brush' },
  { value: 'pencil', label: 'Pencil' },
  { value: 'marker', label: 'Marker' },
  { value: 'highlighter', label: 'Highlighter' },
  { value: 'airbrush', label: 'Airbrush' },
  { value: 'neon', label: 'Neon' },
  { value: 'eraser', label: 'Eraser' },
]

const SHAPE_OPTIONS: { value: Tool; label: string }[] = [
  { value: 'line', label: 'Line' },
  { value: 'rect', label: 'Rectangle' },
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'arrow', label: 'Arrow' },
  { value: 'text', label: 'Text' },
]

const EDIT_OPTIONS: { value: Tool; label: string }[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'eyedropper', label: 'Pick' },
  { value: 'select', label: 'Select' },
]

const DASH_OPTIONS: { value: Dash; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dash', label: 'Dashed' },
  { value: 'dot', label: 'Dotted' },
]

const SYMMETRY_OPTIONS: { value: Symmetry; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'x', label: 'Mirror ║' },
  { value: 'y', label: 'Mirror ═' },
  { value: 'both', label: 'Both' },
]

const GRID_SIZES = [25, 50, 100]

const FONTS = ['sans-serif', 'serif', 'monospace', 'cursive']

const KIND_LABEL: Record<string, string> = {
  path: 'stroke',
  dots: 'spray',
  shape: 'shape',
  text: 'text',
}

const ALL_TOOL_OPTIONS = [...DRAW_TOOLS, ...SHAPE_OPTIONS, ...EDIT_OPTIONS]

const toolLabel = (tool: Tool): string => ALL_TOOL_OPTIONS.find((option) => option.value === tool)?.label ?? tool

/** Past states for undo, capped so a long session cannot grow it without bound. */
const HISTORY_LIMIT = 50

function download(name: string, href: string): void {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = name
  anchor.click()
  // Revoking in the same tick can cancel the download in Chromium, so let it settle first.
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
}

function snapPoint(point: Point, size: number): Point {
  return { x: Math.round(point.x / size) * size, y: Math.round(point.y / size) * size }
}

/**
 * The drawing surface: a small painting suite, not a single brush.
 *
 * Twenty tools in four groups - freehand, shapes, edit, canvas - each with the
 * sub-options that make it its own instrument rather than a renamed brush.
 * Every mark is kept as vector data, so undo is exact, moving never degrades a
 * shape, and both exports come from the same data the screen shows. Nothing
 * here touches the network; the MCP server reaches the same drawing through
 * the saved file, which this surface reloads live.
 */
export function Creatives() {
  const [tool, setTool] = useState<Tool>('brush')
  const [color, setColor] = useState('#111827')
  const [width, setWidth] = useState(6)
  const [opacity, setOpacity] = useState(100)
  const [glow, setGlow] = useState(6)
  const [density, setDensity] = useState(4)
  const [dash, setDash] = useState<Dash>('solid')
  const [fillOn, setFillOn] = useState(false)
  const [fillColor, setFillColor] = useState('#f5c542')
  const [textValue, setTextValue] = useState('Hello')
  const [fontSize, setFontSize] = useState(32)
  const [fontFamily, setFontFamily] = useState('sans-serif')
  const [symmetry, setSymmetry] = useState<Symmetry>('off')
  const [gridShow, setGridShow] = useState(false)
  const [gridSize, setGridSize] = useState(50)
  const [snap, setSnap] = useState(false)
  const [paper, setPaper] = useState(PAPER)
  const [layersOpen, setLayersOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<number[]>([])

  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [past, setPast] = useState<Stroke[][]>([])
  const [future, setFuture] = useState<Stroke[][]>([])
  const [live, setLive] = useState<Stroke | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const svgRef = useRef<SVGSVGElement>(null)
  const points = useRef<Point[]>([])
  const drawing = useRef(false)
  const nextId = useRef(1)
  const dragRef = useRef<{ ids: number[]; base: Stroke[]; last: Point } | null>(null)
  const shapeRefs = useRef(new Map<number, SVGPathElement | SVGTextElement>())
  // The stroke being drawn is mirrored in a ref because pointer handlers must act
  // on the current stroke without putting side effects inside a state updater.
  // Updaters can run more than once in StrictMode, so they stay pure.
  const liveRef = useRef<Stroke | null>(null)
  // The box the canvas may fill, measured so the artboard takes the largest
  // exact 4/3 rectangle that fits. A fixed aspect-ratio element sized by width
  // alone runs off the bottom on short windows with no way to reach it; fitting
  // to both axes keeps the whole surface on screen, and the exact ratio keeps
  // pointer mapping linear (see toArtboard).
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxSize, setBoxSize] = useState<{ width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const fit = (): void => {
      const rect = el.getBoundingClientRect()
      // Zero while hidden: keep the last size rather than collapsing to nothing.
      if (rect.width <= 0 || rect.height <= 0) return
      let width = rect.width
      let height = (width * VIEW_H) / VIEW_W
      if (height > rect.height) {
        height = rect.height
        width = (height * VIEW_W) / VIEW_H
      }
      setBoxSize((prev) =>
        prev && Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
          ? prev
          : { width, height }
      )
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // True once the saved drawing has been restored (or confirmed absent). Saves
  // wait for it, so mounting never overwrites a good file with an empty canvas.
  const [restored, setRestored] = useState(false)

  // A restart keeps the drawing: main validates the file, so whatever comes
  // back is shaped like strokes and safe to render.
  useEffect(() => {
    let live = true
    void bridge.creatives
      .load()
      .then((saved) => {
        if (!live) return
        if (saved) {
          setStrokes(saved)
          nextId.current = Math.max(...saved.map((stroke) => stroke.id), 0) + 1
        }
        setRestored(true)
      })
      .catch(() => {
        if (live) setRestored(true)
      })
    return () => {
      live = false
    }
  }, [])

  // A debounced copy in the user-data directory, so a crash or a restart loses
  // at most a second of drawing rather than all of it.
  useEffect(() => {
    if (!restored) return
    const id = window.setTimeout(() => {
      void bridge.creatives.save(strokes).catch(() => {})
    }, 1000)
    return () => window.clearTimeout(id)
  }, [strokes, restored])

  // Live sync the other way: an agent editing over MCP writes the same file,
  // main notices and tells us, and the new strokes appear while watching. The
  // pre-merge drawing is pushed onto undo first, so taking the agent's work
  // never destroys yours - one Undo puts it back.
  const strokesRef = useRef<Stroke[]>([])
  strokesRef.current = strokes
  useEffect(() => {
    return bridge.onCreativesChanged(() => {
      void bridge.creatives
        .load()
        .then((saved) => {
          const incoming = saved ?? []
          const current = strokesRef.current
          if (JSON.stringify(current) === JSON.stringify(incoming)) return
          setPast((prev) => [...prev.slice(-(HISTORY_LIMIT - 1)), current])
          setFuture([])
          setStrokes(incoming)
          nextId.current =
            Math.max(nextId.current, ...incoming.map((stroke) => (stroke.id > 0 ? stroke.id : 0)), 0) + 1
          setSelectedIds((selected) => selected.filter((id) => incoming.some((stroke) => stroke.id === id)))
        })
        .catch(() => {})
    })
  }, [])

  /** Records the present before replacing it, so every mutation undoes. */
  const commitStrokes = (next: Stroke[]): void => {
    setPast((prev) => [...prev.slice(-(HISTORY_LIMIT - 1)), strokes])
    setFuture([])
    setStrokes(next)
    setSelectedIds((selected) => selected.filter((id) => next.some((stroke) => stroke.id === id)))
  }

  const undo = (): void => {
    if (past.length === 0) return
    const previous = past[past.length - 1]!
    setFuture((next) => [strokes, ...next].slice(0, HISTORY_LIMIT))
    setPast(past.slice(0, -1))
    setStrokes(previous)
    setSelectedIds((selected) => selected.filter((id) => previous.some((stroke) => stroke.id === id)))
  }

  const redo = (): void => {
    if (future.length === 0) return
    const [next, ...rest] = future
    if (!next) return
    setPast((prev) => [...prev.slice(-(HISTORY_LIMIT - 1)), strokes])
    setFuture(rest)
    setStrokes(next)
    setSelectedIds((selected) => selected.filter((id) => next.some((stroke) => stroke.id === id)))
  }

  const clear = (): void => {
    if (strokes.length === 0) return
    setExportError(null)
    commitStrokes([])
  }

  const deleteSelection = (): void => {
    if (selectedIds.length === 0) return
    const gone = new Set(selectedIds)
    commitStrokes(strokes.filter((stroke) => !gone.has(stroke.id)))
  }

  const mintId = (): number => {
    // Positive only: negative ids belong to the agent side, so the two can
    // interleave in one file without ever colliding.
    const id = nextId.current
    nextId.current += 1
    return id
  }

  const pointFrom = (event: React.PointerEvent<SVGSVGElement>): Point | null => {
    const svg = svgRef.current
    if (!svg) return null
    const point = toArtboard(event.clientX, event.clientY, svg.getBoundingClientRect())
    if (!point) return null
    return snap ? snapPoint(point, gridSize) : point
  }

  const shapePath = (kind: Tool, from: Point, to: Point): string => {
    if (kind === 'line') return linePath(from.x, from.y, to.x, to.y)
    if (kind === 'rect') return rectPath(from.x, from.y, to.x, to.y)
    if (kind === 'ellipse') return ellipsePath(from.x, from.y, to.x, to.y)
    return arrowPath(from.x, from.y, to.x, to.y)
  }

  const start = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    const point = pointFrom(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)

    if (tool === 'text') {
      if (textValue.trim() === '') return
      commitStrokes([
        ...strokes,
        {
          id: mintId(),
          kind: 'text',
          d: '',
          color,
          width,
          opacity: 100,
          tool,
          text: textValue,
          fontSize,
          fontFamily,
          dx: point.x,
          dy: point.y,
        },
      ])
      return
    }

    if (tool === 'fill') {
      const hit = hitTopmost(point)
      if (hit) {
        // Fill the shape under the cursor with the ink colour.
        commitStrokes(strokes.map((stroke) => (stroke.id === hit.id ? { ...stroke, fill: color } : stroke)))
      } else {
        setPaper(color)
      }
      return
    }

    if (tool === 'eyedropper') {
      const hit = hitTopmost(point)
      if (hit) {
        setColor(hit.tool === 'eraser' ? paper : hit.color)
        setTool('brush')
      }
      return
    }

    if (tool === 'select') {
      const hit = hitTopmost(point)
      if (!hit) {
        if (!event.shiftKey) setSelectedIds([])
        return
      }
      const ids = event.shiftKey
        ? selectedIds.includes(hit.id)
          ? selectedIds.filter((id) => id !== hit.id)
          : [...selectedIds, hit.id]
        : [hit.id]
      setSelectedIds(ids)
      drawing.current = true
      dragRef.current = { ids, base: strokes, last: point }
      return
    }

    drawing.current = true
    points.current = [point]
    if (SHAPE_TOOLS.includes(tool)) {
      // A fill only makes sense where there is an inside: rectangles and
      // ellipses. Lines and arrows stay outlines even with fill switched on,
      // or the stroke would vanish into an invisible filled nothing.
      const fillable = tool === 'rect' || tool === 'ellipse'
      const stroke: Stroke = {
        id: nextId.current,
        kind: 'shape',
        d: shapePath(tool, point, point),
        color,
        width,
        opacity,
        tool,
        dash,
        fill: fillOn && fillable ? fillColor : null,
      }
      liveRef.current = stroke
      setLive(stroke)
      return
    }
    const stroke: Stroke = {
      id: nextId.current,
      kind: tool === 'airbrush' ? 'dots' : 'path',
      d: tool === 'airbrush' ? dotsPath(scatterDots([point], width, density, nextId.current), Math.max(1, width / 4)) : buildPath([point]),
      color,
      width,
      opacity: tool === 'highlighter' ? Math.min(opacity, 60) : opacity,
      tool,
      blur: tool === 'neon' ? glow : undefined,
    }
    liveRef.current = stroke
    setLive(stroke)
  }

  const extend = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (!drawing.current) return
    const point = pointFrom(event)
    if (!point) return
    if (tool === 'select') {
      const drag = dragRef.current
      if (!drag) return
      const dx = point.x - drag.last.x
      const dy = point.y - drag.last.y
      if (dx === 0 && dy === 0) return
      const moved = new Set(drag.ids)
      setStrokes((all) =>
        all.map((stroke) => {
          if (!moved.has(stroke.id)) return stroke
          const { dx: ox, dy: oy } = strokeOffset(stroke)
          return { ...stroke, dx: ox + dx, dy: oy + dy }
        })
      )
      drag.last = point
      return
    }
    const last = points.current[points.current.length - 1]
    if (!isMeaningfulMove(last, point)) return
    points.current = [...points.current, point]
    const current = liveRef.current
    if (!current) return
    const d =
      current.kind === 'shape'
        ? shapePath(tool, points.current[0]!, point)
        : current.kind === 'dots'
          ? dotsPath(scatterDots(points.current, width, density, current.id), Math.max(1, width / 4))
          : buildPath(points.current)
    const extended = { ...current, d }
    liveRef.current = extended
    setLive(extended)
  }

  const finish = (): void => {
    if (tool === 'select') {
      // A move that went nowhere is not history; one that moved is.
      const drag = dragRef.current
      dragRef.current = null
      drawing.current = false
      if (drag) {
        const moved = strokes.some((stroke) => {
          const before = drag.base.find((s) => s.id === stroke.id)
          if (!before) return true
          const a = strokeOffset(before)
          const b = strokeOffset(stroke)
          return a.dx !== b.dx || a.dy !== b.dy
        })
        if (moved) {
          setPast((prev) => [...prev.slice(-(HISTORY_LIMIT - 1)), drag.base])
          setFuture([])
        }
      }
      return
    }
    if (!drawing.current) return
    drawing.current = false
    const gesture = points.current
    points.current = []
    const current = liveRef.current
    // Cleared before every exit below, including the too-small-shape one: a
    // live preview left behind would haunt the canvas without ever committing.
    liveRef.current = null
    setLive(null)
    if (!current) return
    // A shape smaller than a tap is a slip, not a shape.
    if (current.kind === 'shape') {
      const from = gesture[0]
      const to = gesture[gesture.length - 1]
      if (!from || !to || Math.hypot(to.x - from.x, to.y - from.y) < 3) return
    }
    const committed: Stroke[] = [{ ...current, id: mintId() }]
    // Symmetry mirrors the finished gesture, as real strokes with real ids.
    if (symmetry !== 'off') {
      const axes: Symmetry[] = symmetry === 'both' ? ['x', 'y', 'both'] : [symmetry]
      for (const axis of axes) {
        if (current.kind === 'shape') {
          const from = gesture[0]!
          const to = gesture[gesture.length - 1]!
          const mirror = (p: Point): Point => ({
            x: axis === 'x' || axis === 'both' ? VIEW_W - p.x : p.x,
            y: axis === 'y' || axis === 'both' ? VIEW_H - p.y : p.y,
          })
          const mfrom = mirror(from)
          const mto = mirror(to)
          committed.push({ ...current, id: mintId(), d: shapePath(current.tool, mfrom, mto) })
        } else {
          const mirrored = mirrorPoints(gesture, axis)
          committed.push({
            ...current,
            id: mintId(),
            d:
              current.kind === 'dots'
                ? dotsPath(scatterDots(mirrored, width, density, nextId.current), Math.max(1, width / 4))
                : buildPath(mirrored),
          })
        }
      }
    }
    setPast((prev) => [...prev.slice(-(HISTORY_LIMIT - 1)), strokes])
    setFuture([])
    setStrokes([...strokes, ...committed])
    setSelectedIds([])
  }

  /** Topmost visible stroke under a point, or null. */
  const hitTopmost = (point: Point): Stroke | null => {
    const svg = svgRef.current
    if (!svg) return null
    for (let i = strokes.length - 1; i >= 0; i -= 1) {
      const stroke = strokes[i]!
      if (!strokeVisible(stroke)) continue
      const el = shapeRefs.current.get(stroke.id)
      if (!el) continue
      try {
        if (strokeKind(stroke) === 'text') {
          const box = (el as SVGTextElement).getBBox()
          if (point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y + box.height * -0.2 && point.y <= box.y + box.height) {
            return stroke
          }
          continue
        }
        const { dx, dy } = strokeOffset(stroke)
        const at = new DOMPoint(point.x - dx, point.y - dy)
        const path = el as SVGPathElement
        if (path.isPointInStroke(at)) return stroke
        if (stroke.fill && path.isPointInFill(at)) return stroke
      } catch {
        continue
      }
    }
    return null
  }

  const exportSvg = (): void => {
    if (strokes.length === 0) return
    setExportError(null)
    try {
      const blob = new Blob([serializeSvg(strokes, paper)], { type: 'image/svg+xml' })
      download('openpics-drawing.svg', URL.createObjectURL(blob))
    } catch {
      setExportError('The SVG could not be saved.')
    }
  }

  const exportPng = async (): Promise<void> => {
    if (strokes.length === 0) return
    setExportError(null)
    const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serializeSvg(strokes, paper))}`
    const image = new Image()
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('Could not rasterise the drawing.'))
        image.src = source
      })
    } catch {
      setExportError('The drawing could not be rasterised to PNG.')
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = VIEW_W
    canvas.height = VIEW_H
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setExportError('The drawing could not be rasterised to PNG.')
      return
    }
    ctx.fillStyle = paper
    ctx.fillRect(0, 0, VIEW_W, VIEW_H)
    ctx.drawImage(image, 0, 0, VIEW_W, VIEW_H)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) {
      setExportError('The drawing could not be rasterised to PNG.')
      return
    }
    download('openpics-drawing.png', URL.createObjectURL(blob))
  }

  const liveMirrors: Stroke[] =
    live && symmetry !== 'off' && points.current.length > 0
      ? (symmetry === 'both' ? (['x', 'y', 'both'] as const) : [symmetry]).flatMap((axis, i) => {
          if (live.kind === 'shape') {
            const from = points.current[0]!
            const to = points.current[points.current.length - 1]!
            const mirror = (p: Point): Point => ({
              x: axis === 'x' || axis === 'both' ? VIEW_W - p.x : p.x,
              y: axis === 'y' || axis === 'both' ? VIEW_H - p.y : p.y,
            })
            return [{ ...live, id: -1000 - i, d: shapePath(live.tool, mirror(from), mirror(to)) }]
          }
          if (live.kind !== 'path' && live.kind !== 'dots') return []
          const mirrored = mirrorPoints(points.current, axis)
          return [
            {
              ...live,
              id: -1000 - i,
              d:
                live.kind === 'dots'
                  ? dotsPath(scatterDots(mirrored, width, density, live.id), Math.max(1, width / 4))
                  : buildPath(mirrored),
            },
          ]
        })
      : []

  const shown = live ? [...strokes, live, ...liveMirrors] : strokes
  const selected = new Set(selectedIds)
  const blurs = [...new Set(shown.filter(strokeVisible).map(strokeBlur).filter((b) => b > 0))].sort((a, b) => a - b)

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex shrink-0 flex-col gap-2">
        <Segmented value={DRAW_TOOLS.some((o) => o.value === tool) ? tool : 'brush'} label="Drawing tool" options={DRAW_TOOLS} onChange={(value) => setTool(value as Tool)} />
        <Segmented value={SHAPE_OPTIONS.some((o) => o.value === tool) ? tool : 'line'} label="Shape tool" options={SHAPE_OPTIONS} onChange={(value) => setTool(value as Tool)} />
        <Segmented value={EDIT_OPTIONS.some((o) => o.value === tool) ? tool : 'select'} label="Edit tool" options={EDIT_OPTIONS} onChange={(value) => setTool(value as Tool)} />

        <div className="flex flex-wrap items-center gap-2">
          {tool !== 'eyedropper' && tool !== 'select' && tool !== 'fill' ? (
            <label className="flex items-center gap-1.5 text-[11px]">
              Ink
              <input
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
                className="h-6 w-9 cursor-pointer rounded border border-line bg-transparent"
                aria-label="Ink colour"
              />
            </label>
          ) : null}
          {FREEHAND_TOOLS.includes(tool) || SHAPE_TOOLS.includes(tool) ? (
            <>
              <label className="flex items-center gap-1.5 text-[11px]">
                Size
                <input
                  type="range"
                  min={1}
                  max={60}
                  value={width}
                  onChange={(event) => setWidth(Number(event.target.value))}
                  className="w-20"
                  aria-label="Stroke size"
                />
                <span className="num w-6 text-right">{width}</span>
              </label>
              <label className="flex items-center gap-1.5 text-[11px]">
                Fade
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={opacity}
                  onChange={(event) => setOpacity(Number(event.target.value))}
                  className="w-20"
                  aria-label="Stroke opacity"
                />
                <span className="num w-8 text-right">{opacity}%</span>
              </label>
            </>
          ) : null}
          {tool === 'neon' ? (
            <label className="flex items-center gap-1.5 text-[11px]">
              Glow
              <input
                type="range"
                min={2}
                max={12}
                value={glow}
                onChange={(event) => setGlow(Number(event.target.value))}
                className="w-20"
                aria-label="Neon glow"
              />
              <span className="num w-6 text-right">{glow}</span>
            </label>
          ) : null}
          {tool === 'airbrush' ? (
            <label className="flex items-center gap-1.5 text-[11px]">
              Spray
              <input
                type="range"
                min={1}
                max={10}
                value={density}
                onChange={(event) => setDensity(Number(event.target.value))}
                className="w-20"
                aria-label="Spray density"
              />
              <span className="num w-6 text-right">{density}</span>
            </label>
          ) : null}
          {SHAPE_TOOLS.includes(tool) && tool !== 'text' ? (
            <>
              <Segmented value={dash} label="Line style" options={DASH_OPTIONS} onChange={(value) => setDash(value as Dash)} />
              {(tool === 'rect' || tool === 'ellipse') ? (
                <label className="flex items-center gap-1.5 text-[11px]">
                  <input
                    type="checkbox"
                    checked={fillOn}
                    onChange={(event) => setFillOn(event.target.checked)}
                    aria-label="Fill shape"
                  />
                  Fill
                  <input
                    type="color"
                    value={fillColor}
                    onChange={(event) => setFillColor(event.target.value)}
                    className="h-6 w-9 cursor-pointer rounded border border-line bg-transparent"
                    aria-label="Fill colour"
                  />
                </label>
              ) : null}
            </>
          ) : null}
          {tool === 'text' ? (
            <>
              <label className="flex items-center gap-1.5 text-[11px]">
                Text
                <input
                  type="text"
                  value={textValue}
                  onChange={(event) => setTextValue(event.target.value)}
                  placeholder="Click the canvas to place"
                  aria-label="Text to place"
                  className="w-40 rounded-[6px] border border-line bg-raised px-2 py-1 text-[12px] text-ink placeholder:text-ink-3 focus:border-line-strong focus:outline-none"
                />
              </label>
              <label className="flex items-center gap-1.5 text-[11px]">
                Size
                <input
                  type="number"
                  min={8}
                  max={200}
                  value={fontSize}
                  onChange={(event) => setFontSize(Number(event.target.value) || 24)}
                  className="w-16 rounded-[6px] border border-line bg-raised px-2 py-1 text-[12px] text-ink focus:border-line-strong focus:outline-none"
                  aria-label="Font size"
                />
              </label>
              <label className="flex items-center gap-1.5 text-[11px]">
                Font
                <select
                  value={fontFamily}
                  onChange={(event) => setFontFamily(event.target.value)}
                  aria-label="Font family"
                  className="rounded-[6px] border border-line bg-raised px-2 py-1 text-[12px] text-ink focus:border-line-strong focus:outline-none"
                >
                  {FONTS.map((font) => (
                    <option key={font} value={font}>
                      {font}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          {tool === 'fill' ? (
            <span className="text-[11px] text-ink-3">
              Click a shape to fill it with the ink colour, or empty canvas for the background.
            </span>
          ) : null}
          {tool === 'eyedropper' ? (
            <span className="text-[11px] text-ink-3">Click any mark to take its colour.</span>
          ) : null}
          {tool === 'select' ? (
            <>
              <span className="text-[11px] text-ink-3">
                {selectedIds.length === 0
                  ? 'Click a mark to select it, Shift-click for several, drag to move.'
                  : `${selectedIds.length} selected. Drag to move, Delete removes.`}
              </span>
              {selectedIds.length > 0 ? (
                <Button size="sm" variant="ghost" onClick={deleteSelection}>
                  <TrashSimple size={13} weight="regular" />
                  Delete
                </Button>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={symmetry} label="Symmetry" options={SYMMETRY_OPTIONS} onChange={(value) => setSymmetry(value as Symmetry)} />
          <label className="flex items-center gap-1.5 text-[11px]">
            <input
              type="checkbox"
              checked={gridShow}
              onChange={(event) => setGridShow(event.target.checked)}
              aria-label="Show grid"
            />
            Grid
          </label>
          {gridShow ? (
            <>
              <Segmented
                value={String(gridSize)}
                label="Grid size"
                options={GRID_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
                onChange={(value) => setGridSize(Number(value))}
              />
              <label className="flex items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={snap}
                  onChange={(event) => setSnap(event.target.checked)}
                  aria-label="Snap to grid"
                />
                Snap
              </label>
            </>
          ) : null}
          <label className="flex items-center gap-1.5 text-[11px]">
            Paper
            <input
              type="color"
              value={paper}
              onChange={(event) => setPaper(event.target.value)}
              className="h-6 w-9 cursor-pointer rounded border border-line bg-transparent"
              aria-label="Paper colour"
            />
          </label>
          <Button size="sm" variant="ghost" onClick={() => setLayersOpen(!layersOpen)}>
            Layers ({strokes.length})
          </Button>
        </div>

        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="solid" onClick={undo} disabled={past.length === 0}>
            <ArrowCounterClockwise size={13} weight="regular" />
            Undo
          </Button>
          <Button size="sm" variant="ghost" onClick={redo} disabled={future.length === 0}>
            <ArrowClockwise size={13} weight="regular" />
            Redo
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={clear}
            disabled={strokes.length === 0}
          >
            <TrashSimple size={13} weight="regular" />
            Clear
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void exportPng()} disabled={strokes.length === 0}>
            <DownloadSimple size={13} weight="regular" />
            PNG
          </Button>
          <Button size="sm" variant="ghost" onClick={exportSvg} disabled={strokes.length === 0}>
            <DownloadSimple size={13} weight="regular" />
            SVG
          </Button>
        </div>
        {exportError ? (
          <p role="alert" className="text-[11px] text-ink-2">
            {exportError}
          </p>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[8px] border border-line bg-surface-2/40 p-2">
        <div className="flex shrink-0 items-center justify-between text-[11px] text-ink-3">
          <span className="inline-flex items-center gap-1">
            {toolLabel(tool)} · {symmetry !== 'off' ? 'symmetric' : 'free'}
          </span>
          <span className="num">
            {strokes.length} {strokes.length === 1 ? 'stroke' : 'strokes'}
          </span>
        </div>
        <div className="flex min-h-0 flex-1 gap-2">
          <div ref={boxRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
            <div
              style={boxSize ? { width: `${boxSize.width}px`, height: `${boxSize.height}px` } : undefined}
              className="overflow-hidden rounded-[6px] border border-line"
              onKeyDown={(event) => {
                if ((event.key === 'Delete' || event.key === 'Backspace') && tool === 'select') {
                  event.preventDefault()
                  deleteSelection()
                } else if (event.key === 'Escape' && tool === 'select') {
                  setSelectedIds([])
                }
              }}
            >
              <svg
                ref={svgRef}
                viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
                preserveAspectRatio="none"
                className="block h-full w-full touch-none"
                style={{ background: paper, cursor: tool === 'select' ? 'default' : tool === 'eyedropper' ? 'copy' : 'crosshair' }}
                role="img"
                aria-label={`Drawing canvas with ${strokes.length} ${strokes.length === 1 ? 'stroke' : 'strokes'}. Drawing needs a mouse, pen, or touch; every toolbar control works from the keyboard.`}
                tabIndex={0}
                onPointerDown={start}
                onPointerMove={extend}
                onPointerUp={finish}
                onPointerCancel={finish}
                onPointerLeave={finish}
              >
                {gridShow ? (
                  <defs>
                    <pattern id="creatives-grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse">
                      <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke="#888888" stroke-opacity="0.25" stroke-width="1" />
                    </pattern>
                    {blurs.map((b) => (
                      <filter key={b} id={`soft${b}`} x="-60%" y="-60%" width="220%" height="220%">
                        <feGaussianBlur stdDeviation={b} />
                      </filter>
                    ))}
                  </defs>
                ) : blurs.length > 0 ? (
                  <defs>
                    {blurs.map((b) => (
                      <filter key={b} id={`soft${b}`} x="-60%" y="-60%" width="220%" height="220%">
                        <feGaussianBlur stdDeviation={b} />
                      </filter>
                    ))}
                  </defs>
                ) : null}
                {gridShow ? <rect width={VIEW_W} height={VIEW_H} fill="url(#creatives-grid)" /> : null}
                <rect width={VIEW_W} height={VIEW_H} fill={paper} opacity={gridShow ? 0.85 : 1} />
                {shown.map((stroke) => (
                  <StrokePath key={stroke.id} stroke={stroke} selected={selected.has(stroke.id)} paper={paper} registerRef={shapeRefs} />
                ))}
              </svg>
            </div>
          </div>
          {layersOpen ? (
            <div className="flex w-44 shrink-0 flex-col overflow-hidden rounded-[6px] border border-line bg-raised/40">
              <p className="shrink-0 border-b border-line px-2 py-1 text-[11px] font-semibold text-ink-2">Layers</p>
              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {[...strokes].reverse().map((stroke, position) => (
                  <div
                    key={stroke.id}
                    className={`flex items-center gap-1 rounded-[4px] px-1 py-0.5 text-[11px] ${selected.has(stroke.id) ? 'bg-tint text-ink' : 'text-ink-2'}`}
                  >
                    <button
                      type="button"
                      title={strokeVisible(stroke) ? 'Hide' : 'Show'}
                      aria-label={`${strokeVisible(stroke) ? 'Hide' : 'Show'} ${KIND_LABEL[strokeKind(stroke)] ?? 'stroke'} ${stroke.id}`}
                      onClick={() => {
                        commitStrokes(strokes.map((s) => (s.id === stroke.id ? { ...s, visible: !strokeVisible(s) } : s)))
                      }}
                      className="shrink-0 rounded px-0.5 hover:bg-hover"
                    >
                      {strokeVisible(stroke) ? '◉' : '○'}
                    </button>
                    <span className="h-3 w-3 shrink-0 rounded-full border border-line" style={{ background: stroke.tool === 'eraser' ? paper : stroke.color }} aria-hidden />
                    <button
                      type="button"
                      title="Select"
                      onClick={() => setSelectedIds([stroke.id])}
                      className="min-w-0 flex-1 truncate text-left hover:text-ink"
                    >
                      {KIND_LABEL[strokeKind(stroke)] ?? 'stroke'} {stroke.id < 0 ? '(agent)' : `#${stroke.id}`}
                    </button>
                    <button
                      type="button"
                      title="Move up"
                      aria-label={`Move ${stroke.id} up`}
                      disabled={position === 0}
                      onClick={() => {
                        const index = strokes.findIndex((s) => s.id === stroke.id)
                        if (index < 0 || index >= strokes.length - 1) return
                        const next = [...strokes]
                        const other = next[index + 1]!
                        next[index + 1] = next[index]!
                        next[index] = other
                        commitStrokes(next)
                      }}
                      className="shrink-0 rounded px-0.5 hover:bg-hover disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title="Move down"
                      aria-label={`Move ${stroke.id} down`}
                      disabled={position === strokes.length - 1}
                      onClick={() => {
                        const index = strokes.findIndex((s) => s.id === stroke.id)
                        if (index <= 0) return
                        const next = [...strokes]
                        const other = next[index - 1]!
                        next[index - 1] = next[index]!
                        next[index] = other
                        commitStrokes(next)
                      }}
                      className="shrink-0 rounded px-0.5 hover:bg-hover disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      title="Delete layer"
                      aria-label={`Delete ${stroke.id}`}
                      onClick={() => commitStrokes(strokes.filter((s) => s.id !== stroke.id))}
                      className="shrink-0 rounded px-0.5 hover:bg-hover"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {strokes.length === 0 ? <p className="px-2 py-1 text-[11px] text-ink-3">Nothing drawn yet.</p> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <p className="shrink-0 text-[11px] text-ink-3">
        Draw, erase, and export on a {VIEW_W}x{VIEW_H} artboard. Everything stays on this machine. Undo keeps
        every step. Exports land in your downloads folder. Drawing itself needs a mouse, pen, or touch.
      </p>
    </div>
  )
}

/** One mark on the canvas, plus its selection underlay when selected. */
function StrokePath({
  stroke,
  selected,
  paper,
  registerRef,
}: {
  stroke: Stroke
  selected: boolean
  paper: string
  registerRef: React.RefObject<Map<number, SVGPathElement | SVGTextElement>>
}) {
  const { dx, dy } = strokeOffset(stroke)
  const move = dx !== 0 || dy !== 0 ? `translate(${dx} ${dy})` : undefined
  const dash = strokeDasharray(stroke)
  const blur = strokeBlur(stroke)
  const ref = (el: SVGPathElement | SVGTextElement | null): void => {
    if (el) registerRef.current.set(stroke.id, el)
    else registerRef.current.delete(stroke.id)
  }
  if (strokeKind(stroke) === 'text') {
    return (
      <g>
        {selected ? (
          <rect
            x={dx - 4}
            y={dy - (stroke.fontSize ?? 24) - 4}
            width={(stroke.text ?? '').length * ((stroke.fontSize ?? 24) * 0.6) + 8}
            height={(stroke.fontSize ?? 24) + 8}
            fill="none"
            stroke="#4f9cf9"
            strokeWidth={1.5}
            strokeDasharray="5 3"
            pointerEvents="none"
          />
        ) : null}
        <text
          ref={ref as React.Ref<SVGTextElement>}
          x={dx}
          y={dy}
          fill={stroke.color}
          fillOpacity={strokeOpacity(stroke)}
          fontSize={stroke.fontSize ?? 24}
          fontFamily={stroke.fontFamily ?? 'sans-serif'}
          opacity={strokeVisible(stroke) ? undefined : 0}
        >
          {stroke.text ?? ''}
        </text>
      </g>
    )
  }
  const filled = stroke.fill != null
  return (
    <g opacity={strokeVisible(stroke) ? undefined : 0}>
      {selected ? (
        <path
          d={stroke.d}
          fill="none"
          stroke="#4f9cf9"
          strokeWidth={stroke.width + 6}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.45}
          transform={move}
          pointerEvents="none"
        />
      ) : null}
      <path
        ref={ref as React.Ref<SVGPathElement>}
        d={stroke.d}
        fill={filled ? stroke.fill! : 'none'}
        fillOpacity={filled ? strokeOpacity(stroke) : undefined}
        stroke={filled ? 'none' : strokeInk(stroke, paper)}
        strokeWidth={filled ? undefined : stroke.width}
        strokeOpacity={filled ? undefined : strokeOpacity(stroke)}
        strokeDasharray={dash ?? undefined}
        filter={blur > 0 ? `url(#soft${blur})` : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
        transform={move}
      />
    </g>
  )
}
