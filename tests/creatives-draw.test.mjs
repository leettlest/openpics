/**
 * Tests for the drawing maths behind the Creatives surface.
 *
 * All of it is pure: pointer coordinates in, path and markup out. The renderer
 * supplies the coordinates and reads back the string, so the geometry, the
 * jitter filter and the exported document can be pinned here without a DOM.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIST = new URL('../dist-test/', import.meta.url)
if (!existsSync(fileURLToPath(new URL('../dist-test/shared/creatives-draw.js', import.meta.url)))) {
  console.error('the test build is missing: dist-test/shared/creatives-draw.js\nrun "npm run build:test" first, or use "npm test".')
  process.exit(1)
}

const {
  buildPath,
  isMeaningfulMove,
  serializeSvg,
  strokeInk,
  strokeOpacity,
  strokeDasharray,
  strokeBlur,
  strokeKind,
  strokeVisible,
  strokeOffset,
  linePath,
  rectPath,
  ellipsePath,
  arrowPath,
  mirrorPoints,
  scatterDots,
  dotsPath,
  toArtboard,
  MIN_SAMPLE_DISTANCE,
  VIEW_W,
  VIEW_H,
  PAPER,
} = await import(new URL('shared/creatives-draw.js', DIST).href)

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? `: ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`)
  }
}

const stroke = (over = {}) => ({
  id: 1,
  d: 'M 0 0',
  color: '#111827',
  width: 6,
  opacity: 100,
  tool: 'brush',
  ...over,
})

console.log('creatives draw')

// buildPath
check('no points is an empty path', buildPath([]) === '', buildPath([]))
check('one point still marks the page', buildPath([{ x: 5, y: 7 }]) === 'M 5.00 7.00 L 5.00 7.00', buildPath([{ x: 5, y: 7 }]))
check(
  'two points make one straight segment',
  buildPath([{ x: 0, y: 0 }, { x: 10, y: 0 }]) === 'M 0.00 0.00 L 10.00 0.00',
  buildPath([{ x: 0, y: 0 }, { x: 10, y: 0 }])
)
{
  // Three samples: one quadratic through the middle, then a line to the end.
  const d = buildPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }])
  check('three points use one quadratic', d === 'M 0.00 0.00 Q 10.00 10.00 15.00 5.00 L 20.00 0.00', d)
}
{
  const d = buildPath([{ x: 1.234, y: 5.678 }, { x: 9.876, y: 3.21 }])
  check('coordinates are rounded to two places', !/\d\.\d{3}/.test(d), d)
}
{
  const straight = buildPath([
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 10, y: 0 },
  ])
  check('collinear samples stay on the line', straight === 'M 0.00 0.00 Q 5.00 0.00 7.50 0.00 L 10.00 0.00', straight)
}

// jitter filter
check('the first sample is always kept', isMeaningfulMove(undefined, { x: 0, y: 0 }) === true)
check(
  'a sub-threshold nudge is dropped',
  isMeaningfulMove({ x: 0, y: 0 }, { x: MIN_SAMPLE_DISTANCE - 0.01, y: 0 }) === false
)
check(
  'a real move is kept',
  isMeaningfulMove({ x: 0, y: 0 }, { x: 0, y: MIN_SAMPLE_DISTANCE }) === true
)
check(
  'the threshold is euclidean, not per axis',
  // Each axis moves under the threshold, but the distance across both clears it.
  isMeaningfulMove({ x: 0, y: 0 }, { x: 1.2, y: 1.2 }) === true
)

// ink and opacity
check('the brush uses its own colour', strokeInk(stroke()) === '#111827', strokeInk(stroke()))
check('the eraser paints the paper', strokeInk(stroke({ tool: 'eraser', color: '#ff0000' })) === PAPER)
check('the pen uses its own colour', strokeInk(stroke({ tool: 'pen' })) === '#111827')
check('full opacity stays 1', strokeOpacity(stroke()) === 1)
check('half opacity is a half', strokeOpacity(stroke({ opacity: 50 })) === 0.5)
check('opacity is clamped at the top', strokeOpacity(stroke({ opacity: 400 })) === 1)
check('opacity is clamped at the bottom', strokeOpacity(stroke({ opacity: -20 })) === 0)

// serialization
{
  const svg = serializeSvg([])
  check('an empty drawing is still a valid document', svg.includes('</svg>') && svg.includes('<rect'), svg)
  check('the artboard size is declared', svg.includes(`viewBox="0 0 ${VIEW_W} ${VIEW_H}"`), svg)
}
{
  const svg = serializeSvg([stroke({ d: 'M 1.00 2.00', width: 12, opacity: 40 })])
  check('one stroke becomes one path', (svg.match(/<path /g) ?? []).length === 1, svg)
  check('the path carries its width', svg.includes('stroke-width="12"'), svg)
  check('opacity is written as a fraction', svg.includes('stroke-opacity="0.40"'), svg)
  check('round caps are set so dots render', svg.includes('stroke-linecap="round"'), svg)
  check('the paper is painted first', svg.indexOf('<rect') < svg.indexOf('<path'), svg)
}
{
  const svg = serializeSvg([stroke(), stroke({ id: 2 }), stroke({ id: 3, tool: 'eraser' })])
  check('three strokes become three paths', (svg.match(/<path /g) ?? []).length === 3, svg)
  check('the eraser is written in paper colour', (svg.match(new RegExp(`stroke="${PAPER}"`, 'g')) ?? []).length === 1, svg)
}

// coordinate mapping
{
  const rect = { left: 0, top: 0, width: 400, height: 300 }
  check('the top-left corner is the origin', JSON.stringify(toArtboard(0, 0, rect)) === JSON.stringify({ x: 0, y: 0 }))
  check('the bottom-right corner is the far edge', JSON.stringify(toArtboard(400, 300, rect)) === JSON.stringify({ x: VIEW_W, y: VIEW_H }))
  const mid = toArtboard(200, 150, rect)
  check('the middle maps to the middle', mid && mid.x === VIEW_W / 2 && mid.y === VIEW_H / 2, JSON.stringify(mid))
  check('an offset rect is honoured', JSON.stringify(toArtboard(210, 160, { ...rect, left: 10, top: 10 })) === JSON.stringify({ x: VIEW_W / 2, y: VIEW_H / 2 }))
  check('a collapsed rect yields no point', toArtboard(10, 10, { ...rect, width: 0 }) === null)
  check('a zero-height rect yields no point', toArtboard(10, 10, { ...rect, height: 0 }) === null)
}

// shape builders
check('a line is two endpoints', linePath(0, 0, 10, 20) === 'M 0.00 0.00 L 10.00 20.00', linePath(0, 0, 10, 20))
{
  const rect = rectPath(30, 10, 10, 40)
  check('a rect closes whatever the drag direction', rect.endsWith('Z') && rect.includes('M 10.00 10.00'), rect)
}
{
  const ellipse = ellipsePath(0, 0, 20, 10)
  check('an ellipse is two arcs', (ellipse.match(/ A /g) ?? []).length === 2 && ellipse.endsWith('Z'), ellipse)
  check('a flat ellipse falls back to a line', ellipsePath(5, 5, 5, 9) === linePath(5, 5, 5, 9))
}
{
  const arrow = arrowPath(0, 0, 40, 0)
  check('an arrow carries a head', (arrow.match(/ L /g) ?? []).length === 3, arrow)
}

// symmetry
{
  const pts = [{ x: 100, y: 50 }]
  check('off mirrors nothing', mirrorPoints(pts, 'off') === pts)
  check('x mirrors across the centre', JSON.stringify(mirrorPoints(pts, 'x')) === JSON.stringify([{ x: VIEW_W - 100, y: 50 }]))
  check('y mirrors across the middle', JSON.stringify(mirrorPoints(pts, 'y')) === JSON.stringify([{ x: 100, y: VIEW_H - 50 }]))
  check('both mirrors both', JSON.stringify(mirrorPoints(pts, 'both')) === JSON.stringify([{ x: VIEW_W - 100, y: VIEW_H - 50 }]))
}

// airbrush scatter
{
  const gesture = [{ x: 0, y: 0 }, { x: 60, y: 0 }]
  const a = scatterDots(gesture, 8, 2, 42)
  const b = scatterDots(gesture, 8, 2, 42)
  check('the same seed sprays the same dots', JSON.stringify(a) === JSON.stringify(b))
  check('a different seed sprays differently', JSON.stringify(a) !== JSON.stringify(scatterDots(gesture, 8, 2, 43)))
  check('dots stay near the gesture', a.every((d) => d.x >= -8 && d.x <= 68 && Math.abs(d.y) <= 8), `dots: ${a.length}`)
  check('nothing to spray, no dots', scatterDots([], 8, 2, 1).length === 0)
  check('a dot path is all arcs', dotsPath([{ x: 5, y: 5 }], 2).includes(' a '))
}

// stroke style helpers
check('solid has no dash pattern', strokeDasharray(stroke()) === null)
check('a dash scales with the width', strokeDasharray(stroke({ dash: 'dash', width: 4 })) === '12.00 6.00')
check('dots are tiny with round caps behind them', strokeDasharray(stroke({ dash: 'dot', width: 4 })) === '0.1 8.00')
check('no blur by default', strokeBlur(stroke()) === 0)
check('a set blur reads back', strokeBlur(stroke({ blur: 6 })) === 6)
check('old saves are freehand paths', strokeKind(stroke()) === 'path' && strokeKind(stroke({ kind: 'shape' })) === 'shape')
check('everything shows unless hidden', strokeVisible(stroke()) === true && strokeVisible(stroke({ visible: false })) === false)
{
  const moved = strokeOffset(stroke({ dx: 5, dy: -3 }))
  check('a move reads back as an offset', moved.dx === 5 && moved.dy === -3)
  check('no move is zero', strokeOffset(stroke()).dx === 0 && strokeOffset(stroke()).dy === 0)
}
check('the eraser follows recoloured paper', strokeInk(stroke({ tool: 'eraser' }), '#123456') === '#123456')

// serialization of the new kinds
{
  const svg = serializeSvg([
    stroke({ id: 1, d: rectPath(0, 0, 10, 10), kind: 'shape', fill: '#ff0000' }),
    stroke({ id: 2, d: '', kind: 'text', text: 'hi <there>', fontSize: 20 }),
    stroke({ id: 3, visible: false }),
    stroke({ id: 4, d: linePath(0, 0, 5, 5), dash: 'dash' }),
    stroke({ id: 5, blur: 4 }),
    stroke({ id: 6, dx: 10, dy: 5 })
  ])
  check('a filled shape fills', svg.includes('fill="#ff0000"') && !svg.includes('stroke="none" stroke="none"'), svg)
  check('text becomes a text element with escaped content', svg.includes('<text') && svg.includes('hi &lt;there&gt;'), svg)
  check('hidden strokes leave the export', (svg.match(/<path /g) ?? []).length === 4, svg)
  check('dashes are written', svg.includes('stroke-dasharray="18.00 9.00"'), svg)
  check('blur gets a filter def and a reference', svg.includes('<filter id="soft4"') && svg.includes('filter="url(#soft4)"'), svg)
  check('a move becomes a translate', svg.includes('transform="translate(10.00 5.00)"'), svg)
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (fail > 0) {
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}