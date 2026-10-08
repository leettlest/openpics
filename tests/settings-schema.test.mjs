/**
 * Tests for settings sanitising, specifically the tag record.
 *
 * Tags enter the system lowercased everywhere - model output, manual adds - so
 * a hand-edited settings file holding "Sunset" must come out as "sunset".
 * Anything else makes the same tag match in one place and miss in another, and
 * the user gets to wonder why their filter finds nothing.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIST = new URL('../dist-test/', import.meta.url)
for (const file of ['shared/settings-schema.js', 'shared/protocol.js']) {
  if (!existsSync(fileURLToPath(new URL(`../dist-test/${file}`, import.meta.url)))) {
    console.error(`the test build is missing: dist-test/${file}\nrun "npm run build:test" first, or use "npm test".`)
    process.exit(1)
  }
}

const { sanitizeSettings } = await import(new URL('shared/settings-schema.js', DIST).href)
const { DEFAULT_SETTINGS } = await import(new URL('shared/protocol.js', DIST).href)

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

const tagsOf = (aiTags) => sanitizeSettings({ aiTags }, DEFAULT_SETTINGS).aiTags

section('a tag record survives loading only in the shape the app reads')

check('mixed case comes out lowercased', JSON.stringify(tagsOf({ 'a.jpg': ['Sunset', 'BEACH'] })) === JSON.stringify({ 'a.jpg': ['sunset', 'beach'] }))
check('inner whitespace collapses', JSON.stringify(tagsOf({ 'a.jpg': ['golden  retriever'] })) === JSON.stringify({ 'a.jpg': ['golden retriever'] }))
check('blank entries are dropped', JSON.stringify(tagsOf({ 'a.jpg': ['  ', 'x'] })) === JSON.stringify({ 'a.jpg': ['x'] }))
check('duplicates collapse after casing', JSON.stringify(tagsOf({ 'a.jpg': ['Sunset', 'sunset'] })) === JSON.stringify({ 'a.jpg': ['sunset'] }))
check('a non-array is not a tag list', JSON.stringify(tagsOf({ 'a.jpg': 'sunset' })) === JSON.stringify({}))
check('an empty record stays empty', JSON.stringify(tagsOf({})) === JSON.stringify({}))
check('other settings pass through untouched', sanitizeSettings({ rowHeight: 200 }, DEFAULT_SETTINGS).rowHeight === 200)

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(' - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
