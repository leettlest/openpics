/**
 * Tests for the shared path helpers.
 *
 * Three copies of these grew up apart and disagreed about drive roots, so the
 * edge cases below are the contract: any future fix lands here once and holds
 * for the store, the context menu and the AI core together.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIST = new URL('../dist-test/', import.meta.url)
if (!existsSync(fileURLToPath(new URL('../dist-test/shared/paths.js', import.meta.url)))) {
  console.error('the test build is missing: dist-test/shared/paths.js\nrun "npm run build:test" first, or use "npm test".')
  process.exit(1)
}

const { basenameOf, parentDir } = await import(new URL('shared/paths.js', DIST).href)

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

section('basenameOf takes the last segment, either separator')

check('a backslash path', basenameOf('C:\\Pictures\\beach.jpg') === 'beach.jpg')
check('a forward slash path', basenameOf('C:/Pictures/beach.jpg') === 'beach.jpg')
check('a bare name has no parent to take', basenameOf('beach.jpg') === 'beach.jpg')
check('an empty string stays empty', basenameOf('') === '')

section('parentDir keeps drive roots whole')

check('a file gives its folder', parentDir('C:\\Pictures\\beach.jpg') === 'C:\\Pictures')
check('a folder gives its parent', parentDir('C:\\Pictures\\Trips') === 'C:\\Pictures')
check('a trailing separator is not a name', parentDir('C:\\Pictures\\') === 'C:\\')
check('a bare drive root is left as the drive', parentDir('C:\\') === 'C:')
check('a file directly on a drive gives the root', parentDir('C:\\beach.jpg') === 'C:\\')
check('a bare name has nowhere to go', parentDir('beach.jpg') === 'beach.jpg')
check('forward slashes work too', parentDir('C:/Pictures/beach.jpg') === 'C:/Pictures')

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(' - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
