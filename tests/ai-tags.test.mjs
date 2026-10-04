/**
 * Tests for tag parsing.
 *
 * The model answers prose, not schema, so this is the boundary where a stray
 * sentence becomes a stored tag. The rules are deliberately lossy - lowercase,
 * deduplicated, capped - and they are pinned here because a tag that sneaks
 * through with a newline or 200 characters lands in the filter bar later.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIST = new URL('../dist-test/', import.meta.url)
if (!existsSync(fileURLToPath(new URL('../dist-test/shared/ai-tags.js', import.meta.url)))) {
  console.error('the test build is missing: dist-test/shared/ai-tags.js\nrun "npm run build:test" first, or use "npm test".')
  process.exit(1)
}

const { parseTags, normalizeTags, TAG_MAX_LENGTH, TAGS_PER_PHOTO } = await import(
  new URL('shared/ai-tags.js', DIST).href
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

section('splitting and cleaning a reply')

check('comma-separated reply', parseTags('sunset, beach, ocean').join('|') === 'sunset|beach|ocean')
check('newline-separated reply', parseTags('dog\ncat\nbird').join('|') === 'dog|cat|bird')
check('mixed separators', parseTags('one, two\nthree').join('|') === 'one|two|three')
check('trims surrounding whitespace', parseTags('  sunset ,  beach  ').join('|') === 'sunset|beach')
check('lowercases', parseTags('Sunset, BEACH').join('|') === 'sunset|beach')
check('collapses internal whitespace', parseTags('golden   retriever').join('|') === 'golden retriever')
check(
  'deduplicates case-insensitively, keeping first order',
  parseTags('Sunset, sunset, SUNSET, beach').join('|') === 'sunset|beach'
)

section('dropping what a tag is not')

check('empty reply yields nothing', parseTags('').length === 0)
check('separators only yields nothing', parseTags(', ,\n,\n').length === 0)
check('whitespace-only yields nothing', parseTags('   \n  ').length === 0)

check(
  `a tag of exactly ${TAG_MAX_LENGTH} characters is kept`,
  parseTags('x'.repeat(TAG_MAX_LENGTH)).length === 1
)
check(
  `a tag longer than ${TAG_MAX_LENGTH} characters is dropped whole`,
  parseTags('x'.repeat(TAG_MAX_LENGTH + 1)).length === 0
)
check(
  'a long tag does not truncate into a tag',
  parseTags('x'.repeat(TAG_MAX_LENGTH + 1) + ', sunset').join('|') === 'sunset'
)

section('the per-photo cap')

check(`TAGS_PER_PHOTO is ${TAGS_PER_PHOTO}`, TAGS_PER_PHOTO === 5)
{
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const tags = parseTags(many.join(', '))
  check('no more than the cap are kept', tags.length === TAGS_PER_PHOTO, `got ${tags.length}`)
  check('the first ones are the ones kept', tags.join('|') === many.slice(0, TAGS_PER_PHOTO).join('|'))
}

section('normalizing a stored list')

check('applies the same lowering and de-duplication', normalizeTags(['Sunset', 'SUNSET', '  beach  ']).join('|') === 'sunset|beach')
check('an empty list stays empty', normalizeTags([]).length === 0)
check('drops over-long entries', normalizeTags(['x'.repeat(TAG_MAX_LENGTH + 1), 'ok']).join('|') === 'ok')
check(
  'caps an over-long list too',
  normalizeTags(['a', 'b', 'c', 'd', 'e', 'f']).length === TAGS_PER_PHOTO
)

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(' - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
