#!/usr/bin/env node
/**
 * Fetches the multimodal weights OpenPics uses to *see* photos.
 *
 * Run by `npm run vision`, and automatically before `npm run package`. Two files
 * are needed, which is why this is separate from fetch-model.mjs: llama.cpp
 * loads a vision model plus a matching `mmproj` (multimodal projector) that
 * turns an image into tokens the language model can read. Together they are
 * about 520 MB.
 *
 * The text model and this one are deliberately separate. Most of what the dock
 * does - "group these by subject", "tag the selected files" - is text-only and
 * runs on the smaller Qwen model. Only when the user attaches photos does the
 * runtime switch to SmolVLM, so a plain question does not pay to load a vision
 * stack it will not use.
 *
 * As with the other fetchers, the URL and SHA-256 are constants in this file, so
 * updating the model is one reviewable commit rather than a build step that
 * downloads whatever it is handed. `resolve/<commit>/<file>` pins a commit, not
 * `main`, so the bytes behind the checksum cannot change.
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = join(ROOT, 'vendor', 'vision')

/**
 * SmolVLM-500M-Instruct, quantised to Q8_0.
 *
 * A half-billion-parameter VLM is the honest choice for a bundled vision model:
 * it runs on a laptop CPU without a GPU, describes or answers a question about a
 * photo in a few seconds, and adds roughly half a gigabyte to the installer.
 * Q8_0 rather than Q4 because at this size the vision encoder is sensitive to
 * quantisation and the file is small either way. Apache-2.0, matching the app.
 */
const REVISION = '72e986006ef53e37cdd3f6d4241c90b0f01df376'
const REPOSITORY = 'https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF'
const BASE = `${REPOSITORY}/resolve/${REVISION}`

const FILES = [
  {
    filename: 'SmolVLM-500M-Instruct-Q8_0.gguf',
    source: `${BASE}/SmolVLM-500M-Instruct-Q8_0.gguf`,
    sha256: '9d4612de6a42214499e301494a3ecc2be0abdd9de44e663bda63f1152fad1bf4',
    size: 436806912
  },
  {
    filename: 'mmproj-SmolVLM-500M-Instruct-Q8_0.gguf',
    source: `${BASE}/mmproj-SmolVLM-500M-Instruct-Q8_0.gguf`,
    sha256: 'd1eb8b6b23979205fdf63703ed10f788131a3f812c7b1f72e0119d5d81295150',
    size: 108783360
  }
]

const SOURCE_INFO = {
  model: 'SmolVLM-500M-Instruct',
  quantisation: 'Q8_0',
  repository: REPOSITORY,
  revision: REVISION,
  revisionUrl: `${REPOSITORY}/commit/${REVISION}`,
  licence: 'Apache-2.0',
  licenceUrl: `${REPOSITORY}/blob/main/LICENSE`
}

function log(...parts) {
  console.log('[vision]', ...parts)
}

function sha256(file) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('error', fail)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')))
  })
}

