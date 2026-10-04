import { ArrowClockwise, ArrowCounterClockwise, DownloadSimple, Eraser, PaintBrush, Pen, TrashSimple } from '@phosphor-icons/react'
import { useRef, useState } from 'react'
import { buildPath, isMeaningfulMove, serializeSvg, strokeInk, strokeOpacity, toArtboard, VIEW_H, VIEW_W, type Point, type Stroke, type Tool } from '@shared/creatives-draw'
import { Button, Segmented } from './ui'

const TOOL_OPTIONS: { value: Tool; label: string }[] = [
  { value: 'brush', label: 'Brush' },
  { value: 'eraser', label: 'Eraser' },
  { value: 'pen', label: 'Freehand' },
]

function download(name: string, href: string): void {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = name
  anchor.click()
  // Revoking in the same tick can cancel the download in Chromium, so let it settle first.
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
}

/**
 * The drawing surface. Every mark is kept as a vector stroke, so undo is a list
 * operation and both exports come from the same data the screen shows.
 * Nothing here touches the network.
 */
export function Creatives() {
  const [tool, setTool] = useState<Tool>('brush')
  const [color, setColor] = useState('#111827')
  const [width, setWidth] = useState(6)
  const [opacity, setOpacity] = useState(100)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [undone, setUndone] = useState<Stroke[]>([])
  const [live, setLive] = useState<Stroke | null>(null)

  const svgRef = useRef<SVGSVGElement>(null)
  const points = useRef<Point[]>([])
  const drawing = useRef(false)
  const nextId = useRef(1)

  const pointFrom = (event: React.PointerEvent<SVGSVGElement>): Point | null => {
    const svg = svgRef.current
    if (!svg) return null
    return toArtboard(event.clientX, event.clientY, svg.getBoundingClientRect())
  }

  const start = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    const point = pointFrom(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drawing.current = true
    points.current = [point]
    setLive({ id: nextId.current, d: buildPath(points.current), color, width, opacity, tool })
  }

  const extend = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (!drawing.current) return
    const point = pointFrom(event)
    if (!point) return
    const last = points.current[points.current.length - 1]
    if (!isMeaningfulMove(last, point)) return
    points.current = [...points.current, point]
    setLive((current) => (current ? { ...current, d: buildPath(points.current) } : current))
  }

  const finish = (): void => {
    if (!drawing.current) return
    drawing.current = false
    points.current = []
    setLive((current) => {
      // A stroke is only history once the pointer lifts, so a stray click that
      // never moves still undoes cleanly.
      if (current) {
        nextId.current += 1
        setStrokes((all) => [...all, current])
        setUndone([])
      }
      return null
    })
  }

  const undo = (): void => {
    setStrokes((all) => {
      const last = all[all.length - 1]
      if (!last) return all
      setUndone((rest) => [last, ...rest])
      return all.slice(0, -1)
    })
  }

  const redo = (): void => {
    setUndone((rest) => {
      const next = rest[0]
      if (!next) return rest
      setStrokes((all) => [...all, next])
      return rest.slice(1)
    })
  }

  const clear = (): void => {
    setStrokes([])
    setUndone([])
  }

  const exportSvg = (): void => {
    if (strokes.length === 0) return
    const blob = new Blob([serializeSvg(strokes)], { type: 'image/svg+xml' })
    download('openpics-drawing.svg', URL.createObjectURL(blob))
  }

  const exportPng = async (): Promise<void> => {
    if (strokes.length === 0) return
    const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serializeSvg(strokes))}`
    const image = new Image()
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('Could not rasterise the drawing.'))
        image.src = source
      })
    } catch {
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = VIEW_W
    canvas.height = VIEW_H
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, VIEW_W, VIEW_H)
    ctx.drawImage(image, 0, 0, VIEW_W, VIEW_H)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) return
    download('openpics-drawing.png', URL.createObjectURL(blob))
  }

  const shown = live ? [...strokes, live] : strokes

  return (
    <div className="flex flex-col gap-3">
      <p>Draw, erase, and export. Every mark stays on this machine.</p>

      <div className="flex flex-col gap-2">
        <Segmented value={tool} label="Drawing tool" options={TOOL_OPTIONS} onChange={setTool} />

        <div className="flex flex-wrap items-center gap-2">
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
        </div>

        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="solid" onClick={undo} disabled={strokes.length === 0}>
            <ArrowCounterClockwise size={13} weight="regular" />
            Undo
          </Button>
          <Button size="sm" variant="ghost" onClick={redo} disabled={undone.length === 0}>
            <ArrowClockwise size={13} weight="regular" />
            Redo
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={clear}
            disabled={strokes.length === 0 && undone.length === 0}
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
      </div>

      <div className="overflow-hidden rounded-[8px] border border-line bg-surface-2/40 p-2">
        <div className="flex items-center justify-between text-[11px] text-ink-3">
          <span className="inline-flex items-center gap-1">
            {tool === 'brush' ? <PaintBrush size={12} weight="regular" /> : null}
            {tool === 'eraser' ? <Eraser size={12} weight="regular" /> : null}
            {tool === 'pen' ? <Pen size={12} weight="regular" /> : null}
            {TOOL_OPTIONS.find((option) => option.value === tool)?.label}
          </span>
          <span className="num">
            {strokes.length} {strokes.length === 1 ? 'stroke' : 'strokes'}
          </span>
        </div>
        <div className="mt-2 aspect-[4/3] w-full overflow-hidden rounded-[6px] border border-line bg-raised/60">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            className="h-full w-full touch-none"
            role="img"
            aria-label="Drawing canvas"
            onPointerDown={start}
            onPointerMove={extend}
            onPointerUp={finish}
            onPointerCancel={finish}
            onPointerLeave={finish}
          >
            <rect width={VIEW_W} height={VIEW_H} fill="#ffffff" />
            {shown.map((stroke) => (
              <path
                key={stroke.id}
                d={stroke.d}
                fill="none"
                stroke={strokeInk(stroke)}
                strokeWidth={stroke.width}
                strokeOpacity={strokeOpacity(stroke)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </svg>
        </div>
      </div>

      <p className="text-[11px] text-ink-3">
        Vector strokes on a {VIEW_W}x{VIEW_H} artboard. Undo keeps every step. Exports land in your downloads
        folder.
      </p>
    </div>
  )
}