/**
 * Tests for the drawing file shared by the app and the MCP server.
 *
 * This file is the meeting point: the canvas writes it debounced, an agent
 * appends through MCP tools, and the app picks those up live. Every test here
 * runs against a fresh temp dir, so nothing touches a real profile.
 */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const DIST = new URL('../dist-test/', import.meta.url)
if (!existsSync(fileURLToPath(new URL('../dist-test/core/creatives-file.js', import.meta.url)))) {
  console.error('the test build is missing: dist-test/core/creatives-file.js\nrun "npm run build:test" first, or use "npm test".')
  process.exit(1)
}

const {
  loadDrawing,
  saveDrawing,
  addStrokes,
  undoStroke,
  deleteStroke,
  clearDrawing,
  isDrawingStroke,
  nextAgentStrokeId
} = await import(new URL('core/creatives-file.js', DIST).href)

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    failures.push(name + (detail ? ` (${detail})` : ''))
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}
function section(title) {
  console.log(`\n-- ${title}`)
}

const freshDir = () => mkdtempSync(join(tmpdir(), 'openpics-creatives-test-'))
const stroke = (over = {}) => ({
  id: 1,
  d: 'M 0 0 L 10 10',
  color: '#111827',
  width: 6,
  opacity: 100,
  tool: 'brush',
  ...over
})

section('saving and loading')

{
  const dir = freshDir()
  check('nothing saved loads as nothing', loadDrawing(dir) === null)
  check('a save reports success', saveDrawing(dir, [stroke()]) === true)
  const loaded = loadDrawing(dir)
  check('a save round-trips', loaded !== null && loaded.length === 1 && loaded[0].id === 1)
}

section('validation')

check('a real stroke validates', isDrawingStroke(stroke()) === true)
check('a text stroke needs no path data', isDrawingStroke(stroke({ kind: 'text', d: '', text: 'hi' })) === true)
check('a path stroke needs path data', isDrawingStroke(stroke({ d: '' })) === false)
check('an unknown tool is refused', isDrawingStroke(stroke({ tool: 'spraycan' })) === false)
check('an unknown kind is refused', isDrawingStroke(stroke({ kind: 'blob' })) === false)
check('a bad dash is refused', isDrawingStroke(stroke({ dash: 'zigzag' })) === false)
check('a non-number id is refused', isDrawingStroke(stroke({ id: '1' })) === false)
check('null is refused', isDrawingStroke(null) === false)
{
  const dir = freshDir()
  writeFileSync(join(dir, 'creatives.json'), 'not json{{{')
  check('a corrupt file loads as nothing', loadDrawing(dir) === null)
}
{
  const dir = freshDir()
  writeFileSync(join(dir, 'creatives.json'), JSON.stringify([stroke(), { nope: true }, stroke({ id: 2 })]))
  const loaded = loadDrawing(dir)
  check('bad entries are filtered, good ones kept', loaded !== null && loaded.length === 2 && loaded[1].id === 2)
}

section('agent edits')

{
  const dir = freshDir()
  // Negative ids are the agent's namespace; the canvas only mints positives,
  // so the two sides cannot collide no matter how they interleave.
  const after = addStrokes(dir, [stroke({ id: -1700000000000 })])
  check('an agent stroke appends', after.length === 1 && after[0].id < 0)
  const again = addStrokes(dir, [stroke({ id: 7 })])
  check('the canvas appends alongside', again.length === 2)
  const undone = undoStroke(dir)
  check('undo takes the last stroke', undone !== null && undone.id === 7)
  check('and the file agrees', (loadDrawing(dir) ?? []).length === 1)
  check('delete by id works', deleteStroke(dir, -1700000000000) === true)
  check('deleting thin air reports it', deleteStroke(dir, -1700000000000) === false)
  check('and the drawing is empty again', loadDrawing(dir) === null)
  check('undo on empty is nothing', undoStroke(dir) === null)
  saveDrawing(dir, [stroke()])
  clearDrawing(dir)
  check('clear empties', loadDrawing(dir) === null)
}

section('agent stroke ids')

{
  // The two ways this goes wrong both look fine until work is destroyed, so both
  // are pinned here against the exact shapes that break them.
  check('an empty drawing starts at -1', nextAgentStrokeId([]) === -1)

  const first = nextAgentStrokeId([])
  const second = nextAgentStrokeId([{ id: first }])
  check(
    'two consecutive calls never collide',
    second !== first,
    `both got ${first}; the second add would overwrite the first stroke`
  )

  // All ids positive: seeding the minimum at zero and subtracting once yields -1
  // here, which is already taken.
  const positives = [{ id: 3 }, { id: 9 }]
  const belowPositives = nextAgentStrokeId(positives)
  check(
    'descends below positive-only ids',
    belowPositives < 0 && !positives.some((s) => s.id === belowPositives),
    `got ${belowPositives}`
  )

  // The undo case: -1 is undone away, leaving only positives, so the old
  // implementation would hand out -1 again and land on a live stroke.
  const afterUndo = nextAgentStrokeId([{ id: -2 }, { id: 3 }])
  check(
    'descends below ids it already handed out',
    afterUndo < -2,
    `got ${afterUndo}, which is not below the live -2`
  )

  // A gap must not be reused: -5 while -3 is live is fine, -1 while -5 is live is not.
  const sparse = [{ id: -5 }, { id: -1 }]
  const belowSparse = nextAgentStrokeId(sparse)
  check(
    'takes the true minimum, not the first or last',
    belowSparse === -6,
    `got ${belowSparse}, expected -6`
  )

  check('always returns a negative id', nextAgentStrokeId([{ id: 1 }]) < 0)
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(' - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
