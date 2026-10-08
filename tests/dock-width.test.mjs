/**
 * Tests for the dock's width rules.
 *
 * The dock and the grid share one window, so every one of these is really a test
 * that the dock loses the argument when it should. The case that matters most is
 * the narrow one, because that is the only place where the dock's minimum width
 * and its share of the window disagree, and which one is applied last decides
 * whether the user gets a panel or a leftover.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIST = new URL('../dist-test/', import.meta.url)
if (!existsSync(fileURLToPath(new URL('../dist-test/shared/dock-width.js', import.meta.url)))) {
  console.error('the test build is missing: dist-test/shared/dock-width.js\nrun "npm run build:test" first, or use "npm test".')
  process.exit(1)
}

const { clampDockWidth, dragDockWidth, DOCK_MIN_WIDTH, DOCK_MAX_WIDTH, DOCK_MAX_SHARE } = await import(
  new URL('shared/dock-width.js', DIST).href
)

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

const WIDE = 1600
const NARROW = 360

section('the constants say what they mean')

check('the share is most of the window, not all of it', DOCK_MAX_SHARE > 0.4 && DOCK_MAX_SHARE < 1)
check('the minimum leaves the grid room on a normal window', DOCK_MIN_WIDTH >= 200)
check('the maximum is a panel, not a second app', DOCK_MAX_WIDTH <= 800)

section('a stored width is honoured within the rules')

check('a 400px preference renders as 400', clampDockWidth(400, WIDE) === 400)
check('on a 1600px window the share allows more than 720', Math.round(WIDE * DOCK_MAX_SHARE) === 960)
check('but 720 is still the ceiling', clampDockWidth(1100, WIDE) === 720)
check('and a silly narrow preference is raised to the floor', clampDockWidth(80, WIDE) === 240)
check('a negative width is not taken literally', clampDockWidth(-50, WIDE) === 240)
check('a fractional width is rounded, not ignored', clampDockWidth(399.6, WIDE) === 400)

section('a narrow window wins over the floor')

{
  // This is the bug the function exists for. 240 is two thirds of 360, so a dock
  // that insists on its minimum leaves the grid a 120px sliver on the narrowest
  // window anyone actually snaps a window to.
  const at = clampDockWidth(DOCK_MIN_WIDTH, NARROW)
  check('the dock gets less than its minimum rather than more than its share', at < DOCK_MIN_WIDTH, `got ${at}`)
  check('and it is still exactly the share', at === Math.round(NARROW * DOCK_MAX_SHARE), `got ${at}`)
  check('which leaves the grid the rest', at + 44 <= NARROW, `dock ${at} plus rail`)
  // The same window, a preference far wider than the share: the share still wins.
  check('and a wide preference is capped just as hard', clampDockWidth(720, NARROW) === Math.round(NARROW * DOCK_MAX_SHARE))
}

section('the window can be dragged back and forth without losing the preference')

{
  // The stored value is never rewritten by a resize, so widening the window
  // restores what the user asked for. That only works if the clamp is a render
  // concern rather than something baked into the stored number.
  const stored = 500
  const narrow = clampDockWidth(stored, NARROW)
  check('narrow caps it', narrow < stored)
  check('wide restores it exactly', clampDockWidth(stored, WIDE) === stored)
  // A stored 500 on a huge window stays 500: the preference is not a floor the
  // dock grows to meet. Only a preference past the ceiling comes back down.
  check('and a huge window does not make the dock grow to the ceiling', clampDockWidth(stored, 4000) === 500)
  check('though a preference past the ceiling still comes down', clampDockWidth(1100, 4000) === DOCK_MAX_WIDTH)
}

section('a drag moves the width, in the direction the pointer went')

{
  const start = 400
  check('dragging the left edge right narrows', dragDockWidth(start, 500, 560, WIDE) === 340)
  check('dragging it left widens', dragDockWidth(start, 500, 420, WIDE) === 480)
  check('not moving it leaves it alone', dragDockWidth(start, 500, 500, WIDE) === start)
  check('a drag cannot make it zero', dragDockWidth(start, 500, 900, WIDE) === DOCK_MIN_WIDTH)
  check('a drag cannot make it enormous', dragDockWidth(start, 500, 0, WIDE) === DOCK_MAX_WIDTH)
}

section('a drag obeys the same limits as the window')

{
  // Starting on a capped window: the drag continues from what is on screen, so
  // the first pixel of movement does not snap the dock wider than the user can
  // see. Widening is simply refused there, because the window has no more to give.
  const onScreen = clampDockWidth(500, NARROW)
  check('widening past the share does nothing', dragDockWidth(onScreen, 300, 296, NARROW) === onScreen)
  check('and neither does narrowing, because the floor is above the share there', dragDockWidth(onScreen, 300, 304, NARROW) === onScreen)
  check('a drag on a narrow window cannot push past the share', dragDockWidth(200, 300, 100, NARROW) === Math.round(NARROW * DOCK_MAX_SHARE))
  // On a window too narrow for the floor, the share is cap and floor together, so
  // the width is pinned. The dock is escapable because it collapses to the rail,
  // which is a button rather than a drag that would snap back.
  check('a sub-minimum window pins the width instead of snapping it back', dragDockWidth(200, 300, 700, NARROW) === Math.round(NARROW * DOCK_MAX_SHARE))
  check('so every drag on that window lands in the same place', dragDockWidth(216, 300, 0, NARROW) === dragDockWidth(216, 300, 900, NARROW))
}

section('a window width nobody reported is treated as unusable rather than huge')

check('zero', clampDockWidth(400, 0) === 0)
check('negative', clampDockWidth(400, -200) === 0)
check('not a number', clampDockWidth(400, Number.NaN) === 0)
check('a broken preference falls back to the floor', clampDockWidth(Number.NaN, WIDE) === DOCK_MIN_WIDTH)

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(' - ' + f)
}
process.exit(fail === 0 ? 0 : 1)