async function download(url, target) {
  log('downloading', url)

  // A few hundred megabytes over a home connection fails often enough that
  // throwing away a partial file would make packaging flaky. Resume from what is
  // on disk and retry; both are safe because the checksum is checked before the
  // file is accepted, so a bad resume fails there rather than in the loader.
  const ATTEMPTS = 4

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      let have = 0
      try {
        have = existsSync(target) ? statSync(target).size : 0
      } catch {
        have = 0
      }

      const headers = have > 0 ? { Range: `bytes=${have}-` } : {}
      const response = await fetch(url, { redirect: 'follow', headers })
      if (!response.ok || !response.body) {
        throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`)
      }

      const resumed = response.status === 206 && have > 0
      if (have > 0 && !resumed) {
        log('server ignored the resume request, starting over')
        rmSync(target, { force: true })
      }

      mkdirSync(dirname(target), { recursive: true })
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(target, resumed ? { flags: 'a' } : { flags: 'w' })
      )

      const mb = (statSync(target).size / 1024 / 1024).toFixed(1)
      log(`downloaded ${mb} MB${resumed ? ' (resumed)' : ''}`)
      return
    } catch (err) {
      const kept = existsSync(target) ? statSync(target).size : 0
      if (attempt === ATTEMPTS) throw err
      log(`attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)})`)
      log(`retrying from ${(kept / 1024 / 1024).toFixed(1)} MB`)
    }
  }
}

function stampPath() {
  return join(DEST, 'VISION-BUILD.txt')
}

function expectedStamp() {
  return FILES.map((f) => `${f.filename}\nsha256 ${f.sha256}\nsize ${f.size}`).join('\n\n')
}

function writeStamp() {
  writeFileSync(
    stampPath(),
    `${expectedStamp()}\n\n` +
      `These weights are ${SOURCE_INFO.model}, quantised to ${SOURCE_INFO.quantisation}.\n` +
      `They are distributed unmodified and are loaded by the app's local AI runtime\n` +
      `to read photos the user attaches. The mmproj file is the matching projector.\n\n` +
      `Source: ${SOURCE_INFO.repository}\n` +
      `  revision ${SOURCE_INFO.revision}\n` +
      `  ${SOURCE_INFO.revisionUrl}\n` +
      `Licence: ${SOURCE_INFO.licence}\n` +
      `  ${SOURCE_INFO.licenceUrl}\n`,
    'utf8'
  )
}

async function readStamp() {
  try {
    return await new Promise((done, fail) => {
      let text = ''
      createReadStream(stampPath(), { encoding: 'utf8' })
        .on('error', fail)
        .on('data', (chunk) => (text += chunk))
        .on('end', () => done(text.split('\n\n')[0]))
    })
  } catch {
    return null
  }
}

async function ensure(file) {
  const target = join(DEST, file.filename)
  if (statSync2(target) === 'oversized') {
    log(`${file.filename} is larger than the pin; refetching`)
    rmSync(target, { force: true })
  }
  switch (statSync2(target)) {
    case 'exact': {
      const sum = await sha256(target)
      if (sum === file.sha256) return
      log(`${file.filename} is not the pinned file; refetching`)
      rmSync(target, { force: true })
      break
    }
    case 'partial':
      log(`found a partial ${file.filename}; resuming`)
      break
    default:
      break
  }

  await download(file.source, target)

  const size = statSync(target).size
  if (size !== file.size) {
    throw new Error(`size mismatch for ${file.filename}: expected ${file.size}, got ${size}`)
  }
  const sum = await sha256(target)
  if (sum !== file.sha256) {
    throw new Error(
      `checksum mismatch for ${file.filename}\n  expected ${file.sha256}\n  got      ${sum}\n` +
        'Refusing to use this file. If the model was updated, edit REVISION, and the SHA256/SIZE ' +
        'entries in scripts/fetch-vision.mjs in one commit.'
    )
  }
}

function statSync2(file) {
  let size = 0
  try {
    size = existsSync(file) ? statSync(file).size : 0
  } catch {
    size = 0
  }
  const expected = FILES.find((f) => file.endsWith(f.filename))
  if (!expected) return 'missing'
  if (size === 0) return 'missing'
  if (size === expected.size) return 'exact'
  if (size < expected.size) return 'partial'
  return 'oversized'
}

async function main() {
  mkdirSync(DEST, { recursive: true })

  const stamp = await readStamp()
  const allExact = FILES.every((f) => statSync2(join(DEST, f.filename)) === 'exact')
  if (allExact && stamp === expectedStamp()) {
    const mb = (FILES.reduce((n, f) => n + f.size, 0) / 1024 / 1024).toFixed(1)
    log(`already present (${FILES.length} files, ${mb} MB); nothing to do`)
    return
  }

  for (const file of FILES) {
    await ensure(file)
    log('checksum verified', file.filename)
  }

  writeStamp()
  const mb = (FILES.reduce((n, f) => n + f.size, 0) / 1024 / 1024).toFixed(1)
  log(`installed ${FILES.length} files into vendor/vision (${mb} MB)`)
}

main().catch((err) => {
  console.error(`[vision] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
