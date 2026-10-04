/**
 * Tests for the vision request shape.
 *
 * The runtime hands llama-server JSON in the OpenAI chat format, and the only
 * part of that this project authors itself is how a photo becomes an
 * `image_url` part. Getting it wrong fails late and confusingly - llama-server
 * answers with an HTTP error that looks like a model problem - so the shape is
 * pinned here, where a mistake is a red line rather than a mystery.
 *
 * The encoder that produces the `data:` URLs lives in the Electron main process
 * and needs nativeImage, so it is not exercised here. What is tested is the
 * contract around it: our URLs are recognisable, the text comes first, and every
 * image gets exactly one part.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIST = new URL('../dist-test/', import.meta.url)
if (!existsSync(fileURLToPath(new URL('../dist-test/shared/ai-vision.js', import.meta.url)))) {
  console.error('the test build is missing: dist-test/shared/ai-vision.js\nrun "npm run build:test" first, or use "npm test".')
  process.exit(1)
}

const { buildVisionMessage, isInlineImage, MAX_VISION_IMAGES } = await import(
  new URL('shared/ai-vision.js', DIST).href
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

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

section('the OpenAI content-part shape')

{
  const parts = buildVisionMessage('what is this?', [JPEG])
  check('one text part plus one image part', parts.length === 2, `got ${parts.length}`)
  check('the text part is first', parts[0].type === 'text' && parts[0].text === 'what is this?')
  check(
    'the image part uses image_url.url',
    parts[1].type === 'image_url' && parts[1].image_url.url === JPEG
  )
  check('parts are exactly {type,text} or {type,image_url}', Object.keys(parts[1]).join(',') === 'type,image_url')
}

{
  const parts = buildVisionMessage('', [])
  check('no images leaves the text part, still first', parts.length === 1 && parts[0].type === 'text')
}

{
  const images = [JPEG, 'data:image/png;base64,iVBORw0KGgo=', 'data:image/webp;base64,UklGRg==']
  const parts = buildVisionMessage('compare', images)
  check('every image gets its own part', parts.length === images.length + 1, `got ${parts.length}`)
  const urls = parts.filter((p) => p.type === 'image_url').map((p) => p.image_url.url)
  check('image order is preserved', urls.join('|') === images.join('|'))
  check('the concatenated text is unchanged', parts[0].text === 'compare')
}

section('recognising our own inlined images')

for (const url of [
  'data:image/jpeg;base64,AAAA',
  'data:image/png;base64,AAAA',
  'data:image/webp;base64,AAAA',
  'data:image/svg+xml;base64,AAAA'
]) {
  check(`accepts ${url.slice(0, 22)}...`, isInlineImage(url) === true)
}

for (const url of [
  'http://127.0.0.1/photo.jpg',
  'file:///C:/photo.jpg',
  'C:/photo.jpg',
  'data:image/jpeg,not-base64',
  'data:text/plain;base64,AAAA',
  ''
]) {
  check(`rejects ${JSON.stringify(url)}`, isInlineImage(url) === false)
}

section('the attachment cap is a small, sane number')

check('MAX_VISION_IMAGES is a positive integer', Number.isInteger(MAX_VISION_IMAGES) && MAX_VISION_IMAGES > 0)
check('MAX_VISION_IMAGES stays modest for CPU inference', MAX_VISION_IMAGES <= 8, `got ${MAX_VISION_IMAGES}`)

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(' - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
