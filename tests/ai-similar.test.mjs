/**
 * Tests for the perceptual hash.
 *
 * The hash is pure arithmetic, so it is pinned here rather than behind an
 * image: a known gray ramp must produce a known fingerprint, brightness must
 * cancel out, and the Hamming distance must count exactly the bits that differ.
 * The Electron side only supplies a bitmap, so everything above that line is
 * testable under plain Node.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIST = new URL('../dist-test/', import.meta.url)
if (!existsSync(fileURLToPath(new URL('../dist-test/shared/ai-similar.js', import.meta.url)))) {
  console.error('the test build is missing: dist-test/shared/ai-similar.js\nrun "npm run build:test" first, or use "npm test".')
  process.exit(1)
}

const { grayFromBgra, hashFromGray, hammingDistance, HASH_WIDTH, HASH_HEIGHT, SIMILAR_MAX_DISTANCE } = await import(
  new URL('shared/ai-similar.js', DIST).href
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
function close(a, b, eps = 0.5) {
  return Math.abs(a - b) <= eps
}
function section(title) {
  console.log(`\n-- ${title}`)
}

/** A 9x8 grid where each row is an ascending ramp, except an optional flipped one. */
function rampGrid(flipRow) {
  const gray = []
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH; x++) {
      gray.push(y === flipRow ? HASH_WIDTH - 1 - x : x)
    }
  }
  return gray
}

section('the grid is a 64-bit fingerprint')

check('one fewer column than the grid width is bits per row', HASH_WIDTH - 1 === 8)
check('rows times bits fills 64 bits', (HASH_WIDTH - 1) * HASH_HEIGHT === 64)
check('a hash is sixteen lowercase hex digits', /^[0-9a-f]{16}$/.test(hashFromGray(rampGrid(-1), HASH_WIDTH, HASH_HEIGHT)))

section('hamming distance counts differing bits')

check('identical hashes are 0 apart', hammingDistance('0000000000000000', '0000000000000000') === 0)
check('one bit differs', hammingDistance('0000000000000000', '0000000000000001') === 1)
check('four bits differ', hammingDistance('0000000000000000', '000000000000000f') === 4)
check('opposite hashes are 64 apart', hammingDistance('ffffffffffffffff', '0000000000000000') === 64)
check('distance is symmetric', hammingDistance('00ff00ff00ff00ff', 'ff00ff00ff00ff00') === hammingDistance('ff00ff00ff00ff00', '00ff00ff00ff00ff'))
check('high bits count too', hammingDistance('8000000000000000', '0000000000000000') === 1)

section('grayscale uses luminance, not one channel')

function pixels(...rgba) {
  return Uint8Array.from(rgba.flat())
}
{
  const bitmap = pixels([255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255])
  const gray = grayFromBgra(bitmap, 4, 1)
  check('blue weighs least', close(gray[0], 0.114 * 255), `got ${gray[0]}`)
  check('green weighs most', close(gray[1], 0.587 * 255), `got ${gray[1]}`)
  check('red is between', close(gray[2], 0.299 * 255), `got ${gray[2]}`)
  check('white is 255', close(gray[3], 255), `got ${gray[3]}`)
}

section('the hash ignores brightness and scale')

const ascending = rampGrid(-1)
{
  const allOn = hashFromGray(ascending, HASH_WIDTH, HASH_HEIGHT)
  check('a rising ramp sets every bit', allOn === 'ffffffffffffffff', allOn)

  const descending = ascending.map((_, i, arr) => arr[arr.length - 1 - i])
  check('a falling ramp clears every bit', hashFromGray(descending, HASH_WIDTH, HASH_HEIGHT) === '0000000000000000')

  const brighter = ascending.map((value) => value * 3)
  check('tripling brightness does not change the hash', hashFromGray(brighter, HASH_WIDTH, HASH_HEIGHT) === allOn)

  const offset = ascending.map((value) => value + 100)
  check('a brightness offset does not change the hash', hashFromGray(offset, HASH_WIDTH, HASH_HEIGHT) === allOn)
}

section('a local change moves only its own bits')

{
  const base = hashFromGray(rampGrid(-1), HASH_WIDTH, HASH_HEIGHT)
  const oneRowFlipped = hashFromGray(rampGrid(0), HASH_WIDTH, HASH_HEIGHT)
  check('flipping one row changes exactly that row of bits', hammingDistance(base, oneRowFlipped) === HASH_WIDTH - 1)
}

section('the similarity cutoff')

check('the cutoff is a positive integer', Number.isInteger(SIMILAR_MAX_DISTANCE) && SIMILAR_MAX_DISTANCE > 0)
check('the cutoff leaves most of the hash free to differ', SIMILAR_MAX_DISTANCE <= 64 / 4, `got ${SIMILAR_MAX_DISTANCE}`)
check('the cutoff would still match a one-row change', SIMILAR_MAX_DISTANCE >= HASH_WIDTH - 1)

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(' - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
